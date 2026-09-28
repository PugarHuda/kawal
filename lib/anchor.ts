/**
 * Kawal's probe history, anchored on BSC one UTC day at a time.
 *
 * Every figure Kawal prints about an agent — "answered 209 of 209 calls" —
 * comes out of its own database, and a database row is something its owner
 * can rewrite. KawalLedger (`contracts/src/KawalLedger.sol`) is where that
 * stops: once a day is over, the Merkle root of the day's probes goes on-chain,
 * and a day can be written once. The rows stay here and are served at
 * `/api/anchor/{day}`, so anyone can rebuild the root and compare it, or ask
 * the contract's `verify` about a single probe.
 *
 * What it proves and what it does not: an anchored day cannot be edited after
 * the fact without the root disagreeing. It does not prove the probes were
 * honest when they were made — only that they have not changed since.
 *
 * The encoding here must match the contract byte for byte; `npm run check`
 * rebuilds a tree and walks every proof, and the anchor script asks the
 * deployed contract's `verify` before it trusts a root it just wrote.
 */

import { encodeAbiParameters, keccak256, concat, parseAbi, type Hex, type Address } from "viem";

/** The deployed KawalLedger on BSC mainnet. */
export const LEDGER_ADDRESS: Address = "0x156535B2F5ED2598Da111AB0F6453565161d40C1";
export const LEDGER_CHAIN = 56;

export const LEDGER_ABI = parseAbi([
  "function anchor(uint32 day, bytes32 root, uint32 probes, uint32 endpoints, uint32 answered)",
  "function anchors(uint32 day) view returns (bytes32 root, uint32 probes, uint32 endpoints, uint32 answered, uint64 anchoredAt, uint64 blockNumber)",
  "function verify(uint32 day, bytes32 leaf, bytes32[] proof) view returns (bool)",
  "function latestDay() view returns (uint32)",
  "function anchoredDays() view returns (uint32)",
  "function anchorer() view returns (address)",
  "function operator() view returns (address)",
]);

export const DAY_SECONDS = 86_400;

/** The UTC day a unix-seconds timestamp falls in. */
export function dayOf(unixSeconds: number): number {
  return Math.floor(unixSeconds / DAY_SECONDS);
}

/** A day number as the date people read, `2026-09-27`. */
export function dayLabel(day: number): string {
  return new Date(day * DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

/** `2026-09-27` back to a day number, or null for anything else. */
export function parseDay(label: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return null;
  const ms = Date.parse(`${label}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms / 1000 / DAY_SECONDS;
}

export type ProbeRow = {
  endpoint: string;
  checkedAt: number;
  answered: boolean;
  latencyMs: number;
  protocol: string;
};

/** The leaf for one probe: double-hashed, as the contract's `leafOf`. */
export function probeLeaf(p: ProbeRow): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint64" }, { type: "bool" }, { type: "uint32" }, { type: "string" }],
      [p.endpoint, BigInt(p.checkedAt), p.answered, p.latencyMs, p.protocol],
    ),
  );
  return keccak256(inner);
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export type Tree = { root: Hex; leaves: Hex[]; proof(leaf: Hex): Hex[] | null };

/**
 * A sorted-pair Merkle tree over the leaves, odd node carried up unchanged.
 *
 * Leaves are sorted first so the root depends on which probes a day holds,
 * not on the order a database happened to return them. Two identical probes
 * (same endpoint, second, outcome and latency) hash to one leaf and are kept
 * once: they are the same observation.
 */
export function buildTree(input: Hex[]): Tree {
  const leaves = [...new Set(input.map((l) => l.toLowerCase() as Hex))].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
  );
  if (leaves.length === 0) throw new RangeError("a day with no probes has no root");
  const levels: Hex[][] = [leaves];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i]!, prev[i + 1]!) : prev[i]!);
    levels.push(next);
  }
  return {
    root: levels[levels.length - 1]![0]!,
    leaves,
    proof(leaf) {
      let index = leaves.indexOf(leaf.toLowerCase() as Hex);
      if (index < 0) return null;
      const path: Hex[] = [];
      for (const level of levels.slice(0, -1)) {
        const sibling = index ^ 1;
        if (sibling < level.length) path.push(level[sibling]!);
        index >>= 1;
      }
      return path;
    },
  };
}

/** The contract's `verify`, off-chain. */
export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let node = leaf.toLowerCase() as Hex;
  for (const sib of proof) node = hashPair(node, sib);
  return node === root.toLowerCase();
}

/** A day's probes summarised the way the contract stores them. */
export function summariseDay(rows: ProbeRow[]) {
  const tree = buildTree(rows.map(probeLeaf));
  const endpoints = new Set(rows.map((r) => r.endpoint));
  const answered = new Set(rows.filter((r) => r.answered).map((r) => r.endpoint));
  return { tree, probes: tree.leaves.length, endpoints: endpoints.size, answered: answered.size };
}

export type OnChainAnchor = {
  day: number;
  root: Hex;
  probes: number;
  endpoints: number;
  answered: number;
  anchoredAt: number;
  blockNumber: number;
};

export function isDeployed(): boolean {
  return LEDGER_ADDRESS !== "0x0000000000000000000000000000000000000000";
}
