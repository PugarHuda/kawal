/**
 * How many x402 claims on BSC are backed by a server that asks for money.
 *
 * `assess` treats `x402_supported` as one of the two conditions for calling an
 * agent hireable, and it is a flag a registration sets about itself. This
 * script is what keeps the number in lib/x402.ts honest: it re-measures rather
 * than citing a figure someone typed once.
 *
 *   npm run x402            sample 200 registrations
 *   npm run x402 -- 400     sample more
 *
 * Only endpoints that already answer are counted as tested. An agent whose
 * endpoint is dead tells us nothing about x402 either way, and folding those
 * into the denominator would understate the problem.
 */

import { listAgents, getAgent } from "../lib/scan.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { checkX402, networkName } from "../lib/x402.ts";

/*
 * A negative result is only worth reporting if the instrument works.
 *
 * Every claim below comes back unbacked, and the honest question is whether
 * Kawal can read a challenge at all. Quack AI's agent-trust endpoint is the
 * one live x402 server reachable from this ecosystem, so it runs first as a
 * positive control: if this stops quoting a price, the sweep's zeros mean
 * nothing and the run says so instead of reporting a clean sheet.
 */
const CONTROL = "https://q402.quackai.ai/api/x402/agent-trust/0x0000000000000000000000000000000000000001";

const control = await checkX402(CONTROL);
if (!control.demanded) {
  console.error(`control FAILED: ${CONTROL}`);
  console.error(`  HTTP ${control.status} — ${control.error ?? "no challenge"}`);
  console.error(`  The reader could not obtain a known-good challenge, so any`);
  console.error(`  "unbacked" verdict below would be unsafe to trust.`);
  process.exit(1);
}
const paid = control.accepts[0];
console.log(`control ok   : ${control.serviceName} quotes ${paid?.amount} of ${paid?.asset.slice(0, 10)}… on ${networkName(paid?.network ?? "")}`);
console.log(`               the reader works, so a zero below is a finding, not a bug
`);

const sample = Number(process.argv[2] ?? 200);
const pages = Math.max(1, Math.ceil(sample / 50));

const claimants: { name: string; tokenId: string }[] = [];
let scanned = 0;
let total = 0;

for (let page = 1; page <= pages; page++) {
  const res = await listAgents({ limit: 50, page });
  if (page === 1) total = res.total;
  scanned += res.agents.length;
  for (const a of res.agents) {
    if (a.x402_supported === true) claimants.push({ name: a.name, tokenId: String(a.token_id) });
  }
}

console.log(`registry     : ${total.toLocaleString()} agents on BSC`);
console.log(`sampled      : ${scanned}`);
console.log(`claim x402   : ${claimants.length} (${((claimants.length / Math.max(1, scanned)) * 100).toFixed(1)}%)\n`);

const results = await mapLimit(claimants, 5, async (c) => {
  const detail = await getAgent(56, c.tokenId).catch(() => null);
  const endpoint = (detail as { services?: Record<string, { endpoint?: string }> } | null)?.services?.mcp?.endpoint;
  if (typeof endpoint !== "string") return { ...c, endpoint: null, check: null };
  return { ...c, endpoint, check: await checkX402(endpoint) };
});

const tested = results.filter((r) => r.check !== null && r.check.status > 0);
const paying = tested.filter((r) => r.check!.demanded);

for (const r of paying) {
  const a = r.check!.accepts[0];
  console.log(`  CHARGES  ${r.name.slice(0, 34).padEnd(34)} ${a ? `${a.amount} of ${a.asset.slice(0, 10)}… on ${networkName(a.network)}` : ""}`);
}

console.log(`\nendpoints that answered at all : ${tested.length} of ${claimants.length} claimants`);
console.log(`of those, actually charge      : ${paying.length}`);
console.log(`unbacked claims                : ${tested.length - paying.length}`);

if (paying.length === 0 && tested.length > 0) {
  console.log(`\nEvery x402 claim in this sample is unbacked. The flag costs nothing to`);
  console.log(`set and nothing checks it, so Kawal checks it.`);
}
