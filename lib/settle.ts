import "server-only";
import { formatEther, type Address, type Hex } from "viem";
import { publicClientFor } from "./rpc.ts";
import { BSC_MAINNET } from "./chains.ts";
import { openStore, type Store } from "./db.ts";
import { payTo, PRICE_WEI } from "./x402.terms.ts";

/**
 * Taking the payment the challenge asked for.
 *
 * The terms live in `x402.terms.ts`, which is pure and checkable offline. This
 * half touches a store and the chain, so it is server-only and tested against
 * a running instance instead.
 *
 * Settlement is deliberately the dullest possible mechanism. No facilitator,
 * no signature scheme, no allowance: the caller sends a plain BNB transfer and
 * resends the request carrying the transaction hash, and Kawal reads the
 * chain. A facilitator-based flow would mean running one or trusting someone
 * else's, and a scheme Kawal cannot verify end to end is exactly the kind of
 * unbacked payment claim this whole feature exists to be the opposite of.
 * Reading a receipt on the chain the payment happened on is something anyone
 * can reproduce.
 *
 * The spent-hash ledger goes through `lib/db.ts`, so on a host without a
 * disk it is the shared database rather than a file that resets on every
 * cold start. That matters more here than for the probe history: a ledger
 * that resets is a ledger that accepts the same receipt twice.
 */

/**
 * Confirmations required before a receipt counts.
 *
 * BSC finalises fast, but a transfer read at zero confirmations can still be
 * reorganised away, and this hands over a report in exchange for it.
 */
const MIN_CONFIRMATIONS = 3n;

function file() {
  return process.env.KAWAL_PAYMENTS_DB ?? ".kawal-payments.db";
}

let ready: Promise<Store | null> | null = null;

async function open(): Promise<Store | null> {
  if (!ready) {
    ready = (async () => {
      const store = await openStore(file());
      if (!store) return null;
      try {
        await store.exec(`
          CREATE TABLE IF NOT EXISTS spent (
            tx_hash    TEXT PRIMARY KEY,
            payer      TEXT NOT NULL,
            amount_wei TEXT NOT NULL,
            spent_at   INTEGER NOT NULL
          )
        `);
        return store;
      } catch {
        return null;
      }
    })();
  }
  return ready;
}

export type Settlement =
  | { paid: true; payer: Address; amountWei: bigint; txHash: Hex }
  | { paid: false; reason: string };

/**
 * Verifies one claimed payment against the chain.
 *
 * Every branch here refuses rather than assumes. The failure mode being
 * guarded is not a caller who mistypes a hash — it is one who finds any
 * transaction on BSC that happens to touch this address and offers it as
 * theirs, so the amount, the recipient, the status and the confirmation depth
 * are all checked against the receipt rather than against the claim.
 */
export async function settle(txHash: string): Promise<Settlement> {
  const to = payTo();
  if (!to) return { paid: false, reason: "this instance has no wallet, so nothing is for sale" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { paid: false, reason: "X-PAYMENT must be a transaction hash" };

  const hash = txHash.toLowerCase() as Hex;

  const store = await open();
  if (!store) return { paid: false, reason: "the payment ledger is unreadable; refusing to accept" };

  // Checked before the chain read: a spent receipt must be refused even if the
  // node is slow or unavailable.
  const already = await store.get("SELECT tx_hash FROM spent WHERE tx_hash = ?", [hash]);
  if (already) return { paid: false, reason: "that transaction has already been used" };

  const rpc = publicClientFor(BSC_MAINNET);

  let tx, receipt;
  try {
    [tx, receipt] = await Promise.all([
      rpc.getTransaction({ hash }),
      rpc.getTransactionReceipt({ hash }),
    ]);
  } catch {
    return { paid: false, reason: "no such transaction on BNB Smart Chain, or it has not been mined" };
  }

  if (receipt.status !== "success") return { paid: false, reason: "that transaction reverted" };
  if ((tx.to ?? "").toLowerCase() !== to.toLowerCase()) {
    return { paid: false, reason: `that transaction did not pay ${to}` };
  }
  if (tx.value < PRICE_WEI) {
    return { paid: false, reason: `that transaction paid ${formatEther(tx.value)} BNB; the price is ${formatEther(PRICE_WEI)} BNB` };
  }

  const head = await rpc.getBlockNumber();
  if (head - receipt.blockNumber < MIN_CONFIRMATIONS) {
    return {
      paid: false,
      reason: `only ${head - receipt.blockNumber} confirmation(s); ${MIN_CONFIRMATIONS} are needed`,
    };
  }

  try {
    // The primary key is the guard: two requests racing on one receipt both
    // pass the SELECT above, and only one of these inserts succeeds.
    const { changes } = await store.run(
      "INSERT OR IGNORE INTO spent (tx_hash, payer, amount_wei, spent_at) VALUES (?, ?, ?, ?)",
      [hash, tx.from.toLowerCase(), tx.value.toString(), Math.floor(Date.now() / 1000)],
    );
    if (changes !== 1) return { paid: false, reason: "that transaction has already been used" };
  } catch {
    // Losing the race must not hand out a second report for one payment.
    return { paid: false, reason: "that transaction has already been used" };
  }

  return { paid: true, payer: tx.from, amountWei: tx.value, txHash: hash };
}
