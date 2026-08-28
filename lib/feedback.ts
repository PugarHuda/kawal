/**
 * Publishing what Kawal measured back into the registry it distrusts.
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
 *
 * Three rules this file will not bend:
 *
 *  - Nothing is published about an agent Kawal has not measured enough times
 *    to have an opinion. A single reading is weather.
 *  - The payload carries `knownDefects` naming what the measurement cannot
 *    see. Publishing a reliability figure with no stated blind spot is asking
 *    to be over-trusted, and the same sentence is on the agent page.
 *  - Building a record and sending it are separate functions. Everything here
 *    except `publishFeedback` is pure, so the harness can check the bytes
 *    without a wallet and without touching the chain.
 */

import { encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { BSC_MAINNET, BSC_TESTNET } from "./chains.ts";

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

export const FEEDBACK_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackUri, bytes32 feedbackHash)",
]);

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
  "A probe counts as answered only on a completed MCP initialize handshake, or for A2A an agent card plus a JSON-RPC envelope from the endpoint it names; HTTP 200 alone is not counted.",
  "Probes are made when the site is used rather than on a schedule, so the sample is not evenly spaced in time.",
];

export type Measurement = {
  chainId: number;
  /** ERC-8004 token id, as a decimal string. */
  agentId: string;
  endpoint: string;
  /** Which protocol the endpoint was probed as. Named in the record. */
  protocol: "mcp" | "a2a";
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

/**
 * Builds the record without sending it.
 *
 * Pure on purpose: the calldata is the part that is permanent, and it is
 * cheaper to be certain about it offline than to find out from a block
 * explorer. `scripts/check.ts` asserts the hash rule against the same shape a
 * live GEBO record used.
 */
export function buildFeedback(m: Measurement, at: Date): FeedbackRecord {
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

  const registry = AGENT_REGISTRY[m.chainId];
  if (!registry) throw new Error(`no agent registry known for chain ${m.chainId}`);

  const percent = uptimePercent(m);
  const days = windowDays(m.since, Math.floor(at.getTime() / 1000));
  const value = BigInt(Math.round(percent * 10 ** VALUE_DECIMALS));

  const counted =
    m.protocol === "a2a"
      ? "the agent card is served and the JSON-RPC endpoint it names answers with a JSON-RPC envelope"
      : "the endpoint completes an MCP initialize handshake";
  const reasoning =
    `Measured by Kawal from ${m.checks} probe(s) over ${days} day(s): ${percent.toFixed(VALUE_DECIMALS)}%. ` +
    `A probe counts as answered only when ${counted}; an HTTP 200 alone is not counted.`;

  // Key order is fixed rather than incidental: the hash is taken over these
  // exact bytes, so a reordering would produce a record nobody can reproduce.
  const payload = JSON.stringify({
    agentRegistry: `eip155:${m.chainId}:${registry}`,
    agentId: Number(m.agentId),
    createdAt: at.toISOString(),
    value: value.toString(),
    valueDecimals: VALUE_DECIMALS,
    tag1: "uptime",
    tag2: `${days}d`,
    endpoint: m.endpoint,
    reasoning,
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
    args: [BigInt(m.agentId), value, VALUE_DECIMALS, "uptime", `${days}d`, m.endpoint, uri, hash],
  });

  return { payload, uri, hash, data, percent, to: registryFor(m.chainId) };
}
