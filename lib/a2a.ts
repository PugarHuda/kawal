/**
 * Speaking A2A, so that 46 of 114 listed agents stop being invisible.
 *
 * Kawal's prober spoke MCP and nothing else. Measured across the catalogue
 * that is 5 MCP-only agents it could verify against 46 A2A-only agents it
 * said nothing about — and the A2A ones are the ERC-8183 sellers, which is to
 * say the part of BSC where hiring actually happens. A marketplace that can
 * verify the minority protocol and shrugs at the majority is verifying the
 * wrong thing.
 *
 * A2A (Agent2Agent, Linux Foundation, v0.3) publishes an *agent card* — a
 * JSON document at `/.well-known/agent-card.json` naming the agent, its
 * skills and the JSON-RPC URL it is spoken to at. Every card read here was
 * fetched live from a BSC registration before this was written; the shapes
 * below are those, not the specification's examples.
 *
 * Two calls, both side-effect free:
 *
 *   GET  the card                 proves the agent describes itself
 *   POST tasks/get {id: nonsense} proves a JSON-RPC server is listening
 *
 * `tasks/get` for an id that does not exist is the one A2A method with no
 * effect: the specification says it answers TaskNotFound. Servers that do
 * not implement it answer MethodNotFound, which is just as good — the point
 * is a JSON-RPC envelope came back. What is never sent is `message/send`,
 * because that starts work on somebody else's server, and Kawal's rule about
 * not running strangers' tools uninvited applies to skills exactly as it does
 * to tools.
 */

import { recoverPublicKey, sha256, toHex } from "viem";
import { guardedFetch, readCapped, BlockedUrlError } from "./ssrf.ts";

/** A card is a short document. Anything approaching a megabyte is not one. */
const CARD_BYTES = 256_000;
const RPC_BYTES = 64_000;

/* ------------------------------------------------- signed cards ---
 *
 * A2A 0.3 lets a card carry `signatures`: detached JWS (RFC 7515) over the
 * card itself, so a client can tell a card the agent published from one
 * somebody put in front of it. The payload is the card without `signatures`,
 * canonicalised with RFC 8785 (JCS) so two servers serialising the same card
 * differently still sign the same bytes.
 *
 * Kawal signs its own card with the admin account — the key that owns the
 * mandate wallet, so the card and the money answer to the same identity —
 * and checks every card it reads. Surveyed on the day this was written:
 * fifty A2A cards off BSC by score, none carried `signatures`. The field
 * below is therefore "unsigned" for the whole catalogue today; it exists so
 * that the first signed one is noticed rather than read like the rest.
 *
 * Two algorithms are checked. ES256K (secp256k1, RFC 8812) is what an EVM
 * key produces and is what Kawal uses; WebCrypto has no secp256k1, so the
 * check recovers the public key with viem and compares it to the JWK.
 * ES256 (P-256) is what the rest of the JOSE world uses and WebCrypto does
 * have. Anything else is reported as unsupported, not invalid: not checked
 * is a different fact from checked and wrong.
 */

/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * Small on purpose. Keys sort by UTF-16 code unit, which is what a plain
 * `sort()` on strings does; numbers and strings serialise exactly as ES
 * `JSON.stringify` does, which the RFC defines as the reference; `undefined`
 * members are dropped as JSON has no such value. Non-finite numbers throw,
 * since JSON cannot carry them either.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`JCS cannot represent ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
      .join(",")}}`;
  }
  throw new TypeError(`JCS cannot represent a ${typeof value}`);
}

export function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new TypeError("not base64url");
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export const utf8 = (s: string) => new TextEncoder().encode(s);

/** The JWS payload for a card: everything but `signatures`, canonicalised. */
export function cardPayload(card: Record<string, unknown>): string {
  const unsigned = { ...card };
  delete unsigned.signatures;
  return b64url(utf8(canonicalize(unsigned)));
}

export type CardSignatureVerdict = "valid" | "invalid" | "unsigned" | "unsupported";

type Jwk = { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown };

async function verifyOne(entry: unknown, payload: string): Promise<CardSignatureVerdict> {
  if (typeof entry !== "object" || entry === null) return "invalid";
  const { protected: prot, signature, header } = entry as Record<string, unknown>;
  if (typeof prot !== "string" || typeof signature !== "string") return "invalid";

  let h: Record<string, unknown>;
  let sig: Uint8Array;
  try {
    h = JSON.parse(new TextDecoder().decode(fromB64url(prot))) as Record<string, unknown>;
    sig = fromB64url(signature);
  } catch {
    return "invalid";
  }
  // The key travels in the protected header by preference, since that is
  // what the signature covers; the unprotected header is accepted as the
  // specification allows.
  const jwk = (h.jwk ?? (typeof header === "object" && header !== null ? (header as { jwk?: unknown }).jwk : undefined)) as Jwk | undefined;
  const supported = h.alg === "ES256K" || h.alg === "ES256";
  if (!supported) return "unsupported";
  // A supported algorithm with no key to check against cannot be checked.
  if (!jwk || jwk.kty !== "EC" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return "unsupported";
  // Both algorithms sign with raw r||s over SHA-256: 64 bytes, nothing else.
  if (sig.length !== 64) return "invalid";

  const input = utf8(`${prot}.${payload}`);

  if (h.alg === "ES256K") {
    if (jwk.crv !== "secp256k1") return "unsupported";
    let expected: string;
    try {
      const x = fromB64url(jwk.x);
      const y = fromB64url(jwk.y);
      if (x.length !== 32 || y.length !== 32) return "invalid";
      expected = `0x04${toHex(x).slice(2)}${toHex(y).slice(2)}`;
    } catch {
      return "invalid";
    }
    const hash = sha256(input);
    // JWS carries no recovery id, so both are tried; a wrong one recovers a
    // different key or throws, and neither matches.
    for (const v of ["1b", "1c"]) {
      try {
        const recovered = await recoverPublicKey({ hash, signature: `${toHex(sig)}${v}` });
        if (recovered.toLowerCase() === expected.toLowerCase()) return "valid";
      } catch {
        /* not recoverable with this v */
      }
    }
    return "invalid";
  }

  if (jwk.crv !== "P-256") return "unsupported";
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    // Fresh copies: WebCrypto wants a view over an ArrayBuffer proper, and
    // TypeScript cannot see that these were never shared.
    return (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(sig), new Uint8Array(input))) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

/**
 * Checks a card's `signatures`, as parsed off the wire.
 *
 * One valid signature makes the card valid. Failing that, one that was
 * checked and failed makes it invalid — a card carrying a bad signature is
 * worse than one carrying none. Only when nothing could be checked at all is
 * the answer unsupported.
 */
export async function verifyCardSignature(body: unknown): Promise<CardSignatureVerdict> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "unsigned";
  const card = body as Record<string, unknown>;
  if (!Array.isArray(card.signatures) || card.signatures.length === 0) return "unsigned";

  const payload = cardPayload(card);
  let verdict: CardSignatureVerdict = "unsupported";
  for (const entry of card.signatures) {
    const one = await verifyOne(entry, payload);
    if (one === "valid") return "valid";
    if (one === "invalid") verdict = "invalid";
  }
  return verdict;
}

export type AgentCardSkill = {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
};

export type AgentCard = {
  name: string;
  description: string | null;
  /** The JSON-RPC endpoint the card says to speak to. */
  url: string | null;
  version: string | null;
  protocolVersion: string | null;
  preferredTransport: string | null;
  /** Declared in the card's capabilities block, when it is. */
  declaresX402: boolean;
  /**
   * The two A2A capabilities a buyer's client has to match. Null when the
   * card does not say — the specification makes both optional and half the
   * cards read off BSC omit the block entirely.
   */
  streaming: boolean | null;
  pushNotifications: boolean | null;
  skills: AgentCardSkill[];
  provider: string | null;
};

/**
 * Reads a card out of a parsed body, or null if it is not one.
 *
 * Strict on the two fields that make it a card — a name and a skills array —
 * and lenient on everything else, because the cards in the wild disagree on
 * optional fields and refusing a real agent over a missing `version` would
 * be the prober under-claiming again.
 *
 * Exported so the offline suite can drive it with the shapes read off live
 * registrations.
 */
export function readAgentCard(body: unknown): AgentCard | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || b.name.trim() === "") return null;
  if (!Array.isArray(b.skills)) return null;

  const skills = b.skills
    .map((raw): AgentCardSkill | null => {
      if (typeof raw !== "object" || raw === null) return null;
      const s = raw as Record<string, unknown>;
      const id = typeof s.id === "string" ? s.id : typeof s.name === "string" ? s.name : null;
      if (!id) return null;
      return {
        id,
        name: typeof s.name === "string" ? s.name : id,
        description: typeof s.description === "string" ? s.description : null,
        tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === "string") : [],
      };
    })
    .filter((s): s is AgentCardSkill => s !== null);

  const caps = (typeof b.capabilities === "object" && b.capabilities !== null ? b.capabilities : {}) as Record<string, unknown>;
  const provider = (typeof b.provider === "object" && b.provider !== null ? b.provider : {}) as Record<string, unknown>;

  return {
    name: b.name,
    description: typeof b.description === "string" ? b.description : null,
    url: typeof b.url === "string" && /^https?:\/\//i.test(b.url) ? b.url : null,
    version: typeof b.version === "string" ? b.version : null,
    protocolVersion: typeof b.protocolVersion === "string" ? b.protocolVersion : null,
    preferredTransport: typeof b.preferredTransport === "string" ? b.preferredTransport : null,
    declaresX402: caps.x402 === true,
    streaming: typeof caps.streaming === "boolean" ? caps.streaming : null,
    pushNotifications: typeof caps.pushNotifications === "boolean" ? caps.pushNotifications : null,
    skills,
    provider: typeof provider.organization === "string" ? provider.organization : null,
  };
}

/** What the JSON-RPC endpoint did when asked a harmless question. */
export type RpcOutcome =
  /** Answered with a JSON-RPC envelope. A server is listening. */
  | "answered"
  /** 401 or 403: a server is there and wants credentials Kawal does not hold. */
  | "gated"
  /** Answered, but not with JSON-RPC. Something else lives at that URL. */
  | "not-json-rpc"
  /** Connection failed, timed out, or 5xx. */
  | "silent"
  /** There was no URL to try. */
  | "not-tried";

export type A2aProbe = {
  endpoint: string;
  card: AgentCard | null;
  /** Where the harmless call went, if anywhere. */
  rpcUrl: string | null;
  rpc: RpcOutcome;
  /** HTTP status of the JSON-RPC call, 0 when it never connected. */
  rpcStatus: number;
  /** Round trip for the card fetch. */
  latencyMs: number;
  error: string | null;
  /**
   * Whether `agent/getAuthenticatedExtendedCard` came back as JSON-RPC — a
   * card, or the error the spec prescribes for a server that has none. Null
   * when the server never answered the first question, so the second was not
   * asked. A server that implements the v0.3 method set answers either way;
   * one that 500s on a method name it does not know is the finding.
   *
   * Optional so the fixtures built before it existed still type: absent
   * reads as null, not asked.
   */
  extendedCard?: boolean | null;
  /**
   * Whether the card's `signatures` check out against the key they carry.
   * Null when there was no card to check.
   */
  signature?: CardSignatureVerdict | null;
};

/**
 * One A2A call with no effect, asked of a URL.
 *
 * Any JSON-RPC envelope counts — an error is as good as a result here, since
 * the question was never meant to be answered, only to be recognised.
 */
async function askHarmlessly(
  url: string,
  timeoutMs: number,
  method = "tasks/get",
  params: Record<string, unknown> = { id: "kawal-liveness-probe" },
): Promise<{ rpc: RpcOutcome; status: number }> {
  try {
    const res = await guardedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "kawal", method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 401 || res.status === 403) return { rpc: "gated", status: res.status };
    if (res.status >= 500) return { rpc: "silent", status: res.status };

    try {
      const body = JSON.parse(await readCapped(res, RPC_BYTES)) as Record<string, unknown>;
      const envelope = body.jsonrpc === "2.0" && ("result" in body || "error" in body);
      return { rpc: envelope ? "answered" : "not-json-rpc", status: res.status };
    } catch {
      return { rpc: "not-json-rpc", status: res.status };
    }
  } catch {
    return { rpc: "silent", status: 0 };
  }
}

/**
 * Probes one A2A endpoint as the registry declared it.
 *
 * The declared endpoint is usually the card, and sometimes the JSON-RPC URL
 * itself — one BSC registration points straight at `/a2a`, which answers GET
 * with prose and POST with JSON-RPC. Both are handled: if what comes back is
 * not a card, the same URL is asked the harmless question directly.
 */
export async function probeA2a(endpoint: string, opts: { timeoutMs?: number } = {}): Promise<A2aProbe> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const base: A2aProbe = {
    endpoint,
    card: null,
    rpcUrl: null,
    rpc: "not-tried",
    rpcStatus: 0,
    latencyMs: 0,
    error: null,
    extendedCard: null,
    signature: null,
  };

  const started = performance.now();
  let card: AgentCard | null = null;
  let cardStatus = 0;
  let signature: CardSignatureVerdict | null = null;

  try {
    const res = await guardedFetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    cardStatus = res.status;
    if (res.ok) {
      try {
        const body: unknown = JSON.parse(await readCapped(res, CARD_BYTES));
        card = readAgentCard(body);
        if (card) signature = await verifyCardSignature(body);
      } catch {
        card = null;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      latencyMs: Math.round(performance.now() - started),
      error: e instanceof BlockedUrlError ? `blocked: ${message}` : message,
    };
  }
  const latencyMs = Math.round(performance.now() - started);

  // The card names the server; failing that, the declared URL is the server.
  const rpcUrl = card?.url ?? endpoint;
  const asked = await askHarmlessly(rpcUrl, timeoutMs);

  // Only of a server that has already shown it speaks JSON-RPC: asking a
  // silent or gated one a second question learns nothing and costs a second
  // timeout. The extended card is read-only by definition — it is the public
  // card plus whatever the server shows an authenticated caller, and Kawal
  // is not one, so the prescribed answer is an error envelope.
  const extendedCard =
    asked.rpc === "answered"
      ? (await askHarmlessly(rpcUrl, timeoutMs, "agent/getAuthenticatedExtendedCard", {})).rpc === "answered"
      : null;

  let error: string | null = null;
  if (!card && asked.rpc !== "answered") {
    error =
      cardStatus === 0
        ? "no response"
        : cardStatus >= 400
          ? `HTTP ${cardStatus}`
          : "answered, but not with an agent card or a JSON-RPC envelope";
  } else if (card && asked.rpc === "silent") {
    // A card can be a static file on a CDN in front of a dead server. The card
    // alone is a description, not a heartbeat.
    error = `agent card served, but its JSON-RPC endpoint did not answer${asked.status ? ` (HTTP ${asked.status})` : ""}`;
  }

  return {
    endpoint,
    card,
    rpcUrl,
    rpc: asked.rpc,
    rpcStatus: asked.status,
    latencyMs,
    error,
    extendedCard,
    signature,
  };
}

/**
 * Whether the probe counts as the agent answering.
 *
 * A card plus a server that either answered or asked for credentials; or, with
 * no card, a server that answered JSON-RPC directly. A card over a silent
 * server is not an answer, and neither is a server that answered something
 * other than JSON-RPC.
 */
export function a2aAnswered(p: A2aProbe): boolean {
  if (p.card) return p.rpc === "answered" || p.rpc === "gated";
  return p.rpc === "answered";
}

/** One line on what the JSON-RPC side did, for a page. */
export function rpcOutcomeLabel(o: RpcOutcome): string {
  switch (o) {
    case "answered":
      return "JSON-RPC endpoint answered";
    case "gated":
      return "JSON-RPC endpoint requires credentials";
    case "not-json-rpc":
      return "URL answered, but not with JSON-RPC";
    case "silent":
      return "JSON-RPC endpoint did not answer";
    case "not-tried":
      return "no JSON-RPC endpoint to try";
  }
}
