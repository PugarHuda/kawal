/**
 * Hires an ERC-8183 seller from Kawal's wallet, or shows what it would take.
 *
 * Run: npm run hire -- --provider 0x… --task "…" --budget 1           dry run: simulates the five calls, prices them, names the shortfall
 *      npm run hire -- --provider 0x… --task "…" --budget 1 --send    funds the job through the Altana relay
 *      npm run hire -- --provider 0x… --task "…" --budget 1 --seat "Allocator"   sign with a seat's session key instead
 *      npm run hire -- --job 56665                                   read one job back from the kernel
 *
 * `--budget` is in $U. The dry run is the whole buyer flow executed against
 * the live kernel by `eth_simulateV1` from the wallet that would send it:
 * `createJob` succeeds, `registerJob` and `setBudget` run against the job it
 * just made, and `fund` reverts exactly where an empty $U balance makes it
 * revert — which is the honest way to quote a hire the wallet cannot yet pay.
 */

export {};

import { formatEther, parseUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { adminKey, hasAdminKey, readLedger, isLive, KEY_FILE } from "../lib/vault.ts";
import { explorerAddress, explorerTx } from "../lib/altana.ts";
import { BSC_MAINNET } from "../lib/chains.ts";
import { publicClientFor } from "../lib/rpc.ts";
import { hireQuote, hireAgent, jobStatus, formatU, U_DECIMALS } from "../lib/erc8183.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const SEND = process.argv.includes("--send");
const CHAIN = BSC_MAINNET;

console.log(`Kawal → ERC-8183 AgenticCommerce, BSC mainnet`);

// --- read a job -------------------------------------------------------------

const jobArg = arg("--job");
if (jobArg !== undefined) {
  if (!/^\d+$/.test(jobArg)) {
    console.error(`--job takes a job id; got ${JSON.stringify(jobArg)}\n`);
    process.exit(1);
  }
  const job = await jobStatus(BigInt(jobArg), CHAIN);
  console.log(`\njob          ${job.id}  ${job.statusName}`);
  console.log(`client       ${job.client}`);
  console.log(`provider     ${job.provider}`);
  console.log(`budget       ${formatU(job.budget)}`);
  console.log(`expires      ${new Date(Number(job.expiredAt) * 1000).toISOString()}`);
  console.log(`task         ${job.description.slice(0, 120)}${job.description.length > 120 ? "…" : ""}`);
  console.log(`submitted    ${job.submittedAt > 0n ? new Date(Number(job.submittedAt) * 1000).toISOString() : "not yet"}`);
  console.log(`deliverable  ${job.deliverableUrl ?? (job.submittedAt > 0n ? "(submitted; URL not found in the policy's logs)" : "none")}\n`);
  process.exit(0);
}

// --- quote a hire -------------------------------------------------------------

const providerArg = arg("--provider");
const task = arg("--task");
const budgetArg = arg("--budget");
if (!providerArg || !/^0x[0-9a-fA-F]{40}$/.test(providerArg) || !task || !budgetArg || !/^\d+(\.\d+)?$/.test(budgetArg)) {
  console.error(`\nusage: npm run hire -- --provider 0x… --task "…" --budget <$U> [--seat <name>] [--send]`);
  console.error(`       npm run hire -- --job <id>\n`);
  process.exit(1);
}
const provider = providerArg as Address;
const budgetRaw = parseUnits(budgetArg, U_DECIMALS);

const seatName = arg("--seat");
const seat = seatName ? readLedger().find((s) => s.seat === seatName && isLive(s)) : undefined;
if (seatName && !seat) {
  console.error(`\nNo live seat named ${JSON.stringify(seatName)} in the ledger.\n`);
  process.exit(1);
}

const buyer: Address = seat
  ? seat.walletAddress
  : hasAdminKey()
    ? privateKeyToAccount(adminKey()).address
    : "0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92";

console.log(SEND ? "MODE: sending\n" : "MODE: dry run (add -- --send to fund the job)\n");

const q = await hireQuote({ provider, task, budgetRaw, buyer, chainId: CHAIN });
const bnb = await publicClientFor(CHAIN).getBalance({ address: buyer });

console.log(`buyer        ${buyer}${seat ? ` via seat "${seat.seat}"` : " via the admin key"}`);
console.log(`provider     ${provider}`);
console.log(`budget       ${formatU(budgetRaw)}`);
console.log(`task         ${task.slice(0, 100)}${task.length > 100 ? "…" : ""}\n`);

for (const [name, at] of Object.entries(q.addresses)) {
  console.log(`  ${name.padEnd(13)} ${at}  ${q.deployed[name as keyof typeof q.deployed]} bytes of code`);
}
console.log(`\ndispute      ${Number(q.disputeWindow) / 86_400} day(s)`);
console.log(`next job id  ${q.jobId}`);
console.log(`expires      ${new Date(Number(q.expiredAt) * 1000).toISOString()}`);
console.log(`$U balance   ${formatU(q.balanceRaw)}`);
console.log(`BNB balance  ${formatEther(bnb)} BNB (gas is paid by the Altana relay; a session or admin intent, not a raw transaction)\n`);

console.log(`simulated from ${buyer}, in order:`);
for (const c of q.calls) {
  console.log(`  ${c.status === "success" ? "ok     " : "REVERT "} ${c.name.padEnd(12)} ${c.gasUsed.toString().padStart(7)} gas${c.error ? `  — ${c.error}` : ""}`);
}
console.log(`  ${"".padEnd(7)} ${"total".padEnd(12)} ${q.gasTotal.toString().padStart(7)} gas`);

if (q.shortfallRaw > 0n) {
  console.log(`\nShort by ${formatU(q.shortfallRaw)}. Send $U to ${buyer} and run again.`);
  console.log(`  ${explorerAddress(CHAIN, buyer)}`);
  console.log(`  $U is ${q.addresses.paymentToken} on BSC.\n`);
  process.exit(1);
}
if (q.calls.some((c) => c.status !== "success")) {
  console.log(`\nThe batch does not simulate cleanly; see the revert above. Nothing was sent.\n`);
  process.exit(1);
}
if (!SEND) {
  console.log(`\nDry run. The kernel accepts this batch; nothing was sent. Add -- --send to fund job ${q.jobId}.\n`);
  process.exit(0);
}
if (!seat && !hasAdminKey()) {
  console.error(`\nNo admin key. Put one in ${KEY_FILE} or set KAWAL_ADMIN_KEY.\n`);
  process.exit(1);
}

const result = await hireAgent({ provider, task, budgetRaw, seat, chainId: CHAIN });
console.log(`\n${result.status}  job ${result.jobId}  calls ${result.callsId}`);
if (result.transactionHash) console.log(`  ${explorerTx(CHAIN, result.transactionHash)}`);
const job = await jobStatus(result.jobId, CHAIN);
console.log(`the kernel reads job ${job.id} as ${job.statusName}, client ${job.client}, budget ${formatU(job.budget)}`);
console.log(`\nFollow it with \`npm run hire -- --job ${result.jobId}\`.\n`);
