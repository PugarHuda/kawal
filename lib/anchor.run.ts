/**
 * Reading and writing KawalLedger: shared by `npm run anchor` and the cron sweep.
 *
 * Kept apart from `anchor.ts` so the pure half (leaves, trees, proofs) can be
 * imported by the offline check and by pages without dragging in a wallet.
 */

import { createWalletClient, http, type Hex, type PrivateKeyAccount } from "viem";
import { bsc } from "viem/chains";
import { publicClientFor } from "./rpc.ts";
import { probesBetween } from "./uptime.ts";
import { memo } from "./memo.ts";
import {
  LEDGER_ABI,
  LEDGER_ADDRESS,
  LEDGER_CHAIN,
  DAY_SECONDS,
  dayOf,
  summariseDay,
  probeLeaf,
  isDeployed,
  type OnChainAnchor,
  type ProbeRow,
} from "./anchor.ts";

/**
 * A day is anchored only once it has been over for an hour: a probe made at
 * 23:59:59 is written when it returns, and the root must not be cut before
 * the last row of the day has landed.
 */
export const SETTLE_SECONDS = 3_600;

export async function readAnchor(day: number): Promise<OnChainAnchor | null> {
  if (!isDeployed()) return null;
  const [root, probes, endpoints, answered, anchoredAt, blockNumber] = await publicClientFor(LEDGER_CHAIN).readContract({
    address: LEDGER_ADDRESS,
    abi: LEDGER_ABI,
    functionName: "anchors",
    args: [day],
  });
  if (/^0x0+$/.test(root)) return null;
  return {
    day,
    root,
    probes,
    endpoints,
    answered,
    anchoredAt: Number(anchoredAt),
    blockNumber: Number(blockNumber),
  };
}

/** Several days' anchors in one multicall; a day without one is absent from the map. */
export async function readAnchors(days: number[]): Promise<Map<number, OnChainAnchor>> {
  const out = new Map<number, OnChainAnchor>();
  if (!isDeployed() || days.length === 0) return out;
  const results = await publicClientFor(LEDGER_CHAIN).multicall({
    contracts: days.map((day) => ({ address: LEDGER_ADDRESS, abi: LEDGER_ABI, functionName: "anchors", args: [day] }) as const),
  });
  results.forEach((r, i) => {
    if (r.status !== "success") return;
    const [root, probes, endpoints, answered, anchoredAt, blockNumber] = r.result as readonly [Hex, number, number, number, bigint, bigint];
    if (/^0x0+$/.test(root)) return;
    const day = days[i]!;
    out.set(day, { day, root, probes, endpoints, answered, anchoredAt: Number(anchoredAt), blockNumber: Number(blockNumber) });
  });
  return out;
}

/** The contract's own answer on whether a probe is in its day's root. */
export async function verifyOnChain(day: number, leaf: Hex, proof: Hex[]): Promise<boolean> {
  return publicClientFor(LEDGER_CHAIN).readContract({
    address: LEDGER_ADDRESS,
    abi: LEDGER_ABI,
    functionName: "verify",
    args: [day, leaf, proof],
  });
}

/** One day's rows, or null when the store could not be read. */
export function rowsOf(day: number, endpoint?: string): Promise<ProbeRow[] | null> {
  return probesBetween(day * DAY_SECONDS, (day + 1) * DAY_SECONDS, endpoint);
}

/**
 * The days that could be anchored now: over for an hour, holding probes, and
 * not the oldest retained day — retention deletes rows older than thirty
 * days by the second, so the oldest day is usually missing its morning and a
 * root of it would anchor a fragment as though it were the day.
 */
export async function anchorableDays(now = Math.floor(Date.now() / 1000)): Promise<number[] | null> {
  const lastOver = dayOf(now - SETTLE_SECONDS) - 1;
  const rows = await probesBetween(0, (lastOver + 1) * DAY_SECONDS);
  if (!rows) return null;
  const days = [...new Set(rows.map((r) => dayOf(r.checkedAt)))].sort((a, b) => a - b);
  return days.slice(1);
}

export type AnchorOutcome =
  | { day: number; status: "anchored"; hash: Hex; probes: number; verified: boolean }
  | { day: number; status: "already"; root: Hex }
  | { day: number; status: "unreadable" }
  | { day: number; status: "empty" };

/**
 * Anchors one day if it is not already. Reads the rows, builds the root,
 * sends, waits, and then asks the contract to verify one of the day's own
 * probes against what it just stored — a root that the contract cannot
 * verify a leaf of is an encoding mismatch, and better found on day one.
 */
export async function anchorDay(day: number, account: PrivateKeyAccount): Promise<AnchorOutcome> {
  const existing = await readAnchor(day);
  if (existing) return { day, status: "already", root: existing.root };
  const rows = await rowsOf(day);
  if (rows === null) return { day, status: "unreadable" };
  if (rows.length === 0) return { day, status: "empty" };

  const { tree, probes, endpoints, answered } = summariseDay(rows);
  const rpc = publicClientFor(LEDGER_CHAIN);
  const wallet = createWalletClient({ account, chain: bsc, transport: http() });
  const hash = await wallet.writeContract({
    address: LEDGER_ADDRESS,
    abi: LEDGER_ABI,
    functionName: "anchor",
    args: [day, tree.root, probes, endpoints, answered],
  });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`anchor for day ${day} reverted: ${hash}`);

  const sample = probeLeaf(rows[Math.floor(rows.length / 2)]!);
  const verified = await verifyOnChain(day, sample, tree.proof(sample) ?? []);
  return { day, status: "anchored", hash, probes, verified };
}

export type EndpointAnchoring = {
  /** Days in retention on which Kawal called this endpoint. */
  daysCalled: number;
  /** Of those, how many KawalLedger holds a root for. */
  daysAnchored: number;
  /** The newest anchored call to this endpoint, checked against the contract now. */
  latest: {
    day: number;
    checkedAt: number;
    answered: boolean;
    blockNumber: number;
    /** The contract's own `verify` answer; null when the chain could not be asked. */
    included: boolean | null;
  } | null;
};

/**
 * How much of one endpoint's history is anchored, and a live check of its
 * newest anchored call. Memoised for ten minutes: it is a multicall and one
 * `verify` read per endpoint, and the answer changes once a day.
 */
export function anchoringFor(endpoint: string): Promise<EndpointAnchoring | null> {
  return memo(`anchoring:${endpoint}`, 10 * 60_000, async () => {
    if (!isDeployed()) return null;
    const now = Math.floor(Date.now() / 1000);
    const mine = await probesBetween(now - 31 * DAY_SECONDS, now, endpoint);
    if (!mine || mine.length === 0) return null;
    const days = [...new Set(mine.map((r) => dayOf(r.checkedAt)))].sort((a, b) => a - b);
    const held = await readAnchors(days);
    const anchoredDays = days.filter((d) => held.has(d));
    const day = anchoredDays[anchoredDays.length - 1];
    if (day === undefined) return { daysCalled: days.length, daysAnchored: 0, latest: null };

    const call = mine.filter((r) => dayOf(r.checkedAt) === day).at(-1)!;
    const everyone = await rowsOf(day);
    let included: boolean | null = null;
    if (everyone && everyone.length) {
      const tree = summariseDay(everyone).tree;
      const leaf = probeLeaf(call);
      const proof = tree.proof(leaf);
      included = proof ? await verifyOnChain(day, leaf, proof).catch(() => null) : false;
    }
    return {
      daysCalled: days.length,
      daysAnchored: anchoredDays.length,
      latest: { day, checkedAt: call.checkedAt, answered: call.answered, blockNumber: held.get(day)!.blockNumber, included },
    };
  });
}
