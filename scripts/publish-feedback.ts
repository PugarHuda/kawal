/**
 * Writes Kawal's uptime measurements into the ERC-8004 reputation registry,
 * reads them back, and takes one back when it must.
 *
 * Run: npm run publish                    dry run — builds every record, sends none
 *      npm run publish -- --send          signs and broadcasts on BSC mainnet
 *      npm run publish -- --verify        re-reads every record this machine wrote off the chain
 *      npm run publish -- --revoke <id>   dry run of revoking Kawal's records about one agent
 *      npm run publish -- --revoke <id> --send
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
 * what separates this from adding to the noise. Two rows per agent, under the
 * tags EIP-8004 suggests: `uptime` and `responseTime`.
 *
 * The evidence — the JSON the on-chain hash is taken over — is pinned to
 * IPFS through 8004scan at send time, signed in as Kawal's wallet, and the
 * record carries `ipfs://{cid}`. The first eleven records carried it inline
 * as a data: URI; `--verify` reads both kinds back and holds each to the
 * same hash.
 */

export {};

import { decodeFunctionData, formatEther, keccak256, toHex, type Hex } from "viem";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { CATEGORIES } from "../lib/taxonomy.ts";
import { retrieveCategory } from "../lib/catalog.ts";
import { getAgent, fetchEvidence } from "../lib/scan.ts";
import { uploadEvidence } from "../lib/scan.auth.ts";
import { proveAgent } from "../lib/probe.ts";
import { uptimeFor } from "../lib/uptime.ts";
import { publicClientFor } from "../lib/rpc.ts";
import { noteWrite, type PublishedRecord } from "../lib/published.ts";
import { adminKey, hasAdminKey, KEY_FILE } from "../lib/vault.ts";
import { explorerTx } from "../lib/altana.ts";
import { BSC_MAINNET } from "../lib/chains.ts";
import {
  buildFeedback,
  buildResponseTime,
  buildRevoke,
  findOwnRecord,
  getSummary,
  readFeedback,
  registryFor,
  FEEDBACK_ABI,
  MIN_OBSERVATIONS_TO_PUBLISH,
  KNOWN_DEFECTS,
  type Measurement,
} from "../lib/feedback.ts";

const SEND = process.argv.includes("--send");
const VERIFY = process.argv.includes("--verify");
const revokeAt = process.argv.indexOf("--revoke");
const REVOKE = revokeAt > -1 ? (process.argv[revokeAt + 1] ?? "") : null;
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
type Published = Record<string, PublishedRecord>;
const published: Published = existsSync(PUBLISHED_FILE)
  ? (JSON.parse(readFileSync(PUBLISHED_FILE, "utf8")) as Published)
  : {};
const save = () => writeFileSync(PUBLISHED_FILE, JSON.stringify(published, null, 2));

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

const rpc = publicClientFor(CHAIN);
// The estimate is simulated from the address that will send, when the key is
// here to derive it from; a dry run on a machine without the key simulates
// from the wallet the README names, which is the same address.
const from = hasAdminKey()
  ? privateKeyToAccount(adminKey()).address
  : ("0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92" as const);

console.log(`Kawal → ERC-8004 reputation registry, BSC mainnet`);
console.log(VERIFY ? "MODE: verify\n" : REVOKE !== null ? (SEND ? "MODE: revoking\n" : "MODE: revoke dry run\n") : SEND ? "MODE: sending\n" : "MODE: dry run (add -- --send to broadcast)\n");

/**
 * What became of the attempt to read a record's evidence back.
 *
 * Three outcomes, not two. "I fetched the evidence and it does not match the
 * hash on-chain" accuses somebody of altering it; "I could not fetch the
 * evidence" says only that a gateway was unhelpful. Collapsing them into one
 * boolean made every gateway hiccup print as MISMATCH — measured on
 * 2026-08-31, three consecutive verify runs over the same 42 records
 * reported 12, then 11, then 7 "mismatches", with the set changing each
 * time and every inline record passing every run. Nothing was wrong with the
 * records; the tool was crying wolf about the one thing it exists to be
 * trusted on.
 */
type Evidence =
  | { read: true; payload: string }
  /** No gateway served the CID this time. Says nothing about the record. */
  | { read: false; reason: "unreadable" }
  /** Neither a data: URI nor ipfs:// — the record itself is malformed. */
  | { read: false; reason: "unsupported" };

/**
 * The payload a record's URI resolves to, whichever way it was carried.
 *
 * The first eleven records carry it inline as a data: URI. Later ones name
 * an IPFS pin, and the bytes there are the gateway's serialisation of the
 * same object — so the payload is rebuilt with `JSON.stringify`, which is
 * what the hash was taken over, as the builder's comment explains.
 *
 * Retried once. The gateway's failures are transient — a record that failed
 * one run read back fine on the next — so a single retry turns most of the
 * noise into an answer rather than leaving a reader to re-run the command
 * and diff two lists themselves.
 */
async function evidenceOf(uri: string): Promise<Evidence> {
  if (uri.startsWith("data:application/json;base64,")) {
    return { read: true, payload: Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8") };
  }
  if (uri.startsWith("ipfs://")) {
    const content = (await fetchEvidence(uri)) ?? (await fetchEvidence(uri));
    return content === null ? { read: false, reason: "unreadable" } : { read: true, payload: JSON.stringify(content) };
  }
  return { read: false, reason: "unsupported" };
}

/**
 * What one of Kawal's transactions wrote, decoded off the chain rather than
 * off the file: the calldata is the record, and the file only remembers the
 * hash that carried it.
 */
async function written(txHash: Hex) {
  const [tx, receipt] = await Promise.all([rpc.getTransaction({ hash: txHash }), rpc.getTransactionReceipt({ hash: txHash })]);
  const decoded = decodeFunctionData({ abi: FEEDBACK_ABI, data: tx.input });
  if (decoded.functionName !== "giveFeedback") throw new Error(`${txHash} is a ${decoded.functionName} call, not giveFeedback`);
  const [agentId, value, valueDecimals, tag1, tag2, endpoint, uri, hash] = decoded.args;
  const evidence = await evidenceOf(uri);
  return {
    ok: receipt.status === "success" && (tx.to ?? "").toLowerCase() === registryFor(CHAIN).toLowerCase(),
    from: tx.from,
    agentId,
    value,
    valueDecimals,
    tag1,
    tag2,
    endpoint,
    carriedBy: uri.startsWith("ipfs://") ? uri : "data: URI",
    payload: evidence.read
      ? keccak256(toHex(evidence.payload)) === hash
        ? ("matches" as const)
        : ("mismatch" as const)
      : evidence.reason,
  };
}

/** How the evidence check reads on the line under a record. */
const PAYLOAD_NOTE = {
  matches: "payload hash matches",
  mismatch: "payload hash MISMATCH",
  unreadable: "payload NOT CHECKED — no gateway served the evidence",
  unsupported: "payload NOT CHECKED — the record's URI is neither data: nor ipfs://",
} as const;

// --- verify: every record the file says was sent, re-read from the chain ----

if (VERIFY) {
  let landed = 0;
  let unchecked = 0;
  let problems = 0;
  let total = 0;
  for (const [agentId, p] of Object.entries(published)) {
    const hashes = [p.txHash, p.responseTimeTx].filter((h): h is string => typeof h === "string");
    for (const h of hashes) {
      total++;
      try {
        const w = await written(h as Hex);
        const onChain = await findOwnRecord(CHAIN, w.agentId, w.from, { tag1: w.tag1, tag2: w.tag2, value: w.value });
        const summary = await getSummary(CHAIN, w.agentId, [w.from], w.tag1, "");
        // The record's own standing on-chain, which is what "as written"
        // means. The evidence check is reported beside it rather than folded
        // into it: a gateway that would not serve a CID has not made the
        // record wrong, and saying so would be the same lie in the other
        // direction as calling it a mismatch.
        const recordStands = w.ok && onChain !== null && !onChain.record.isRevoked && onChain.record.valueDecimals === w.valueDecimals;
        const verdict = !recordStands || w.payload === "mismatch" ? "PROBLEM" : w.payload === "matches" ? "OK     " : "UNCHECKED";
        if (verdict === "OK     ") landed++;
        else if (verdict === "PROBLEM") problems++;
        else unchecked++;
        console.log(`  ${verdict} agent ${agentId} ${w.tag1.padEnd(12)} ${w.value.toString().padStart(6)} (dec ${w.valueDecimals}) ${w.tag2.padEnd(4)}`);
        console.log(`          tx ${h.slice(0, 18)}… ${w.ok ? "succeeded at the registry" : "did NOT succeed at the registry"}; ${PAYLOAD_NOTE[w.payload]} (evidence via ${w.carriedBy})`);
        console.log(`          on-chain ${onChain ? `index ${onChain.index}, ${onChain.record.isRevoked ? "REVOKED" : "live"}` : "NOT FOUND under this writer"}; registry summary for ${w.tag1}: ${summary.count} record(s) from this writer`);
      } catch (e) {
        problems++;
        console.log(`  PROBLEM agent ${agentId} tx ${h.slice(0, 18)}…: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
  }
  // What the file says against what the register holds. The file is Kawal's
  // own bookkeeping and the register is the truth, and they came apart once:
  // on 2026-08-31 the chain held 102 records where the file named 92, because
  // `noteWrite` let a stale `at` survive a responseTime write and ten agents
  // were written about twice. Nothing surfaced that until it was looked for by
  // hand, which is the wrong way to find out you are adding to the noise.
  const perAgent = await Promise.all(
    Object.entries(published).map(async ([agentId, rec]) => {
      const names = (rec.txHash ? 1 : 0) + (rec.responseTimeTx ? 1 : 0);
      try {
        const held = Number(
          await rpc.readContract({
            address: registryFor(CHAIN),
            abi: FEEDBACK_ABI,
            functionName: "getLastIndex",
            args: [BigInt(agentId), account.address],
          }),
        );
        return { agentId, names, held };
      } catch {
        return { agentId, names, held: null };
      }
    }),
  );
  // Compared over the agents that answered, not over all of them. Summing a
  // failed read as zero would make the chain look short of the file and print
  // the opposite of the truth; skipping the comparison entirely because one
  // read failed would say nothing at all, which is how this went unnoticed.
  const compared = perAgent.filter((a): a is { agentId: string; names: number; held: number } => a.held !== null);
  const held = compared.reduce((sum, a) => sum + a.held, 0);
  const named = compared.reduce((sum, a) => sum + a.names, 0);
  const unreadable = perAgent.length - compared.length;

  console.log(`\n${landed} of ${total} record(s) are on-chain exactly as written.`);
  if (held !== named) {
    const ahead = compared.filter((a) => a.held > a.names);
    console.log(
      `The register holds ${held} record(s) from this writer across ${compared.length} agent(s); this machine's ` +
        `file names ${named}. The chain is the count that is true.` +
        (ahead.length ? ` Unnamed here: ${ahead.map((a) => `${a.agentId} (+${a.held - a.names})`).join(", ")}.` : ""),
    );
  }
  if (unreadable > 0) {
    console.log(`${unreadable} agent(s) could not be counted on-chain and were left out of that comparison.`);
  }
  if (unchecked > 0) {
    console.log(
      `${unchecked} more stand on-chain but could not have their evidence read back — no gateway served it. ` +
        `That is a gateway outage, not a bad record; run this again to re-check them.`,
    );
  }
  if (problems > 0) console.log(`${problems} record(s) need looking at.`);
  console.log();
  // 0 every record checked out · 2 nothing wrong, something unverifiable ·
  // 1 a record is actually wrong. A caller that treats "could not check" as
  // "fine" would be back to the bug this replaced.
  process.exit(problems > 0 ? 1 : unchecked > 0 ? 2 : 0);
}

// --- revoke: take back Kawal's rows about one agent ---------------------------

if (REVOKE !== null) {
  const p = published[REVOKE];
  if (!/^\d+$/.test(REVOKE) || !p) {
    console.error(`No record of a publication about agent ${JSON.stringify(REVOKE)} in ${PUBLISHED_FILE}. Nothing to revoke.\n`);
    process.exit(1);
  }
  const hashes = [p.txHash, p.responseTimeTx].filter((h): h is string => typeof h === "string");
  const gasPrice = await rpc.getGasPrice();
  const balance = await rpc.getBalance({ address: from });
  const todo: Array<{ index: bigint; tag1: string; data: Hex; to: `0x${string}`; gas: bigint }> = [];
  for (const h of hashes) {
    const w = await written(h as Hex);
    const onChain = await findOwnRecord(CHAIN, w.agentId, w.from, { tag1: w.tag1, tag2: w.tag2, value: w.value });
    if (!onChain) {
      console.log(`  ${w.tag1}: not found on-chain under ${w.from}; nothing to revoke`);
      continue;
    }
    if (onChain.record.isRevoked) {
      console.log(`  ${w.tag1}: index ${onChain.index} is already revoked`);
      continue;
    }
    const call = buildRevoke(CHAIN, w.agentId, onChain.index);
    const gas = ((await rpc.estimateGas({ account: from, to: call.to, data: call.data })) * GAS_HEADROOM) / 100n;
    todo.push({ index: onChain.index, tag1: w.tag1, ...call, gas });
    console.log(`  ${w.tag1}: index ${onChain.index}, revokeFeedback estimates ${gas} gas, ${formatEther(gas * gasPrice)} BNB`);
  }
  const cost = todo.reduce((n, t) => n + t.gas * gasPrice, 0n);
  console.log(`\nwriter       ${from}\nbalance      ${formatEther(balance)} BNB\ncost         ${formatEther(cost)} BNB for ${todo.length} revocation(s)`);
  if (todo.length === 0) process.exit(0);
  if (balance < cost) {
    console.error(`\nShort by ${formatEther(cost - balance)} BNB. Top up the wallet and run again.\n`);
    process.exit(1);
  }
  if (!SEND) {
    console.log(`\nDry run. The registry accepts these calls; nothing was sent. Add -- --send to revoke.\n`);
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
  for (const t of todo) {
    const hash = await wallet.sendTransaction({ to: t.to, data: t.data, gas: t.gas });
    console.log(`  ${t.tag1} -> ${explorerTx(CHAIN, hash) ?? hash}`);
    const receipt = await rpc.waitForTransactionReceipt({ hash });
    const after = await readFeedback(CHAIN, BigInt(REVOKE), account.address, t.index);
    console.log(`     ${receipt.status}; the registry now reads index ${t.index} as ${after?.isRevoked ? "revoked" : "STILL LIVE"}`);
    (p.revokedTx ??= []).push(hash);
    save();
  }
  process.exit(0);
}

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
    let protocol: Measurement["protocol"] = "mcp";
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
type Kind = "uptime" | "responseTime";
const records: Array<{ m: (typeof measurements)[number]; kind: Kind; record: ReturnType<typeof buildFeedback> }> = [];
for (const m of due) {
  try {
    records.push({ m, kind: "uptime", record: buildFeedback(m, at) });
    const rt = buildResponseTime(m, at);
    if (rt) records.push({ m, kind: "responseTime", record: rt });
  } catch (e) {
    console.error(`  skipping ${m.name} (${m.agentId}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (records.length === 0) {
  console.log(`\nNothing survived the checks above. Nothing to write.\n`);
  process.exit(0);
}

console.log(`${records.length} record(s) to write:\n`);
for (const { m, kind, record } of records) {
  console.log(`  ${m.name} — ${kind}`);
  console.log(`    agent      ${m.agentId}`);
  if (kind === "uptime") console.log(`    uptime     ${record.percent.toFixed(2)}%  (${m.answered} of ${m.checks} probes)`);
  else console.log(`    median     ${record.value} ms  (over ${m.answered} answering probes)`);
  console.log(`    endpoint   ${m.endpoint}`);
  console.log(`    hash       ${record.hash}`);
  console.log(`    calldata   ${(record.data.length - 2) / 2} bytes`);
}
// The evidence is pinned to IPFS at send time, not here: 8004scan allows
// twenty uploads an hour and a dry run that pinned would spend them on
// records that may never be sent. The data: URI is the same payload and
// the same hash, so the estimate below is an upper bound — an ipfs:// URI
// is a quarter of the calldata.
console.log(`\nEvidence is pinned to IPFS when sent; the data: URI stands in for the estimate.`);

console.log(`\nEvery record carries these stated defects:`);
for (const d of KNOWN_DEFECTS) console.log(`  · ${d}`);

// --- cost, estimated per record before anything is signed -------------------
//
// Each record is simulated against the real registry, which also proves the
// calldata is one the contract accepts — a malformed record fails here, on
// nobody's money. Records that cannot be estimated are dropped by name.

const gasPrice = await rpc.getGasPrice();

const priced: Array<(typeof records)[number] & { gas: bigint; cost: bigint }> = [];
for (const r of records) {
  try {
    const gas = ((await rpc.estimateGas({ account: from, to: r.record.to, data: r.record.data, value: 0n })) * GAS_HEADROOM) / 100n;
    priced.push({ ...r, gas, cost: gas * gasPrice });
  } catch (e) {
    console.error(`  cannot estimate ${r.m.name} ${r.kind} (${r.m.agentId}): ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

// Most-observed first, uptime before its response time: a record backed by
// 91 probes says more than one backed by 11, so if the balance covers only
// some, it covers the best ones.
priced.sort((a, b) => b.m.checks - a.m.checks || (a.kind === "uptime" ? -1 : 1));
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
for (const r of affordable) console.log(`  ${r.m.name} ${r.kind} (${r.m.agentId}) — ${r.m.checks} probes, ${formatEther(r.cost)} BNB`);
if (deferred.length > 0) {
  console.log(`\nnot covered by the balance:`);
  for (const r of deferred) console.log(`  ${r.m.name} ${r.kind} (${r.m.agentId}) — ${r.m.checks} probes`);
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
for (const { m, kind, record: built, gas } of affordable) {
  try {
    // Pin the evidence now and carry the CID instead of the bytes. The
    // payload and the hash do not move — the record is rebuilt from the
    // same measurement at the same instant — so what was estimated above is
    // what is sent, minus most of the calldata. A pin that fails (the
    // hourly limit, a registry outage) is not a reason to withhold the
    // measurement: the data: URI carries the identical payload, and which
    // one went is printed and kept.
    let record = built;
    let evidence: string | null = null;
    try {
      const pinned = await uploadEvidence(built.payload);
      const rebuilt = kind === "uptime" ? buildFeedback(m, at, pinned.uri) : buildResponseTime(m, at, pinned.uri);
      if (rebuilt && rebuilt.hash === built.hash) {
        record = rebuilt;
        evidence = pinned.uri;
      }
    } catch (e) {
      console.error(`  ${m.name} ${kind}: could not pin evidence (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); carrying it inline`);
    }
    const hash = await wallet.sendTransaction({ to: record.to, data: record.data, value: 0n, gas, nonce });
    console.log(`  ${m.name} ${kind} -> ${explorerTx(CHAIN, hash) ?? hash}${evidence ? `  evidence ${evidence}` : ""}`);
    await rpc.waitForTransactionReceipt({ hash });
    nonce += 1;
    // Written after each receipt rather than at the end, so a run that dies
    // halfway still knows what it sent.
    published[m.agentId] = noteWrite(published[m.agentId], kind, hash, m.checks, evidence);
    save();
  } catch (e) {
    // One rejected record must not abandon the rest: they are independent
    // writes about different agents, not a cycle that breaks halfway.
    console.error(`  ${m.name} ${kind} FAILED: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    // Whatever went wrong, the count kept here may now be off by one in
    // either direction. The chain's pending count is the truth.
    nonce = await rpc.getTransactionCount({ address: account.address, blockTag: "pending" });
  }
}

console.log(`\nWritten. 8004scan indexes this registry, so the records appear`);
console.log(`beside every other one rather than sitting on-chain unread.`);
console.log(`Re-read them with \`npm run publish -- --verify\`.\n`);
