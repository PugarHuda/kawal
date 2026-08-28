/**
 * Buys one Kawal report, the way an x402 client would — closing the loop the
 * README leaves open. The endpoint that charges was proven by reading its
 * challenge; this proves it can be paid.
 *
 * Run: npm run pay                                   dry run against production: parse the challenge, price it, name the shortfall
 *      npm run pay -- --send                         pay the native rail from the admin wallet and print the report
 *      npm run pay -- http://localhost:3000          another instance
 *      npm run pay -- --agent 56:43129               another agent (default 56:2468)
 *      npm run pay -- --altana [--seat "Allocator"]  pay through an Altana session key with `fetchWithX402` instead
 *
 * Two buyers, because the endpoint offers two kinds of rail. The native rail
 * is a plain BNB transfer signed by the admin key, resent as the transaction
 * hash under `PAYMENT-SIGNATURE`. The Altana rails are signed authorisations
 * a session key produces and the SDK's `fetchWithX402` carries; Kawal settles
 * those itself. Both read the challenge with Kawal's own `readChallenge`, so
 * what this script pays is exactly what the prober reports.
 */

export {};

import { formatEther, formatUnits, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { selectX402Requirement, type X402Requirement } from "@altananetwork/sdk";
import { readChallenge } from "../lib/x402.ts";
import { publicClientFor } from "../lib/rpc.ts";
import { adminKey, hasAdminKey, readLedger, isLive, KEY_FILE } from "../lib/vault.ts";
import { clientFor, explorerTx, sessionFromSeat } from "../lib/altana.ts";
import { BSC_MAINNET } from "../lib/chains.ts";

const SEND = process.argv.includes("--send");
const ALTANA = process.argv.includes("--altana");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const BASE = (process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ?? "https://kawal-three.vercel.app").replace(/\/$/, "");
const AGENT = arg("--agent") ?? "56:2468";
if (!/^\d+:\d+$/.test(AGENT)) {
  console.error(`--agent takes chainId:tokenId; got ${JSON.stringify(AGENT)}\n`);
  process.exit(1);
}
const URL_ = `${BASE}/api/report?agent=${AGENT}`;
const CONFIRMATIONS = 3n;

console.log(`Kawal x402 buyer — ${ALTANA ? "Altana session rail" : "native rail"}`);
console.log(SEND ? "MODE: paying\n" : "MODE: dry run (add -- --send to pay)\n");
console.log(`GET ${URL_}`);

// --- the opening move ----------------------------------------------------------

const first = await fetch(URL_, { headers: { accept: "application/json" } });
console.log(`  HTTP ${first.status}`);
if (first.status !== 402) {
  console.log(`  answered without asking to be paid:\n${(await first.text()).slice(0, 400)}\n`);
  process.exit(first.status === 503 ? 1 : 0);
}

// The header first, as Kawal's own reader does; the body as the fallback.
const header = first.headers.get("payment-required");
const raw: unknown = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await first.json();
const parsed = readChallenge(raw);
if (!parsed) {
  console.error(`  a 402 with no readable payment terms; the body was:\n${JSON.stringify(raw).slice(0, 400)}\n`);
  process.exit(1);
}
console.log(`  ${parsed.serviceName ?? "(unnamed)"} — x402 v${parsed.x402Version}, carried in ${header ? "PAYMENT-REQUIRED" : "the body"}`);
console.log(`  quote: ${parsed.quote}`);
console.log(`  ${parsed.accepts.length} way(s) to pay:`);
for (const a of parsed.accepts) {
  console.log(`    ${a.scheme.padEnd(16)} ${a.amount.padStart(20)} of ${a.asset.padEnd(42)} on ${a.network}  to ${a.payTo}  within ${a.maxTimeoutSeconds ?? "?"}s`);
}

/** Prints what came back after paying: the v2 receipt header and the body. */
async function show(res: Response) {
  console.log(`\n  HTTP ${res.status}`);
  const receipt = res.headers.get("payment-response");
  if (receipt) console.log(`  PAYMENT-RESPONSE ${Buffer.from(receipt, "base64").toString("utf8")}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status === 402) {
    console.log(`  refused: ${String(body.rejected ?? body.error)}\n`);
    process.exit(1);
  }
  console.log(`  payment ${JSON.stringify(body.payment)}`);
  console.log(`\n${JSON.stringify(body.report ?? body, null, 2)}\n`);
}

// --- the Altana rail: a session key signs, the SDK carries it ------------------

if (ALTANA) {
  const seatName = arg("--seat");
  const seats = readLedger().filter((s) => isLive(s) && /^0x[0-9a-fA-F]{64}$/.test(s.sessionPrivateKey));
  const seat = seatName ? seats.find((s) => s.seat === seatName) : seats[0];
  if (!seat) {
    console.error(`\nNo live seat ${seatName ? `named ${JSON.stringify(seatName)} ` : ""}with a session key in the ledger on this machine.\n`);
    process.exit(1);
  }
  const options = parsed.accepts.map((a) => ({ ...(raw as { accepts: X402Requirement[] }).accepts.find((o) => o.scheme === a.scheme && o.asset === a.asset)!, x402Version: parsed.x402Version ?? 2 }));
  const chosen = selectX402Requirement(options, { chainId: BSC_MAINNET });
  console.log(`\nseat         ${seat.seat}  key ${seat.publicKey.slice(0, 14)}…  wallet ${seat.walletAddress}`);
  if (!chosen) {
    console.log(`\nThe challenge offers no rail a session key can sign. The native rail is a BNB transfer,`);
    console.log(`which \`fetchWithX402\` cannot make; the Altana rails appear only when the server holds a`);
    console.log(`funded settler key (KAWAL_FACILITATOR_KEY or the admin key). Nothing to pay.\n`);
    process.exit(1);
  }
  console.log(`would pay    ${chosen.amount} of ${chosen.asset} via ${chosen.extra?.assetTransferMethod} to ${chosen.payTo}`);
  const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
  const rpc = publicClientFor(BSC_MAINNET);
  const [bal, dec, sym] = await Promise.all([
    rpc.readContract({ address: chosen.asset, abi: erc20, functionName: "balanceOf", args: [seat.walletAddress] }),
    rpc.readContract({ address: chosen.asset, abi: erc20, functionName: "decimals" }),
    rpc.readContract({ address: chosen.asset, abi: erc20, functionName: "symbol" }),
  ]);
  const amount = BigInt(chosen.amount ?? chosen.maxAmountRequired ?? "0");
  console.log(`balance      ${formatUnits(bal, dec)} ${sym} in the wallet`);
  if (bal < amount) console.log(`short by     ${formatUnits(amount - bal, dec)} ${sym}`);
  console.log(`\nThe session must also have ${chosen.extra?.assetTransferMethod === "eip3009" ? "the token" : "Permit2"} approved as its signature checker`);
  console.log(`(client.approveSignatureChecker) and, on permit2-exact, the token approved to Permit2 (client.approveTokenForPermit2).`);
  if (!SEND) {
    console.log(`\nDry run. Nothing was signed. Add -- --send to pay through fetchWithX402.\n`);
    process.exit(bal < amount ? 1 : 0);
  }
  const res = await clientFor(BSC_MAINNET).fetchWithX402({
    session: sessionFromSeat(seat),
    url: URL_,
    init: { headers: { accept: "application/json" } },
    chainId: BSC_MAINNET,
  });
  await show(res);
  process.exit(0);
}

// --- the native rail: a plain transfer, resent as its hash ---------------------

const native = parsed.accepts.find((a) => a.scheme === "native-transfer" && a.network === "eip155:56");
if (!native) {
  console.error(`\nNo native-transfer option on BNB Smart Chain in the challenge; nothing this buyer can pay.\n`);
  process.exit(1);
}
const to = native.payTo as Address;
const amount = BigInt(native.amount);

const rpc = publicClientFor(BSC_MAINNET);
const from = hasAdminKey() ? privateKeyToAccount(adminKey()).address : ("0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92" as const);
const [balance, gasPrice] = await Promise.all([rpc.getBalance({ address: from }), rpc.getGasPrice()]);
const gas = 21_000n;
const cost = amount + gas * gasPrice;

console.log(`\npayer        ${from}`);
console.log(`pays         ${formatEther(amount)} BNB to ${to}`);
console.log(`gas          ${gas} at ${Number(gasPrice) / 1e9} gwei = ${formatEther(gas * gasPrice)} BNB`);
console.log(`needs        ${formatEther(cost)} BNB`);
console.log(`balance      ${formatEther(balance)} BNB`);

if (balance < cost) {
  console.log(`\nShort by ${formatEther(cost - balance)} BNB. Top up ${from} and run again.\n`);
  process.exit(1);
}
if (!SEND) {
  console.log(`\nDry run. The balance covers it; nothing was sent. Add -- --send to pay.\n`);
  process.exit(0);
}
if (!hasAdminKey()) {
  console.error(`\nNo admin key. Put one in ${KEY_FILE} or set KAWAL_ADMIN_KEY.\n`);
  process.exit(1);
}

const { createWalletClient, http } = await import("viem");
const { bsc } = await import("viem/chains");
const wallet = createWalletClient({ account: privateKeyToAccount(adminKey()), chain: bsc, transport: http() });

const hash: Hex = await wallet.sendTransaction({ to, value: amount, gas });
console.log(`\nsent ${explorerTx(BSC_MAINNET, hash) ?? hash}`);
const receipt = await rpc.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") {
  console.error(`The transfer reverted. Nothing was paid.\n`);
  process.exit(1);
}

// The server refuses fewer than three confirmations, so wait for them here
// rather than being told to come back.
process.stdout.write(`waiting for ${CONFIRMATIONS} confirmations`);
for (;;) {
  const head = await rpc.getBlockNumber();
  if (head - receipt.blockNumber >= CONFIRMATIONS) break;
  process.stdout.write(".");
  await new Promise((r) => setTimeout(r, 1500));
}
console.log();

console.log(`GET ${URL_}  PAYMENT-SIGNATURE: ${hash}`);
await show(await fetch(URL_, { headers: { accept: "application/json", "payment-signature": hash } }));
