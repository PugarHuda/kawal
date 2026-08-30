/**
 * 8004scan as a logged-in user: Kawal's own wallet, signing in.
 *
 * Everything in scan.ts reads anonymously, and most of the registry can be
 * read that way. Three things cannot: pinning evidence to IPFS, asking for
 * an agent's health check, and anything that names the caller. The login is
 * a wallet signature — `POST /auth/nonce` hands back a message, the wallet
 * signs it with EIP-191 `personal_sign`, `POST /auth/login` trades the
 * signature for a JWT. No password, no email, no gas.
 *
 * The message is not EIP-4361. The API document promises a "message to be
 * signed" and the live server sends a seven-line greeting with the wallet,
 * the nonce and a timestamp in it; SIWE's `URI:` / `Version:` / `Chain ID:`
 * lines are absent. `loginMessage` reproduces that shape exactly, and
 * `signable` refuses to sign anything else. The refusal is the point of
 * having a builder at all: the admin key is being asked to sign text a
 * remote server chose, and a server — or whoever is answering as it — that
 * could get an arbitrary string signed would hold a signing oracle for the
 * wallet. It gets its own greeting signed, naming its own nonce, or nothing.
 *
 * The token is kept in memory for its stated lifetime and refreshed through
 * `/auth/refresh`, which rotates both tokens. A process without the admin
 * key cannot log in; that is `MissingAdminKeyError` from the vault, and
 * callers that can do without (the sweep) treat it as an outcome.
 */

import { privateKeyToAccount } from "viem/accounts";
import { adminKey, MissingAdminKeyError } from "./vault.ts";
import { REGISTRY_TIMEOUT_MS, ScanError } from "./scan.ts";

const ORIGIN = process.env.SCAN_API_ORIGIN ?? "https://8004scan.io";
const API = `${ORIGIN}/api/v1`;

/**
 * The exact text the server asks a wallet to sign, read off a live nonce
 * response. The wallet is lowercased because the server lowercases it, and a
 * signature over a differently-cased address is a signature over different
 * bytes. `timestamp` is carried verbatim: it is the server's Python
 * `isoformat()` and reformatting it would change the bytes as well.
 */
export function loginMessage(wallet: string, nonce: string, timestamp: string): string {
  return (
    "Welcome to 8004scan!\n\n" +
    "Sign this message to authenticate your wallet.\n\n" +
    `Wallet: ${wallet.toLowerCase()}\n` +
    `Nonce: ${nonce}\n` +
    `Timestamp: ${timestamp}\n\n` +
    "This signature will not trigger any blockchain transaction or cost any gas fees."
  );
}

/**
 * Whether a message the server sent is one Kawal will put its key to: byte
 * for byte the greeting above, naming this wallet and this nonce. Pure, so
 * the offline check can hold it against the live shape.
 */
export function signable(message: string, wallet: string, nonce: string): boolean {
  const timestamp = message.match(/^Timestamp: (\S+)$/m)?.[1];
  return timestamp !== undefined && message === loginMessage(wallet, nonce, timestamp);
}

type Session = {
  accessToken: string;
  refreshToken: string;
  /** Unix ms. */
  expiresAt: number;
  wallet: string;
};

/** Refresh this long before the access token lapses, so a request in flight is not the one that finds out. */
const REFRESH_MARGIN_MS = 60_000;

let session: Session | null = null;
/** Singleflight: four sweep workers must not perform four logins. */
let inflight: Promise<Session> | null = null;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new ScanError(res.status, path);
  return (await res.json()) as T;
}

type TokenPair = { access_token: string; refresh_token: string; expires_in: number };

function remember(t: TokenPair, wallet: string): Session {
  session = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    wallet,
  };
  return session;
}

async function login(): Promise<Session> {
  // Throws MissingAdminKeyError on a machine without the key, before any
  // request is made: there is nothing to sign with, so nothing to ask for.
  const account = privateKeyToAccount(adminKey());
  const wallet = account.address;

  const nonce = await post<{ nonce: string; message: string }>("/auth/nonce", { wallet_address: wallet });
  if (!signable(nonce.message, wallet, nonce.nonce)) {
    throw new Error("8004scan sent a login message that is not its own greeting for this wallet; refusing to sign it");
  }
  const signature = await account.signMessage({ message: nonce.message });
  const granted = await post<TokenPair & { wallet_address: string }>("/auth/login", {
    wallet_address: wallet,
    signature,
    nonce: nonce.nonce,
  });
  return remember(granted, granted.wallet_address);
}

async function refresh(s: Session): Promise<Session> {
  const rotated = await post<TokenPair>("/auth/refresh", { refresh_token: s.refreshToken });
  return remember(rotated, s.wallet);
}

/**
 * A bearer token for Kawal's wallet, logging in on first use and refreshing
 * after that. A refresh that fails — the refresh token has its own expiry —
 * falls back to a fresh login rather than surfacing as an error, since the
 * key is still here and can simply sign again.
 */
export async function loginAsKawal(): Promise<{ token: string; wallet: string }> {
  if (session && session.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return { token: session.accessToken, wallet: session.wallet };
  }
  if (!inflight) {
    const current = session;
    inflight = (current ? refresh(current).catch(() => login()) : login()).finally(() => {
      inflight = null;
    });
  }
  const s = await inflight;
  return { token: s.accessToken, wallet: s.wallet };
}

/** Drops the memoised session. Only the offline check needs this. */
export function forgetSession() {
  session = null;
}

/**
 * A request under Kawal's token. A 401 is answered once by logging in again
 * and retrying — a token revoked server-side looks exactly like an expired
 * one from here — and a second 401 is returned as-is.
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string) =>
    fetch(API + path, {
      ...init,
      headers: { accept: "application/json", ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  const first = await send((await loginAsKawal()).token);
  if (first.status !== 401) return first;
  session = null;
  return send((await loginAsKawal()).token);
}

/** `GET /auth/me`: what the registry knows about the wallet that just signed in. */
export async function whoAmI(): Promise<{ id: string; primary_wallet: string; total_feedbacks: number; created_at: string }> {
  const res = await authedFetch("/auth/me");
  if (!res.ok) throw new ScanError(res.status, "/auth/me");
  return (await res.json()) as { id: string; primary_wallet: string; total_feedbacks: number; created_at: string };
}

export type PinnedEvidence = {
  cid: string;
  /** `ipfs://{cid}`, as the API returns it — the form that goes into `feedbackURI`. */
  uri: string;
  gatewayUrl: string;
  /** Set by the API when the CID is a development stand-in rather than a pin. */
  note: string | null;
};

/**
 * Pins one feedback payload to IPFS through 8004scan and returns the CID.
 *
 * The payload is the compact JSON `buildFeedback` hashed. The API takes an
 * object rather than bytes and pins its own serialisation of it, so the
 * bytes on IPFS are not Kawal's — which is why the on-chain hash stays over
 * the payload and a verifier reproduces it with `JSON.stringify` of what
 * `/ipfs/fetch` returns. Twenty uploads an hour per user; a 429 is thrown
 * as a `ScanError` and the caller decides whether the data: URI will do.
 */
export async function uploadEvidence(payload: string): Promise<PinnedEvidence> {
  const content = JSON.parse(payload) as unknown;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new Error("evidence must be a JSON object; the IPFS endpoint takes nothing else");
  }
  const res = await authedFetch("/ipfs/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new ScanError(res.status, "/ipfs/upload");
  const body = (await res.json()) as { cid: string; uri: string; gateway_url: string; note?: string | null };
  return { cid: body.cid, uri: body.uri, gatewayUrl: body.gateway_url, note: body.note ?? null };
}

export type HealthCheck =
  | "queued"
  /** The daily limit or the cooldown after an accepted request. */
  | "rate-limited"
  /** No admin key on this machine, so nobody to sign in as. */
  | "no-key"
  /** The registration names another owner, so the registry would answer 403; not asked. */
  | "not-owner"
  /** The registry would not accept Kawal's token, or does not let this wallet ask about this agent. */
  | "unauthorised"
  | "refused";

/**
 * Asks 8004scan to run its own health check on an agent, alongside Kawal's.
 *
 * The API calls it owner-triggered and means it: exercised live against
 * 56:43129 it answered `403 Only the agent owner can request a health
 * check`. So when the caller knows the owner, an agent Kawal does not own is
 * filed as `not-owner` without a request — forty 403s a day would tell the
 * registry nothing and us nothing new. The daily limit and the cooldown
 * between accepted requests come back as 429. Every refusal is an outcome
 * the sweep records, not an error it stops for; none says anything about
 * the agent.
 */
export async function requestHealthCheck(chainId: number, tokenId: string, ownerAddress?: string | null): Promise<HealthCheck> {
  let res: Response;
  try {
    const { wallet } = await loginAsKawal();
    if (ownerAddress && ownerAddress.toLowerCase() !== wallet.toLowerCase()) return "not-owner";
    res = await authedFetch(`/agents/${chainId}/${tokenId}/health-check`, { method: "POST" });
  } catch (e) {
    return e instanceof MissingAdminKeyError ? "no-key" : "refused";
  }
  if (res.status === 401 || res.status === 403) return "unauthorised";
  if (res.status === 429) return "rate-limited";
  if (!res.ok) return "refused";
  const body = (await res.json().catch(() => ({}))) as { queued?: unknown };
  return body.queued === false ? "refused" : "queued";
}
