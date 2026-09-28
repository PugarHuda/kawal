/**
 * Anchors Kawal's probe history in KawalLedger on BSC, one finished UTC day per transaction.
 *
 * Run: npm run anchor                          dry run — lists what would be anchored, sends nothing
 *      npm run anchor -- --send                anchors every finished day not yet on-chain
 *      npm run anchor -- --deploy [anchorer]   deploys KawalLedger (build it first: cd contracts && forge build)
 *
 * Signs with the admin key when this machine holds it — the operator deploys,
 * and may always anchor — otherwise with KAWAL_ANCHOR_KEY, the dedicated key
 * the cron sweep anchors with.
 */

export {};

import { formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { publicClientFor } from "../lib/rpc.ts";
import { adminKey, hasAdminKey } from "../lib/vault.ts";
import { explorerTx, explorerAddress } from "../lib/altana.ts";
import { LEDGER_ADDRESS, LEDGER_CHAIN, dayLabel, summariseDay, isDeployed } from "../lib/anchor.ts";
import { anchorableDays, anchorDay, readAnchors, rowsOf } from "../lib/anchor.run.ts";

const SEND = process.argv.includes("--send");
const deployAt = process.argv.indexOf("--deploy");
const rpc = publicClientFor(LEDGER_CHAIN);

function signer() {
  if (hasAdminKey()) return privateKeyToAccount(adminKey());
  const key = process.env.KAWAL_ANCHOR_KEY;
  if (key) return privateKeyToAccount(key as Hex);
  console.error("No KAWAL_ANCHOR_KEY and no admin key: nothing can sign.\n");
  process.exit(1);
}

if (deployAt > -1) {
  const account = signer();
  const anchorer = (process.argv[deployAt + 1]?.startsWith("0x") ? process.argv[deployAt + 1] : account.address) as Hex;
  const artifact = JSON.parse(readFileSync("contracts/out/KawalLedger.sol/KawalLedger.json", "utf8")) as {
    abi: unknown[];
    bytecode: { object: Hex };
  };
  const { createWalletClient, http, encodeDeployData } = await import("viem");
  const { bsc } = await import("viem/chains");
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [anchorer] });
  const [gas, gasPrice, balance] = await Promise.all([
    rpc.estimateGas({ account: account.address, data }),
    rpc.getGasPrice(),
    rpc.getBalance({ address: account.address }),
  ]);
  console.log(`deploy KawalLedger from ${account.address}, anchorer ${anchorer}`);
  console.log(`gas ${gas} at ${Number(gasPrice) / 1e9} gwei = ${formatEther(gas * gasPrice)} BNB; balance ${formatEther(balance)} BNB`);
  if (!SEND) {
    console.log("Dry run. Add --send to deploy.\n");
    process.exit(0);
  }
  const wallet = createWalletClient({ account, chain: bsc, transport: http() });
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [anchorer], gas: (gas * 12n) / 10n });
  console.log(`sent ${explorerTx(LEDGER_CHAIN, hash) ?? hash}`);
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  console.log(`status ${receipt.status}; KawalLedger at ${receipt.contractAddress}`);
  console.log(`Put that address in LEDGER_ADDRESS in lib/anchor.ts.\n`);
  process.exit(receipt.status === "success" ? 0 : 1);
}

if (!isDeployed()) {
  console.error("LEDGER_ADDRESS in lib/anchor.ts is still the zero address; deploy first.\n");
  process.exit(1);
}

console.log(`KawalLedger ${explorerAddress(LEDGER_CHAIN, LEDGER_ADDRESS) ?? LEDGER_ADDRESS}`);
console.log(SEND ? "MODE: sending\n" : "MODE: dry run (add -- --send to anchor)\n");

const days = await anchorableDays();
if (days === null) {
  console.error("The probe store could not be read. Nothing anchored — a root of a failed read is a root of nothing.\n");
  process.exit(1);
}
const onChain = await readAnchors(days);
const pending = days.filter((d) => !onChain.has(d));
console.log(`${days.length} finished days in retention, ${onChain.size} anchored, ${pending.length} pending`);

const account = signer();
const [gasPrice, balance] = await Promise.all([rpc.getGasPrice(), rpc.getBalance({ address: account.address })]);
// Measured on the first mainnet anchor: ~120k gas for a first write of a day.
const perDay = 130_000n * gasPrice;
console.log(`signer ${account.address}, balance ${formatEther(balance)} BNB, ~${formatEther(perDay)} BNB per day\n`);

for (const day of pending) {
  const rows = await rowsOf(day);
  if (!rows || rows.length === 0) {
    console.log(`${dayLabel(day)}  ${rows ? "no probes" : "unreadable"}, skipped`);
    continue;
  }
  const s = summariseDay(rows);
  if (!SEND) {
    console.log(`${dayLabel(day)}  ${s.probes} probes, ${s.endpoints} endpoints, ${s.answered} answered  root ${s.tree.root}`);
    continue;
  }
  const current = await rpc.getBalance({ address: account.address });
  if (current < perDay) {
    console.error(`\nBalance ${formatEther(current)} BNB is below one anchor. Stopped at ${dayLabel(day)}.\n`);
    process.exit(1);
  }
  const r = await anchorDay(day, account);
  if (r.status === "anchored") {
    console.log(`${dayLabel(day)}  ${r.probes} probes  ${explorerTx(LEDGER_CHAIN, r.hash) ?? r.hash}  on-chain verify: ${r.verified ? "ok" : "FAILED"}`);
    if (!r.verified) {
      console.error("\nThe contract could not verify a probe against the root just written: an encoding mismatch. Stopping.\n");
      process.exit(1);
    }
  } else {
    console.log(`${dayLabel(day)}  ${r.status}`);
  }
}
console.log();
