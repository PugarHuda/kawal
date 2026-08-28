/**
 * Publishing what Kawal measured back into the registry it distrusts — and
 * reading it back to make sure it landed.
 *
 * Every other module here reads. This one writes, and the reason is the
 * finding that produced `lib/reputation.ts`: 1,200 ERC-8004 records sampled
 * across BSC came from 53 addresses, one of which wrote 265 of the oldest 600.
 * The register is not short of writers — it is short of writers with a
 * measurement behind them.
 *
 * Kawal has one. It has called these endpoints hundreds of times and kept
 * every result. Sitting on that while complaining the registry is empty would
 * be a strange position to hold, so this turns the probe history into the same
 * kind of record GEBO publishes: a value, the method that produced it, and the
 * defects that method is known to have.
 *
 * The shape is not invented. It was read off a live GEBO transaction and
 * decoded against the registry ABI, so a record written here is indexed by
 * 8004scan exactly like every other one rather than sitting on-chain unread.
 * The tags are the ones EIP-8004 suggests — `uptime` at two decimals,
 * `responseTime` in whole milliseconds — so a reader comparing Kawal's rows
 * with anyone else's is comparing like with like.
 *
 * Three rules this file will not bend:
 *
 *  - Nothing is published about an agent Kawal has not measured enough times
 *    to have an opinion. A single reading is weather.
 *  - The payload carries `knownDefects` naming what the measurement cannot
 *    see. Publishing a reliability figure with no stated blind spot is asking
 *    to be over-trusted, and the same sentence is on the agent page.
 *  - Building a record and sending it are separate functions. Everything here
 *    that builds is pure, so the harness can check the bytes without a wallet
 *    and without touching the chain; the functions that read the chain are
 *    marked as such and return rather than throw on an absent record.
 */

import { encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { BSC_MAINNET, BSC_TESTNET } from "./chains.ts";
import { publicClientFor } from "./rpc.ts";

/**
 * The ERC-8004 Reputation Registry.
 *
 * Same address on both BSC chains, which is why it is a constant rather than a
 * lookup — but it is still keyed, so a third chain cannot silently inherit an
 * address nobody checked.
 */
//
// Checksummed by viem from the lowercase form rather than typed in mixed case.
// The first version of this file carried a hand-typed checksum that was wrong
// in one letter; the dry run never noticed because it only builds calldata,
// and `--send` would have thrown "address is invalid" on the first record.
// Found by estimating gas for real. `getAddress` cannot be wrong in that way.
const REGISTRY: Record<number, Address> = {
  [BSC_MAINNET]: getAddress("0x8004baa17c55a88189ae136b182e5fda19de9b63"),
  [BSC_TESTNET]: getAddress("0x8004baa17c55a88189ae136b182e5fda19de9b63"),
};

/** The agent registry an ERC-8004 id is scoped to. Named in every payload. */
const AGENT_REGISTRY: Record<number, Address> = {
  [BSC_MAINNET]: getAddress("0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"),
  [BSC_TESTNET]: getAddress("0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"),
};

export function registryFor(chainId: number): Address {
  const at = REGISTRY[chainId];
  if (!at) throw new Error(`no reputation registry known for chain ${chainId}`);
  return at;
}

export function agentRegistryFor(chainId: number): Address {
  const at = AGENT_REGISTRY[chainId];
  if (!at) throw new Error(`no agent registry known for chain ${chainId}`);
  return at;
}

/**
 * The registry's interface, from EIP-8004.
 *
 * Both BSC registries are proxies, so the selectors are not in the bytecode
 * at these addresses; each signature was instead confirmed by calling it
 * against the live contract — `readFeedback(43129, kawal, 1)` returned the
 * record `giveFeedback` wrote, `getSummary` counted it, `getLastIndex` said
 * 1, and `ownerOf(43129)` named the owner 8004scan shows. Indexes are
 * 1-based: index 0 reverts with "index must be > 0".
 */
export const FEEDBACK_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackUri, bytes32 feedbackHash)",
  "function revokeFeedback(uint256 agentId, uint64 feedbackIndex)",
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
]);

const IDENTITY_ABI = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);

/**
 * Two decimals, so 100.00% is 10000.
 *
 * Matched to what the ecosystem already writes rather than chosen: reading it
 * back at a different scale than every other uptime record would make Kawal's
 * numbers quietly incomparable with the ones beside them.
 */
export const VALUE_DECIMALS = 2;

/**
 * The fewest observations Kawal will publish an opinion from.
 *
 * Higher than the three it takes to overrule the registry on this site. A page
 * that says "answered 0 of 3" is showing its own working to one reader who can
 * see the sample size; a permanent on-chain record is quoted by people who
 * will never see it, so the bar to write one is higher than the bar to draw
 * one.
 */
export const MIN_OBSERVATIONS_TO_PUBLISH = 10;

/**
 * What this measurement cannot see, published with it.
 *
 * Borrowed in substance from GEBO, which states the same limits about itself.
 * A reliability number travels further than its caveats, so the caveats go
 * in the record rather than in a footnote on a website nobody reading the
 * chain will open.
 */
export const KNOWN_DEFECTS = [
  "Single vantage point: an agent that geo-blocks or ASN-blocks the prober appears unreachable.",
  "Cannot distinguish 'the agent is down' from 'unreachable from here'.",
  "A probe counts as answered only on a completed MCP initialize handshake, for A2A an agent card plus a JSON-RPC envelope from the endpoint it names, or for OASF a served record naming the agent; HTTP 200 alone is not counted.",
  "Probes are made on a daily schedule and additionally whenever the site is used, so the sample is denser when the site is busier.",
];

export type Measurement = {
  chainId: number;
  /** ERC-8004 token id, as a decimal string. */
  agentId: string;
  endpoint: string;
  /** Which protocol the endpoint was probed as. Named in the record. */
  protocol: "mcp" | "a2a" | "oasf";
  checks: number;
  answered: number;
  /** Unix seconds of the oldest observation in the window. */
  since: number;
  medianMs: number | null;
};

export type FeedbackRecord = {
  /** The JSON that is hashed and carried, as a string. */
  payload: string;
  /** `data:application/json;base64,…`, the field the registry stores. */
  uri: string;
  /** keccak256 of the payload bytes — not of the URI. Verified against a live record. */
  hash: Hex;
  /** The calldata `giveFeedback` receives. */
  data: Hex;
  /** Uptime as a percentage, for printing. */
  percent: number;
  to: Address;
  /** The on-chain tag pair, so a reader can find the row again. */
  tag1: string;
  tag2: string;
  /** The value as written, in `valueDecimals`. */
  value: bigint;
  valueDecimals: number;
};

/** Percentage in whole units, rounded to `VALUE_DECIMALS`. */
export function uptimePercent(m: Pick<Measurement, "checks" | "answered">): number {
  if (m.checks === 0) return 0;
  return Math.round((m.answered / m.checks) * 100 * 10 ** VALUE_DECIMALS) / 10 ** VALUE_DECIMALS;
}

/** Whole days the window covers, at least one. */
export function windowDays(since: number, now = Math.floor(Date.now() / 1000)): number {
  return Math.max(1, Math.round((now - since) / 86_400));
}

function guard(m: Measurement) {
  if (m.checks < MIN_OBSERVATIONS_TO_PUBLISH) {
    throw new Error(
      `refusing to publish from ${m.checks} observation(s); ${MIN_OBSERVATIONS_TO_PUBLISH} is the floor`,
    );
  }

  // A count that cannot be true means the caller's history is corrupt, and the
  // arithmetic below does not notice: 30 answered of 10 checks builds cleanly
  // into a permanent record claiming 300% uptime. Refuse rather than clamp —
  // clamping would publish 100% about an agent whose real figure is unknown,
  // which is a confident lie where this is an honest halt.
  if (m.answered < 0 || m.answered > m.checks) {
    throw new Error(
      `refusing to publish ${m.answered} answered of ${m.checks} checks: the history is not consistent`,
    );
  }

  // BigInt() throws a bare SyntaxError on anything unparseable, which arrives
  // at the operator as "Cannot convert x to a BigInt" with no hint of which
  // agent caused it.
  if (!/^\d+$/.test(m.agentId)) {
    throw new Error(`refusing to publish about agent id ${JSON.stringify(m.agentId)}: not a token id`);
  }
}

/**
 * Encodes one record: the payload the hash covers, the URI that carries it,
 * and the calldata. Shared by every tag so they cannot drift apart.
 */
function encode(
  m: Measurement,
  at: Date,
  spec: { tag1: string; value: bigint; valueDecimals: number; reasoning: string; percent: number },
): FeedbackRecord {
  const registry = agentRegistryFor(m.chainId);
  const days = windowDays(m.since, Math.floor(at.getTime() / 1000));
  const tag2 = `${days}d`;

  // Key order is fixed rather than incidental: the hash is taken over these
  // exact bytes, so a reordering would produce a record nobody can reproduce.
  const payload = JSON.stringify({
    agentRegistry: `eip155:${m.chainId}:${registry}`,
    agentId: Number(m.agentId),
    createdAt: at.toISOString(),
    value: spec.value.toString(),
    valueDecimals: spec.valueDecimals,
    tag1: spec.tag1,
    tag2,
    endpoint: m.endpoint,
    reasoning: spec.reasoning,
    method: {
      measuredBy: "Kawal",
      protocol: m.protocol,
      probes: m.checks,
      answered: m.answered,
      windowDays: days,
      medianMs: m.medianMs,
      vantage: "single region",
      knownDefects: KNOWN_DEFECTS,
    },
  });

  const hash = keccak256(toHex(payload));
  const uri = `data:application/json;base64,${Buffer.from(payload, "utf8").toString("base64")}`;

  const data = encodeFunctionData({
    abi: FEEDBACK_ABI,
    functionName: "giveFeedback",
    args: [BigInt(m.agentId), spec.value, spec.valueDecimals, spec.tag1, tag2, m.endpoint, uri, hash],
  });

  return {
    payload,
    uri,
    hash,
    data,
    percent: spec.percent,
    to: registryFor(m.chainId),
    tag1: spec.tag1,
    tag2,
    value: spec.value,
    valueDecimals: spec.valueDecimals,
  };
}

/**
 * Builds the `uptime` record without sending it.
 *
 * Pure on purpose: the calldata is the part that is permanent, and it is
 * cheaper to be certain about it offline than to find out from a block
 * explorer. `scripts/check.ts` asserts the hash rule against the same shape a
 * live GEBO record used. The eleven records already on BSC mainnet were
 * written by exactly this shape, and it is not to change under them.
 */
export function buildFeedback(m: Measurement, at: Date): FeedbackRecord {
  guard(m);
  const percent = uptimePercent(m);
  const days = windowDays(m.since, Math.floor(at.getTime() / 1000));
  const counted =
    m.protocol === "a2a"
      ? "the agent card is served and the JSON-RPC endpoint it names answers with a JSON-RPC envelope"
      : m.protocol === "oasf"
        ? "the endpoint serves an OASF record naming the agent"
        : "the endpoint completes an MCP initialize handshake";
  return encode(m, at, {
    tag1: "uptime",
    value: BigInt(Math.round(percent * 10 ** VALUE_DECIMALS)),
    valueDecimals: VALUE_DECIMALS,
    percent,
    reasoning:
      `Measured by Kawal from ${m.checks} probe(s) over ${days} day(s): ${percent.toFixed(VALUE_DECIMALS)}%. ` +
      `A probe counts as answered only when ${counted}; an HTTP 200 alone is not counted.`,
  });
}

/**
 * The `responseTime` record EIP-8004 suggests: whole milliseconds, no
 * decimals, the median across the answering probes in the window.
 *
 * Returns null when nothing answered — a response time for an endpoint that
 * never responded is not a number, and writing zero would read as instant.
 * `successRate` is not written separately: for a prober that counts only
 * protocol-level answers it is the same figure as `uptime`, and one number
 * under two tags is two rows of gas for no information.
 */
export function buildResponseTime(m: Measurement, at: Date): FeedbackRecord | null {
  guard(m);
  if (m.medianMs === null || m.answered === 0) return null;
  const days = windowDays(m.since, Math.floor(at.getTime() / 1000));
  const ms = Math.max(0, Math.round(m.medianMs));
  return encode(m, at, {
    tag1: "responseTime",
    value: BigInt(ms),
    valueDecimals: 0,
    percent: uptimePercent(m),
    reasoning:
      `Median round trip of ${ms} ms across the ${m.answered} probe(s) that answered, of ${m.checks} over ${days} day(s), ` +
      `measured by Kawal from one region. The median is chosen over the mean so one slow tail does not become the number.`,
  });
}

/* ------------------------------------------------------------ reads ---
 *
 * Chain reads, so the publisher can prove its own records landed rather than
 * trusting the receipt it wrote to disk, and so the owner page can hold
 * 8004scan's `owner_address` against the registry that mints the token.
 */

export type OnChainFeedback = {
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  isRevoked: boolean;
};

/** One record by its 1-based index under a client address. Null when there is none. */
export async function readFeedback(chainId: number, agentId: bigint, client: Address, index: bigint): Promise<OnChainFeedback | null> {
  try {
    const [value, valueDecimals, tag1, tag2, isRevoked] = await publicClientFor(chainId).readContract({
      address: registryFor(chainId),
      abi: FEEDBACK_ABI,
      functionName: "readFeedback",
      args: [agentId, client, index],
    });
    return { value, valueDecimals, tag1, tag2, isRevoked };
  } catch {
    return null;
  }
}

/** How many records `client` has written about `agentId`; 0 when none. */
export async function lastIndex(chainId: number, agentId: bigint, client: Address): Promise<bigint> {
  return publicClientFor(chainId).readContract({
    address: registryFor(chainId),
    abi: FEEDBACK_ABI,
    functionName: "getLastIndex",
    args: [agentId, client],
  });
}

/** The registry's own aggregate over the named clients and tags. Empty strings match every tag. */
export async function getSummary(chainId: number, agentId: bigint, clients: Address[], tag1 = "", tag2 = "") {
  const [count, summaryValue, summaryValueDecimals] = await publicClientFor(chainId).readContract({
    address: registryFor(chainId),
    abi: FEEDBACK_ABI,
    functionName: "getSummary",
    args: [agentId, clients, tag1, tag2],
  });
  return { count, summaryValue, summaryValueDecimals };
}

/**
 * Finds the index of a record Kawal wrote, by walking back from the client's
 * last index until the tags and value match. Kawal writes at most a few rows
 * per agent, so the walk is short; null when nothing matches.
 */
export async function findOwnRecord(
  chainId: number,
  agentId: bigint,
  client: Address,
  match: { tag1: string; tag2: string; value: bigint },
): Promise<{ index: bigint; record: OnChainFeedback } | null> {
  const last = await lastIndex(chainId, agentId, client);
  for (let i = last; i >= 1n; i--) {
    const record = await readFeedback(chainId, agentId, client, i);
    if (record && record.tag1 === match.tag1 && record.tag2 === match.tag2 && record.value === match.value) {
      return { index: i, record };
    }
  }
  return null;
}

/** The calldata `revokeFeedback` takes. Pure, so a dry run can estimate it. */
export function buildRevoke(chainId: number, agentId: bigint, index: bigint): { to: Address; data: Hex } {
  return {
    to: registryFor(chainId),
    data: encodeFunctionData({ abi: FEEDBACK_ABI, functionName: "revokeFeedback", args: [agentId, index] }),
  };
}

/**
 * Who holds the identity token, straight from the Identity Registry.
 *
 * 8004scan publishes an `owner_address` it indexed; this is the contract that
 * minted the token, read now. Null when the token does not exist — `ownerOf`
 * reverts on a burned or never-minted id — or the chain is unknown.
 */
export async function ownerOfAgent(chainId: number, tokenId: string | bigint): Promise<Address | null> {
  const registry = AGENT_REGISTRY[chainId];
  if (!registry || !/^\d+$/.test(String(tokenId))) return null;
  try {
    return await publicClientFor(chainId).readContract({
      address: registry,
      abi: IDENTITY_ABI,
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
    });
  } catch {
    return null;
  }
}
