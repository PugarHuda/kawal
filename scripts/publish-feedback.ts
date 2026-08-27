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
 * writers, it is short of writers with a measurement behind them — 8 of 1,200
 * sampled records carried a score. Kawal has called these endpoints hundreds
 * of times and kept every result. Complaining about an empty register while
 * sitting on the observations is not a position worth holding.
 *
 * Every record carries its method and the defects of that method, which is
 * what separates this from adding to the noise.
 */

export {};

import { formatEther } from "viem";
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
/** Generous for a single call with a ~1.3 kB string argument. */
const GAS_PER_TX = 500_000n;

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
    try {
      const detail = await getAgent(listing.agent.chain_id, listing.agent.token_id);
      endpoint = (await proveAgent(detail))?.endpoint ?? null;
    } catch {
      continue;
    }
    if (!endpoint) continue;

    const up = uptimeFor(endpoint);
    if (!up || up.checks < MIN_OBSERVATIONS_TO_PUBLISH) continue;

    measurements.push({
      chainId: listing.agent.chain_id,
      agentId: listing.agent.token_id,
      name: listing.agent.name,
      endpoint,
      checks: up.checks,
      answered: up.answered,
      since: up.since,
      medianMs: up.medianMs,
    });
  }
}

if (measurements.length === 0) {
  console.log(`Nothing to publish. No listed agent has reached ${MIN_OBSERVATIONS_TO_PUBLISH}`);
  console.log(`observations yet — run \`npm run sweep\` a few times first.\n`);
  process.exit(0);
}

// --- build every record before sending any ---------------------------------

const at = new Date();
const records = measurements.map((m) => ({ m, record: buildFeedback(m, at) }));

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

// --- cost, checked before anything is signed -------------------------------

const rpc = publicClientFor(CHAIN);
const gasPrice = await rpc.getGasPrice();
const needed = gasPrice * GAS_PER_TX * BigInt(records.length);

console.log(`\ngas price    ${Number(gasPrice) / 1e9} gwei`);
console.log(`budget       ${formatEther(needed)} BNB for ${records.length} transaction(s)`);

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
const balance = await rpc.getBalance({ address: account.address });
console.log(`writer       ${account.address}`);
console.log(`balance      ${formatEther(balance)} BNB`);

// Stopping halfway here is survivable — each record is independent — but
// finding out mid-run is still worse than finding out now.
if (balance < needed) {
  console.error(`\nShort by ${formatEther(needed - balance)} BNB — refusing to start.\n`);
  process.exit(1);
}

const { createWalletClient, http } = await import("viem");
const { bsc } = await import("viem/chains");
const wallet = createWalletClient({ account, chain: bsc, transport: http() });

console.log();
for (const { m, record } of records) {
  try {
    const hash = await wallet.sendTransaction({ to: record.to, data: record.data, value: 0n });
    console.log(`  ${m.name} -> ${explorerTx(CHAIN, hash) ?? hash}`);
    await rpc.waitForTransactionReceipt({ hash });
  } catch (e) {
    // One rejected record must not abandon the rest: they are independent
    // writes about different agents, not a cycle that breaks halfway.
    console.error(`  ${m.name} FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\nWritten. 8004scan indexes this registry, so the records appear`);
console.log(`beside every other one rather than sitting on-chain unread.\n`);
