/**
 * Registers Kawal itself in the ERC-8004 Identity Registry on BSC.
 *
 * Run: npm run register                   dry run — simulates, sends nothing
 *      npm run register -- --send         mints the registration
 *      npm run register -- --origin URL   the deployed origin (default below)
 *
 * Kawal has spent this project reading other people's registrations and
 * refusing to take them at their word. The honest end of that is to hold one
 * itself and let its own prober judge it: a registration Kawal could not
 * verify would be the thing it exists to catch. Once minted it appears in
 * 8004scan and therefore in Kawal's own catalogue, where the same code that
 * dials everybody else dials it.
 *
 * The call is `register(string agentURI)`, found by simulating the reference
 * signatures against the live contract rather than trusting a document: it
 * is the one that estimates rather than reverts. The URI is the registration
 * document the deployed site serves, which the registry stores verbatim and
 * 8004scan resolves.
 *
 * One transaction, gas only — the registry charges no fee — and this machine
 * must hold the admin key, because the token is minted to the sender and that
 * is the wallet every other proof here is made from.
 */

export {};

import { formatEther, parseAbi, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { publicClientFor } from "../lib/rpc.ts";
import { adminKey, hasAdminKey, KEY_FILE } from "../lib/vault.ts";
import { explorerTx } from "../lib/altana.ts";
import { BSC_MAINNET } from "../lib/chains.ts";

const SEND = process.argv.includes("--send");
const originArg = process.argv.indexOf("--origin");
const ORIGIN = originArg > -1 ? process.argv[originArg + 1]! : "https://kawal-three.vercel.app";
const URI = `${ORIGIN}/.well-known/agent-registration.json`;
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
const RECORD = ".kawal-registration.json";

const ABI = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

console.log(`Kawal → ERC-8004 Identity Registry, BSC mainnet`);
console.log(SEND ? "MODE: sending\n" : "MODE: dry run (add -- --send to mint)\n");

if (existsSync(RECORD)) {
  const prior = JSON.parse(readFileSync(RECORD, "utf8")) as { tokenId: string; txHash: string; at: string };
  console.log(`Already registered: token ${prior.tokenId} at ${prior.at}`);
  console.log(`  ${explorerTx(BSC_MAINNET, prior.txHash as `0x${string}`)}`);
  console.log(`Delete ${RECORD} to register again (which would mint a second token).\n`);
  process.exit(0);
}

// The document must resolve before the URI is written on-chain for good:
// 8004scan parses it at index time, and a registration whose URI 404s is one
// more of the broken kind this project catalogues.
const doc = await fetch(URI, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
if (!doc || !doc.ok) {
  console.error(`The registration document does not resolve: ${URI} -> ${doc?.status ?? "no response"}`);
  console.error(`Deploy first, or pass --origin.\n`);
  process.exit(1);
}
const parsed = (await doc.json()) as { type?: string; name?: string; services?: Array<{ name: string; endpoint: string }> };
if (parsed.type !== "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" || parsed.name !== "Kawal") {
  console.error(`The document at ${URI} is not Kawal's registration-v1 document.\n`);
  process.exit(1);
}
console.log(`document     ${URI}`);
console.log(`services     ${(parsed.services ?? []).map((s) => `${s.name} → ${s.endpoint}`).join("\n             ")}\n`);

const rpc = publicClientFor(BSC_MAINNET);
const from = hasAdminKey()
  ? privateKeyToAccount(adminKey()).address
  : ("0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92" as const);

const [gasEstimate, gasPrice, balance] = await Promise.all([
  rpc.estimateContractGas({ account: from, address: IDENTITY, abi: ABI, functionName: "register", args: [URI] }),
  rpc.getGasPrice(),
  rpc.getBalance({ address: from }),
]);
const gas = (gasEstimate * 110n) / 100n;
const cost = gas * gasPrice;

console.log(`registry     ${IDENTITY}`);
console.log(`gas          ${gasEstimate} estimated, ${gas} with headroom, at ${Number(gasPrice) / 1e9} gwei`);
console.log(`cost         ${formatEther(cost)} BNB`);
console.log(`wallet       ${from}`);
console.log(`balance      ${formatEther(balance)} BNB`);

if (balance < cost) {
  console.error(`\nShort by ${formatEther(cost - balance)} BNB. Top up the wallet and run again.\n`);
  process.exit(1);
}

if (!SEND) {
  console.log(`\nDry run. The registry accepts this call; nothing was sent.`);
  console.log(`Re-run with \`npm run register -- --send\` to mint.\n`);
  process.exit(0);
}

if (!hasAdminKey()) {
  console.error(`\nNo admin key. Put one in ${KEY_FILE} or set KAWAL_ADMIN_KEY.\n`);
  process.exit(1);
}

const { createWalletClient, http } = await import("viem");
const { bsc } = await import("viem/chains");
const account = privateKeyToAccount(adminKey());
const wallet = createWalletClient({ account, chain: bsc, transport: http() });

const hash = await wallet.writeContract({ address: IDENTITY, abi: ABI, functionName: "register", args: [URI], gas });
console.log(`\nsent ${explorerTx(BSC_MAINNET, hash) ?? hash}`);
const receipt = await rpc.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") {
  console.error(`The transaction reverted. Nothing was minted.\n`);
  process.exit(1);
}

// The token id is in the mint event, from the zero address to us.
let tokenId: string | null = null;
for (const log of receipt.logs) {
  try {
    const ev = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
    if (ev.eventName === "Transfer" && ev.args.to.toLowerCase() === account.address.toLowerCase()) {
      tokenId = ev.args.tokenId.toString();
    }
  } catch {
    // Not our event.
  }
}

writeFileSync(RECORD, JSON.stringify({ tokenId, txHash: hash, uri: URI, at: new Date().toISOString() }, null, 2));
console.log(`\nKawal is agent ${tokenId ?? "(id not decoded — see the receipt)"} on BSC.`);
console.log(`8004scan indexes the registry; once it has, the catalogue here lists Kawal and dials it like anybody else.`);
console.log(`  https://8004scan.io/agents/56/${tokenId ?? ""}\n`);
