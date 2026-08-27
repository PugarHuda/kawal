/**
 * Turning a planned mandate into live, on-chain Altana sessions.
 *
 * `lib/mandate.ts` decides what each seat is allowed to do and refuses to
 * emit anything unscoped. This module is the part that actually grants it:
 * one session key per seat, registered in the KeyStore so a third party can
 * read the authority on-chain rather than take our word for it.
 *
 * Two deliberate choices:
 *
 *  1. Session signers are generated here and handed to `grantSession` rather
 *     than letting the SDK mint them internally. The SDK returns a `Session`
 *     whose `signer` is a live object with no way back to its private key, so
 *     a session granted that way dies with the process. Kawal has to show a
 *     user their live sessions and let them revoke one later, which means the
 *     key has to survive a restart.
 *
 *  2. `register` is left at its default (true). An unregistered session works
 *     identically on-chain but is invisible to KeyStore readers, and "you can
 *     verify this yourself" is the entire point of granting it this way.
 */

import {
  createClient,
  createPrivateKeySigner,
  signerFromPrivateKey,
  BNB,
  BNB_TESTNET,
  type Client,
  type Session,
  type Wallet,
} from "@altananetwork/sdk";
import type { Hex } from "viem";
import {
  planMandate,
  type Mandate,
  type SeatPolicy,
  type SessionPlan,
} from "./mandate.ts";
import { BSC_MAINNET, BSC_TESTNET } from "./chains.ts";
import type { CategoryId } from "./taxonomy.ts";

export const ALTANA_NETWORKS = {
  [BSC_MAINNET]: BNB,
  [BSC_TESTNET]: BNB_TESTNET,
} as const;

export function altanaNetwork(chainId: number) {
  const net = ALTANA_NETWORKS[chainId as keyof typeof ALTANA_NETWORKS];
  if (!net) throw new Error(`no Altana network configured for chain ${chainId}`);
  return net;
}

export function clientFor(chainId: number): Client {
  return createClient({ chains: [altanaNetwork(chainId)] });
}

/**
 * Block explorer link for a transaction, or null on a chain we do not know.
 *
 * Returns rather than throws because the caller is the control room. The
 * ledger is a file a human can edit, and one row naming an unfamiliar chain
 * used to throw mid-render and take the whole page down — including the
 * revoke button, which is the safety control. Losing the brakes because a row
 * looked odd is exactly backwards.
 */
export function explorerTx(chainId: number, hash: Hex): string | null {
  const net = ALTANA_NETWORKS[chainId as keyof typeof ALTANA_NETWORKS];
  return net ? `${net.explorer.replace(/\/$/, "")}/tx/${hash}` : null;
}

/** Explorer link for an address, or null on an unknown chain. */
export function explorerAddress(chainId: number, address: string): string | null {
  const net = ALTANA_NETWORKS[chainId as keyof typeof ALTANA_NETWORKS];
  return net ? `${net.explorer.replace(/\/$/, "")}/address/${address}` : null;
}

/**
 * A granted seat: the plan that authorised it plus everything needed to use
 * or revoke the session later.
 *
 * `sessionPrivateKey` is key material. It belongs in a gitignored file with
 * the same care as any other secret; it is separated out here so nothing
 * accidentally serialises the live signer object instead.
 */
export type GrantedSeat = {
  category: CategoryId;
  seat: string;
  priority: number;
  chainId: number;
  walletAddress: `0x${string}`;
  publicKey: Hex;
  sessionPrivateKey: Hex;
  expiry: number;
  explain: string;
  /** Contracts this seat may call. Mirrors the session's on-chain allowlist. */
  allowlist: `0x${string}`[];
  spendLimit: string;
  spendPeriod: string;
  grantedAt: number;
};

function allowlistOf(plan: SessionPlan): `0x${string}`[] {
  return (plan.permissions.calls ?? [])
    .map((c) => ("to" in c ? c.to : undefined))
    .filter((a): a is `0x${string}` => Boolean(a));
}

/**
 * Grants one session per seat of a mandate.
 *
 * Each grant is a separate on-chain registration, so this is deliberately
 * sequential: a partial failure should leave the seats that already have
 * authority intact and reported, not buried under a rejected Promise.all.
 */
export async function grantMandate(opts: {
  client: Client;
  wallet: Wallet;
  adminSigner: Parameters<Client["grantSession"]>[0]["signer"];
  mandate: Mandate;
  policies?: SeatPolicy[];
  onSeat?: (seat: string, stage: "granting" | "granted" | "failed", detail?: string) => void;
}): Promise<{ granted: GrantedSeat[]; sessions: Map<CategoryId, Session>; failures: string[] }> {
  const plans = planMandate(opts.mandate, opts.policies);
  const granted: GrantedSeat[] = [];
  const sessions = new Map<CategoryId, Session>();
  const failures: string[] = [];

  for (const plan of plans) {
    opts.onSeat?.(plan.seat, "granting");
    try {
      // Generated here, not by the SDK, so the key survives this process.
      const sessionSigner = createPrivateKeySigner();

      const session = await opts.client.grantSession({
        wallet: opts.wallet,
        signer: opts.adminSigner,
        chainId: opts.mandate.chainId,
        permissions: plan.permissions,
        expiry: plan.expiry,
        sessionSigner,
      });

      sessions.set(plan.category, session);
      granted.push({
        category: plan.category,
        seat: plan.seat,
        priority: plan.priority,
        chainId: opts.mandate.chainId,
        walletAddress: session.walletAddress,
        publicKey: session.publicKey,
        sessionPrivateKey: sessionSigner._privateKey,
        expiry: plan.expiry,
        explain: plan.explain,
        allowlist: allowlistOf(plan),
        // `spend?.[0].limit` guarded the array being absent but not its being
        // empty: `[]?.[0]` is undefined and `.limit` on that throws before the
        // `?? 0n` is ever reached. planMandate always emits one entry, so this
        // never fired — which is exactly how it would have survived to the
        // first policy that did not.
        spendLimit: (plan.permissions.spend?.[0]?.limit ?? 0n).toString(),
        spendPeriod: plan.permissions.spend?.[0]?.period ?? "day",
        grantedAt: Math.floor(Date.now() / 1000),
      });
      opts.onSeat?.(plan.seat, "granted", session.publicKey);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      failures.push(`${plan.seat}: ${detail}`);
      opts.onSeat?.(plan.seat, "failed", detail);
    }
  }

  return { granted, sessions, failures };
}

/**
 * Rebuilds a usable `Session` from a persisted seat.
 *
 * The permissions are re-stated from what was granted. They are not the
 * source of truth — the account contract enforces its own copy — but the
 * session object needs them to be well-formed.
 */
export function sessionFromSeat(seat: GrantedSeat): Session {
  return {
    walletAddress: seat.walletAddress,
    signer: signerFromPrivateKey(seat.sessionPrivateKey),
    publicKey: seat.publicKey,
    permissions: {
      calls: seat.allowlist.map((to) => ({ to })),
      spend: [
        {
          limit: BigInt(seat.spendLimit),
          period: seat.spendPeriod as "day",
        },
      ],
    },
    expiry: seat.expiry,
  };
}
