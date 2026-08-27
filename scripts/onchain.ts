/**
 * The on-chain proof: grant a real mandate, use it, and show the limits bite.
 *
 * Run: npm run onchain            (BSC testnet)
 *      npm run onchain -- mainnet (BSC mainnet — spends real BNB)
 *
 * A marketplace that only *plans* sessions has proven nothing. This walks the
 * whole path a user's capital would take:
 *
 *   1. an admin wallet, funded by the operator
 *   2. one scoped session per seat, registered in the Altana KeyStore
 *   3. a real transaction sent by a session key, inside its allowlist
 *   4. the same session key refused when it reaches outside that allowlist
 *
 * Step 4 is the one that matters. Steps 1-3 show the sessions work; only step
 * 4 shows they are limits rather than decoration, and it is the difference
 * between "we granted a session" and "the agent cannot exceed it".
 */

import { writeFileSync } from "node:fs";
import { encodeFunctionData, formatEther, type Hex } from "viem";
import { signerFromPrivateKey, createPrivateKeySigner } from "@altananetwork/sdk";
import {
  clientFor,
  grantMandate,
  explorerTx,
  explorerAddress,
  sessionFromSeat,
  type GrantedSeat,
} from "../lib/altana.ts";
import { VENUES } from "../lib/mandate.ts";
import { BSC_MAINNET, BSC_TESTNET } from "../lib/chains.ts";
import { publicClientFor, cycleCost } from "../lib/rpc.ts";
import { adminKey, hasAdminKey, KEY_FILE, SESSION_FILE } from "../lib/vault.ts";

const NETS = {
  testnet: { chainId: BSC_TESTNET, faucet: "https://testnet.bnbchain.org/faucet-smart" },
  mainnet: { chainId: BSC_MAINNET, faucet: "(mainnet — fund this address yourself)" },
} as const;

const which = (process.argv[2] ?? "testnet") as keyof typeof NETS;
const net = NETS[which];
if (!net) {
  console.error(`unknown network "${which}" — expected testnet or mainnet`);
  process.exit(1);
}

/**
 * The mandate ceiling for this run.
 *
 * This is what the seats are *permitted* to spend, not a deposit — a spend
 * cap is a limit, not an escrow, so the wallet never has to hold it. Only the
 * registration fees and the one real transaction below need actual balance.
 */
const CAPITAL = 10_000_000_000_000_000n; // 0.01 BNB
const DURATION_DAYS = 7;
/** How much the execution trader actually wraps. Must sit under its own cap. */
const WRAP = 10_000_000_000_000n; // 0.00001 BNB

// --- admin key ------------------------------------------------------------
// Generated locally and never sent anywhere. Custody follows the signer; the
// Altana relay never sees it.

function loadOrCreateAdminKey(): Hex {
  if (hasAdminKey()) return adminKey();

  // Quietly minting a wallet is fine on testnet and dangerous on mainnet:
  // the operator funds the address they meant to use, and a generated key
  // would send the grants somewhere else entirely.
  if (which === "mainnet") {
    console.error(`No admin key found. On mainnet this is never generated for you.\n`);
    console.error(`Put the private key of the wallet you want to grant from into`);
    console.error(`  ${KEY_FILE}   (one line, 0x-prefixed, gitignored)`);
    console.error(`or set KAWAL_ADMIN_KEY in the environment.\n`);
    process.exit(1);
  }

  const fresh = createPrivateKeySigner();
  writeFileSync(KEY_FILE, fresh._privateKey, { mode: 0o600 });
  console.log(`generated a new admin key -> ${KEY_FILE} (gitignored)\n`);
  return fresh._privateKey;
}

const adminSigner = signerFromPrivateKey(loadOrCreateAdminKey());
const client = clientFor(net.chainId);
const rpc = publicClientFor(net.chainId);

console.log(`Kawal on-chain proof — BSC ${which} (chain ${net.chainId})`);
console.log(`admin signer  ${adminSigner.address}\n`);

const wallet = await client.createWallet({ signer: adminSigner });
console.log(`smart wallet  ${wallet.address}`);

const balance = await rpc.getBalance({ address: wallet.address });
console.log(`balance       ${formatEther(balance)} BNB\n`);

// Each key registered in the KeyStore costs a fee the controller sets itself,
// so ask it rather than carrying a number that quietly goes stale. Five keys
// get registered: the admin key on the wallet's first execute, then one per
// seat.
// Five keys get registered: the admin key on the wallet's first execute, then
// one per seat. Six transactions, at a generous gas allowance each, so a busy
// chain does not strand the run halfway through granting.
const KEYS_TO_REGISTER = 5;
const { fee, gas: gasBudget, total } = await cycleCost(net.chainId, {
  keys: KEYS_TO_REGISTER,
  transactions: 6,
});
const NEEDED = total + WRAP;

console.log(`registration  ${formatEther(fee)} BNB per key x ${KEYS_TO_REGISTER} keys`);
console.log(`gas budget    ${formatEther(gasBudget)} BNB`);
console.log(`needs         ${formatEther(NEEDED)} BNB total\n`);

// Running with too little just burns the first grant and fails the rest
// halfway, so stop before anything is submitted.
if (balance < NEEDED) {
  console.log(`Not enough to run — short by ${formatEther(NEEDED - balance)} BNB.`);
  console.log(`Fund this address, then run again:\n\n  ${wallet.address}\n\n  ${net.faucet}\n`);
  process.exit(1);
}

// --- grant ----------------------------------------------------------------

console.log(`granting a ${DURATION_DAYS}-day mandate over ${formatEther(CAPITAL)} BNB\n`);

const { granted, failures } = await grantMandate({
  client,
  wallet,
  adminSigner,
  mandate: {
    chainId: net.chainId,
    capital: CAPITAL,
    // Native BNB: no `token`, so the spend caps govern BNB itself and the
    // wrap below is actually metered by them.
    durationDays: DURATION_DAYS,
    now: Math.floor(Date.now() / 1000),
  },
  onSeat: (seat, stage, detail) => {
    if (stage === "granting") process.stdout.write(`  ${seat.padEnd(18)} granting... `);
    else if (stage === "granted") console.log(`ok  key ${String(detail).slice(0, 20)}...`);
    else console.log(`FAILED\n      ${detail}`);
  },
});

if (granted.length === 0) {
  console.error("\nno seat was granted — nothing to prove");
  process.exit(1);
}

writeFileSync(SESSION_FILE, JSON.stringify(granted, null, 2), { mode: 0o600 });
console.log(`\n${granted.length}/4 seats granted and registered in KeyStore -> ${SESSION_FILE}`);
if (failures.length) console.log(`failures:\n  ${failures.join("\n  ")}`);

// --- use one ---------------------------------------------------------------

const trader = granted.find((s) => s.category === "grid");
if (!trader) {
  console.error("\nthe execution trader was not granted — cannot run the execution proof");
  process.exit(1);
}

const traderSession = sessionFromSeat(trader);

const wbnb = VENUES.wbnb.deployments[net.chainId]?.address;
if (!wbnb) {
  console.error(`\nWBNB has no proven address on chain ${net.chainId}`);
  process.exit(1);
}

const depositData = encodeFunctionData({
  abi: [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }],
  functionName: "deposit",
});

console.log(`\n--- inside the allowlist ---`);
console.log(`execution trader wraps ${formatEther(WRAP)} BNB at WBNB ${wbnb}`);

const wrapped = await client.execute({
  session: traderSession,
  chainId: net.chainId,
  calls: [{ to: wbnb, value: WRAP, data: depositData }],
});

console.log(`  status ${wrapped.status}`);
if (wrapped.transactionHash) console.log(`  ${explorerTx(net.chainId, wrapped.transactionHash)}`);

// --- and outside it -------------------------------------------------------
// The same key, the same wallet, a target the seat was never granted. This
// must fail, and it must fail because of the allowlist rather than because
// the call itself is malformed — so it is the identical deposit() call.

const offLimits = VENUES["venus.comptroller"].deployments[net.chainId]?.address;

console.log(`\n--- outside the allowlist ---`);
if (!offLimits) {
  console.log("  no second venue on this chain to test against — skipped");
} else {
  console.log(`execution trader tries the same call at Venus ${offLimits}`);
  console.log(`  (its allowlist is ${trader.allowlist.join(", ")})`);
  try {
    const bad = await client.execute({
      session: traderSession,
      chainId: net.chainId,
      calls: [{ to: offLimits, value: 0n, data: depositData }],
    });
    if (bad.status === "FAILED") {
      console.log(`  REFUSED — status ${bad.status}`);
    } else {
      console.error(`  PROBLEM: the call was accepted (status ${bad.status}).`);
      console.error("  A session that can reach outside its allowlist is not a limit.");
      process.exit(1);
    }
  } catch (e) {
    console.log(`  REFUSED — ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

console.log(`\nwallet    ${explorerAddress(net.chainId, wallet.address)}`);
console.log(`sessions  ${SESSION_FILE} (${granted.length} seats, revocable from /mandate)`);

function seatLine(s: GrantedSeat) {
  return `  ${s.seat.padEnd(18)} ${s.allowlist.length} contract(s), cap ${formatEther(BigInt(s.spendLimit))} BNB/${s.spendPeriod}`;
}
console.log(granted.map(seatLine).join("\n"));
