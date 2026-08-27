/**
 * Executes a preemption on-chain: the risk officer narrowing the allocator.
 *
 * Run: npm run preempt            (dry run — prints the plan, sends nothing)
 *      npm run preempt -- --send  (revokes and re-grants for real)
 *
 * `lib/mandate.ts` has always been able to *describe* a preemption, and
 * `/mandate` renders it. Describing it is the easy half. Altana has no "amend
 * a session" call, so narrowing a seat means revoking its key and granting a
 * new one — and KeyStore revocation is monotonic, so the old key is gone the
 * moment the first transaction lands.
 *
 * That ordering is the whole risk: between revoke and re-grant the allocator
 * holds no authority at all. If the wallet runs dry in the gap, the seat stays
 * dead. So the balance for the *entire* cycle is checked before anything is
 * sent, and every step is written to the ledger as it happens rather than at
 * the end, so a failure halfway is visible instead of silent.
 */

import { formatEther } from "viem";
import { signerFromPrivateKey, createPrivateKeySigner } from "@altananetwork/sdk";
import { clientFor, explorerTx, explorerAddress, sessionFromSeat } from "../lib/altana.ts";
import { preempt, UnsafeMandateError } from "../lib/mandate.ts";
import { chainName } from "../lib/chains.ts";
import { publicClientFor, cycleCost } from "../lib/rpc.ts";
import {
  adminKey,
  readLedger,
  writeLedger,
  withLedgerLock,
  isLive,
  SESSION_FILE,
  type LedgerSeat,
} from "../lib/vault.ts";

/** How far the allocator's cap is cut. Matches what /mandate renders. */
const FACTOR = 0.25;
const REASON = "health factor fell below the 1.40 floor";

const send = process.argv.includes("--send");

const ledger: LedgerSeat[] = readLedger();
if (ledger.length === 0) {
  console.error(`No ${SESSION_FILE}. Run \`npm run onchain -- mainnet\` first.`);
  process.exit(1);
}

const caller = ledger.find((s) => s.category === "health" && isLive(s));
const target = ledger.find((s) => s.category === "yield" && isLive(s));

if (!caller || !target) {
  console.error("Preemption needs a live risk officer and a live allocator.");
  console.error(
    `  risk officer: ${caller ? "live" : "missing"}   allocator: ${target ? "live" : "missing"}`,
  );
  process.exit(1);
}

const chainId = target.chainId;
const rpc = publicClientFor(chainId);

// Rebuild the plan shapes `preempt` expects from what was actually granted.
const plans = [caller, target].map((s) => ({
  category: s.category,
  seat: s.seat,
  priority: s.priority,
  expiry: s.expiry,
  explain: s.explain,
  permissions: {
    calls: s.allowlist.map((to) => ({ to })),
    spend: [{ limit: BigInt(s.spendLimit), period: s.spendPeriod as "day" }],
  },
}));

let cut;
try {
  cut = preempt(plans, "health", "yield", FACTOR, REASON);
} catch (e) {
  console.error(
    e instanceof UnsafeMandateError ? `Refused: ${e.message}` : `Failed: ${String(e)}`,
  );
  process.exit(1);
}

const before = BigInt(target.spendLimit);
// `spend![0].limit` asserted twice over: that the array exists and that it
// has a first element. The second assertion is the one that bites — an empty
// array satisfies the first and throws on the second.
const after = cut.narrowed.spend?.[0]?.limit;
if (after === undefined) {
  console.error("Refused: the narrowed session carries no spend cap, which is a wildcard.");
  process.exit(1);
}

console.log(`Preemption on ${chainName(chainId)}`);
console.log(`  ${caller.seat} (priority ${caller.priority}) narrows ${target.seat} (priority ${target.priority})`);
console.log(`  reason      ${REASON}`);
console.log(`  cap         ${formatEther(before)} -> ${formatEther(after)} BNB/${target.spendPeriod}`);
console.log(`  allowlist   ${cut.narrowed.calls?.length ?? 0} contracts, unchanged`);
console.log(`  old key     ${target.publicKey.slice(0, 26)}...\n`);

// --- affordability, checked for the whole cycle before anything is sent ----

const wallet = { address: target.walletAddress };
// One key is registered (the replacement) across two transactions (revoke,
// then grant). Revocation itself is fee-free.
const { fee, gas, total: needed } = await cycleCost(chainId, { keys: 1, transactions: 2 });
const balance = await rpc.getBalance({ address: wallet.address });

console.log(`  revoke costs gas only; the re-grant registers a new key`);
console.log(`  registration ${formatEther(fee)} + gas ${formatEther(gas)} = ${formatEther(needed)} BNB`);
console.log(`  balance      ${formatEther(balance)} BNB\n`);

if (balance < needed) {
  console.error(`Short by ${formatEther(needed - balance)} BNB — refusing to start.`);
  console.error("Revocation is monotonic: stopping between the two steps would");
  console.error("leave the allocator with no authority and no way back.");
  process.exit(1);
}

if (!send) {
  console.log("Dry run. Nothing was sent. Re-run with --send to execute.");
  process.exit(0);
}

// --- execute ---------------------------------------------------------------

/**
 * Applies one change to the ledger as it is on disk right now.
 *
 * The in-memory copy read at startup is stale the moment a transaction is in
 * flight — the control room can revoke a seat in the browser during those
 * seconds. Writing the startup snapshot back would erase that. So each step
 * re-reads under the lock and edits by public key.
 */
function amend(publicKey: string, change: (seat: LedgerSeat) => void) {
  withLedgerLock((seats) => {
    const seat = seats.find((s) => s.publicKey === publicKey);
    if (seat) change(seat);
    writeLedger(seats);
  });
}

const adminSigner = signerFromPrivateKey(adminKey());
const client = clientFor(chainId);

console.log("1/2  revoking the allocator's current session...");
const revoked = await client.revokeSession({
  wallet,
  signer: adminSigner,
  session: sessionFromSeat(target),
  chainId,
});

if (revoked.status === "FAILED") {
  amend(target.publicKey, (seat) => {
    seat.revokeError = `revoke failed (${revoked.callsId})`;
  });
  console.error("     revoke FAILED — the old session is still live, nothing was lost.");
  process.exit(1);
}

amend(target.publicKey, (seat) => {
  seat.revokedAt = Math.floor(Date.now() / 1000);
  // Only set when there is one. Assigning `undefined` to an optional field is
  // not the same as leaving it out, and the difference shows up the moment
  // anything reads the ledger with `in` rather than a truthiness check.
  if (revoked.transactionHash) seat.revokeTx = revoked.transactionHash;
  seat.preemptedBy = caller.category;
});
console.log(`     ${revoked.status}  ${revoked.transactionHash ? explorerTx(chainId, revoked.transactionHash) : ""}`);

console.log("2/2  granting the narrowed session...");
const sessionSigner = createPrivateKeySigner();
const session = await client.grantSession({
  wallet,
  signer: adminSigner,
  chainId,
  permissions: cut.narrowed,
  expiry: target.expiry,
  sessionSigner,
});

// The replacement inherits everything except what happened to the seat it
// replaces. Spreading `target` and then writing `revokedAt: undefined` looked
// equivalent and is not: it sets the key to undefined rather than omitting
// it. That survived only because JSON.stringify drops undefined values — any
// reader asking `"revokedAt" in seat` would have seen the new seat as already
// revoked.
const { revokedAt: _wasRevokedAt, revokeTx: _wasRevokeTx, revokeError: _wasError, ...carried } = target;

const replacement: LedgerSeat = {
  ...carried,
  publicKey: session.publicKey,
  sessionPrivateKey: sessionSigner._privateKey,
  spendLimit: after.toString(),
  grantedAt: Math.floor(Date.now() / 1000),
  explain: `${target.seat} narrowed to ${formatEther(after)} BNB/${target.spendPeriod} after ${REASON}.`,
  supersedes: target.publicKey,
  preemptedBy: caller.category,
};
withLedgerLock((seats) => {
  seats.push(replacement);
  writeLedger(seats);
});

console.log(`     granted  key ${session.publicKey.slice(0, 26)}...`);
console.log(`\nAllocator now capped at ${formatEther(after)} BNB/${target.spendPeriod}, same ${replacement.allowlist.length} contracts.`);
console.log(`wallet ${explorerAddress(chainId, wallet.address)}`);
console.log(`ledger ${SESSION_FILE} — the superseded key is recorded, not deleted.`);

