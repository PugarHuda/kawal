/**
 * Writes Kawal's uptime measurements into the ERC-8004 reputation registry.
 *
 * Run: npm run publish              dry run — builds every record, sends none
 *      npm run publish -- --send    signs and broadcasts on BSC mainnet
 *
 * Dry by default, like `npm run preempt`, because this is the only script here
 * that leaves something permanent on a public registry with Kawal's name on
 * it. A mistake in a page is an edit; a mistake here is a record.
 *
 * Why write at all, on a site whose whole argument is that the registry cannot
 * be trusted: because `npm run reputation` found the register is not short of
 * writers, it is short of writers with a measurement behind them — 1,200
 * sampled records came from 53 addresses, one of which wrote 265 of the oldest
 * 600. Kawal has called these endpoints hundreds of times and kept every
 * result. Complaining about the register while sitting on the observations is
 * not a position worth holding.
 *
 * Every record carries its method and the defects of that method, which is
 * what separates this from adding to the noise.
 */

export {};

import { formatEther } from "viem";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { CATEGORIES } from "../lib/taxonomy.ts";
import { retrieveCategory } from "../lib/catalog.ts";
import { getAgent } from "../lib/scan.ts";
import { proveAgent } from "../lib/probe.ts";
import { uptimeFor } from "../lib/uptime.ts";
import { publicClientFor } from "../lib/rpc.ts";
import { adminKey, hasAdminKey, KEY_FILE } from "../lib/vault.ts";
import { explorerTx } from "../lib/altana.ts";
import { BSC_MAINNET } from "../lib/chains.ts";
import {
  buildFeedback,
  MIN_OBSERVATIONS_TO_PUBLISH,
  KNOWN_DEFECTS,
  type Measurement,
} from "../lib/feedback.ts";

const SEND = process.argv.includes("--send");
const CHAIN = BSC_MAINNET;

/**
 * What this machine has already written, so a second run does not write it
 * again. The registry keeps every record and de-duplicates nothing: two runs
 * an hour apart would put two near-identical records on-chain, and the second
 * says nothing the first did not. A day is the interval GEBO publishes at,
 * and a day of probes is a measurement worth a new record.
 */
const PUBLISHED_FILE = ".kawal-published.json";
const REPUBLISH_AFTER_MS = 24 * 3_600_000;
type Published = Record<string, { txHash: string; at: string; checks: number }>;
const published: Published = existsSync(PUBLISHED_FILE)
  ? (JSON.parse(readFileSync(PUBLISHED_FILE, "utf8")) as Published)
  : {};
const recent = (agentId: string) => {
  const p = published[agentId];
  return p !== undefined && Date.now() - Date.parse(p.at) < REPUBLISH_AFTER_MS;
};
/**
 * Headroom over the estimate, as a fraction.
 *
 * The estimate is what the node simulated; the block it lands in may cost a
 * little more. Ten percent covers that. An earlier version budgeted a flat
 * 500k per record instead of estimating, which was double the real figure and
 * refused a run the balance could have paid for.
 */
const GAS_HEADROOM = 110n;

console.log(`Kawal → ERC-8004 reputation registry, BSC mainnet`);
console.log(SEND ? "MODE: sending\n" : "MODE: dry run (add -- --send to broadcast)\n");

// --- find the agents Kawal has actually measured ---------------------------
//
// The probe history is keyed by endpoint and carries no agent id, so the
// catalogue is walked to recover the pairing — the same route `npm run sweep`
// takes.

const seen = new Set<string>();
const measurements: Array<Measurement & { name: string }> = [];

for (const category of CATEGORIES) {
  const result = await retrieveCategory(category);
  for (const listing of result.listings) {
    const ref = `${listing.agent.chain_id}:${listing.agent.token_id}`;
    if (listing.agent.chain_id !== CHAIN || seen.has(ref)) continue;
    seen.add(ref);

    let endpoint: string | null = null;
    let protocol: "mcp" | "a2a" = "mcp";
    try {
      const detail = await getAgent(listing.agent.chain_id, listing.agent.token_id);
      const proof = await proveAgent(detail);
      endpoint = proof?.endpoint ?? null;
      protocol = proof?.protocol ?? "mcp";
    } catch {
      continue;
    }
    if (!endpoint) continue;

    const up = await uptimeFor(endpoint);
    if (!up || up.checks < MIN_OBSERVATIONS_TO_PUBLISH) continue;

    measurements.push({
      chainId: listing.agent.chain_id,
      agentId: listing.agent.token_id,
      name: listing.agent.name,
      endpoint,
      protocol,
      checks: up.checks,
      answered: up.answered,
      since: up.since,
      medianMs: up.medianMs,
    });
  }
}

const skippedRecent = measurements.filter((m) => recent(m.agentId));
if (skippedRecent.length > 0) {
  console.log(`already written in the last day, not repeated: ${skippedRecent.map((m) => m.name).join(", ")}\n`);
}
const due = measurements.filter((m) => !recent(m.agentId));

if (due.length === 0) {
  console.log(`Nothing to publish. Every agent with ${MIN_OBSERVATIONS_TO_PUBLISH}+ observations was written`);
  console.log(`in the last day, or none has reached that many yet — run \`npm run sweep\` first.\n`);
  process.exit(0);
}

// --- build every record before sending any ---------------------------------

const at = new Date();

// Built one at a time and individually guarded. `buildFeedback` refuses an
// inconsistent measurement rather than encoding it, and a single refusal must
// cost that one record rather than the whole run — these are independent
// writes about different agents, not a cycle.
const records: Array<{ m: (typeof measurements)[number]; record: ReturnType<typeof buildFeedback> }> = [];
for (const m of due) {
  try {
    records.push({ m, record: buildFeedback(m, at) });
  } catch (e) {
    console.error(`  skipping ${m.name} (${m.agentId}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (records.length === 0) {
  console.log(`\nNothing survived the checks above. Nothing to write.\n`);
  process.exit(0);
}

console.log(`${records.length} record(s) to write:\n`);
for (const { m, record } of records) {
  console.log(`  ${m.name}`);
  console.log(`    agent      ${m.agentId}`);
  console.log(`    uptime     ${record.percent.toFixed(2)}%  (${m.answered} of ${m.checks} probes)`);
  console.log(`    endpoint   ${m.endpoint}`);
  console.log(`    hash       ${record.hash}`);
  console.log(`    calldata   ${(record.data.length - 2) / 2} bytes`);
}

console.log(`\nEvery record carries these stated defects:`);
for (const d of KNOWN_DEFECTS) console.log(`  · ${d}`);

// --- cost, estimated per record before anything is signed -------------------
//
// Each record is simulated against the real registry, which also proves the
// calldata is one the contract accepts — a malformed record fails here, on
// nobody's money. Records that cannot be estimated are dropped by name.

const rpc = publicClientFor(CHAIN);
const gasPrice = await rpc.getGasPrice();
// The estimate is simulated from the address that will send, when the key is
// here to derive it from; a dry run on a machine without the key simulates
// from the wallet the README names, which is the same address.
const from = hasAdminKey()
  ? privateKeyToAccount(adminKey()).address
  : ("0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92" as const);

const priced: Array<(typeof records)[number] & { gas: bigint; cost: bigint }> = [];
for (const r of records) {
  try {
    const gas = ((await rpc.estimateGas({ account: from, to: r.record.to, data: r.record.data, value: 0n })) * GAS_HEADROOM) / 100n;
    priced.push({ ...r, gas, cost: gas * gasPrice });
  } catch (e) {
    console.error(`  cannot estimate ${r.m.name} (${r.m.agentId}): ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

// Most-observed first: a record backed by 91 probes says more than one backed
// by 11, so if the balance covers only some, it covers the best ones.
priced.sort((a, b) => b.m.checks - a.m.checks);
const needed = priced.reduce((n, r) => n + r.cost, 0n);

const balance = await rpc.getBalance({ address: from });

console.log(`\ngas price    ${Number(gasPrice) / 1e9} gwei`);
console.log(`estimated    ${formatEther(needed)} BNB for ${priced.length} transaction(s), ${priced[0] ? `${priced[0].gas} gas each at most` : ""}`);
console.log(`writer       ${from}`);
console.log(`balance      ${formatEther(balance)} BNB`);

// Each record is independent, so a balance that covers some of them covers
// those and not the rest. What is sent and what is left are both printed by
// name, in both modes: a partial write with an explicit remainder is honest;
// a partial write that looks complete is not.
const affordable: typeof priced = [];
let running = 0n;
for (const r of priced) {
  if (running + r.cost > balance) break;
  running += r.cost;
  affordable.push(r);
}
const deferred = priced.slice(affordable.length);

if (affordable.length === 0) {
  console.error(`\nThe balance covers none of these. Short by ${formatEther(priced[0]!.cost - balance)} BNB for even one.\n`);
  process.exit(1);
}
console.log(`\n${SEND ? "sending" : "would send"} ${affordable.length} of ${priced.length}, most-observed first:`);
for (const r of affordable) console.log(`  ${r.m.name} (${r.m.agentId}) — ${r.m.checks} probes, ${formatEther(r.cost)} BNB`);
if (deferred.length > 0) {
  console.log(`\nnot covered by the balance:`);
  for (const r of deferred) console.log(`  ${r.m.name} (${r.m.agentId}) — ${r.m.checks} probes`);
  console.log(`Top up ${formatEther(needed - balance)} BNB and run again. What was sent is recorded in ${PUBLISHED_FILE} and not repeated for a day.`);
}

if (!SEND) {
  console.log(`\nDry run. Nothing was signed and nothing was sent.`);
  console.log(`Re-run with \`npm run publish -- --send\` to write these on-chain.\n`);
  process.exit(0);
}

if (!hasAdminKey()) {
  console.error(`\nNo admin key. Put one in ${KEY_FILE} or set KAWAL_ADMIN_KEY.\n`);
  process.exit(1);
}

const account = privateKeyToAccount(adminKey());

const { createWalletClient, http } = await import("viem");
const { bsc } = await import("viem/chains");
const wallet = createWalletClient({ account, chain: bsc, transport: http() });

// The nonce is managed here rather than left to the client. The public BSC
// endpoints are load-balanced, and a node that has not yet seen the previous
// transaction hands back the nonce it already used — the first live run lost
// one record of ten to "nonce is lower than the current nonce" even though
// every send waited for its receipt. Counted up from the pending count once,
// advanced only after a receipt, and re-read from the chain after a failure.
let nonce = await rpc.getTransactionCount({ address: account.address, blockTag: "pending" });

console.log();
for (const { m, record, gas } of affordable) {
  try {
    const hash = await wallet.sendTransaction({ to: record.to, data: record.data, value: 0n, gas, nonce });
    console.log(`  ${m.name} -> ${explorerTx(CHAIN, hash) ?? hash}`);
    await rpc.waitForTransactionReceipt({ hash });
    nonce += 1;
    // Written after each receipt rather than at the end, so a run that dies
    // halfway still knows what it sent.
    published[m.agentId] = { txHash: hash, at: new Date().toISOString(), checks: m.checks };
    writeFileSync(PUBLISHED_FILE, JSON.stringify(published, null, 2));
  } catch (e) {
    // One rejected record must not abandon the rest: they are independent
    // writes about different agents, not a cycle that breaks halfway.
    console.error(`  ${m.name} FAILED: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    // Whatever went wrong, the count kept here may now be off by one in
    // either direction. The chain's pending count is the truth.
    nonce = await rpc.getTransactionCount({ address: account.address, blockTag: "pending" });
  }
}

console.log(`\nWritten. 8004scan indexes this registry, so the records appear`);
console.log(`beside every other one rather than sitting on-chain unread.\n`);
