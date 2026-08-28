import "server-only";
import { formatEther, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { createX402Merchant } from "@altananetwork/x402-server";
import { publicClientFor } from "./rpc.ts";
import { BSC_MAINNET } from "./chains.ts";
import { openStore, type Store } from "./db.ts";
import { memo } from "./memo.ts";
import { adminKey, hasAdminKey } from "./vault.ts";
import { payTo, merchantConfig, PRICE_WEI, QUOTE_TIMEOUT_SECONDS } from "./x402.terms.ts";

/**
 * Taking the payment the challenge asked for.
 *
 * The terms live in `x402.terms.ts`, which is pure and checkable offline. This
 * half touches a store and the chain, so it is server-only and tested against
 * a running instance instead.
 *
 * Two rails, one function. A header that is a bare transaction hash is the
 * native rail: the caller sent a plain BNB transfer and Kawal reads the
 * receipt. Anything else is handed to the Altana x402 SDK as a B402 v2
 * envelope — a signed EIP-3009 or Permit2 authorisation — which Kawal
 * verifies and then settles on-chain itself from a gas-only settler key.
 * Neither rail trusts a third party's word that money moved: the native rail
 * reads a receipt anyone can re-read, and the signed rails are settled by a
 * transaction this instance broadcast and waited for.
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

/**
 * Gas one signed-rail settlement is budgeted at, for deciding whether the
 * settler can afford to advertise. `permitWitnessTransferFrom` on USDT
 * measures around 110k; the headroom is for a busier block.
 */
const SETTLE_GAS = 150_000n;

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

export type Rail = "native-transfer" | "eip3009" | "permit2-exact";

export type Settlement =
  | { paid: true; rail: Rail; payer: Address; amount: bigint; asset: string; txHash: Hex }
  | { paid: false; reason: string };

/* ------------------------------------------------------------ settler ---
 *
 * The signed rails need somebody to broadcast the settlement and pay its
 * gas. The SDK calls that account the facilitator; it never holds funds —
 * the buyer's signature binds the recipient — so a dedicated gas-only key
 * (`KAWAL_FACILITATOR_KEY`) is the deployment shape, and the admin key serves
 * on a machine that has one.
 */

function settlerKey(): Hex | null {
  const dedicated = process.env.KAWAL_FACILITATOR_KEY;
  if (dedicated && /^0x[0-9a-fA-F]{64}$/.test(dedicated)) return dedicated as Hex;
  if (!hasAdminKey()) return null;
  try {
    return adminKey();
  } catch {
    return null;
  }
}

function settlerAccount(): PrivateKeyAccount | null {
  const key = settlerKey();
  if (!key) return null;
  try {
    return privateKeyToAccount(key);
  } catch {
    return null;
  }
}

/** How long the "can the settler pay gas" answer is reused. */
const SETTLER_TTL_MS = 300_000;

/**
 * The settler to advertise, or null.
 *
 * A rail is only put on the challenge when the account that would settle it
 * exists here and holds enough BNB for one settlement at the current gas
 * price. Memoised: this is read on every 402, and a balance check per
 * request would be a chain read per unpaid visitor.
 */
export function advertisedSettler(): Promise<Address | null> {
  return memo("x402:settler", SETTLER_TTL_MS, async () => {
    const account = settlerAccount();
    if (!account) return null;
    const rpc = publicClientFor(BSC_MAINNET);
    const [balance, gasPrice] = await Promise.all([
      rpc.getBalance({ address: account.address }),
      rpc.getGasPrice(),
    ]);
    return balance >= gasPrice * SETTLE_GAS ? account.address : null;
  });
}

/** What the settler check found, spelled out for the dry-run scripts. */
export async function settlerStatus(): Promise<{ address: Address | null; balance: bigint; needed: bigint }> {
  const account = settlerAccount();
  const rpc = publicClientFor(BSC_MAINNET);
  const gasPrice = await rpc.getGasPrice();
  const needed = gasPrice * SETTLE_GAS;
  if (!account) return { address: null, balance: 0n, needed };
  return { address: account.address, balance: await rpc.getBalance({ address: account.address }), needed };
}

let merchant: ReturnType<typeof createX402Merchant> | null = null;

/**
 * One merchant per process: it keeps an in-flight replay guard, and the
 * on-chain nonce burn is the durable one behind it.
 */
function merchantFor(to: Address, settler: PrivateKeyAccount) {
  if (!merchant) {
    const rpc = publicClientFor(BSC_MAINNET);
    // The transport was built from a URL in lib/rpc.ts; the SDK wants the
    // string back rather than a client, so it is read off the transport
    // instead of being written down a second time.
    const rpcUrl = (rpc.transport as { url?: string }).url;
    if (!rpcUrl) throw new Error("the BSC transport has no URL to hand the x402 merchant");
    merchant = createX402Merchant({
      ...merchantConfig(to, settler.address),
      facilitator: settler,
      rpcUrl,
      chain: bsc,
    });
  }
  return merchant;
}

/**
 * Settles a signed B402 envelope through the SDK's verify-then-broadcast
 * path. The SDK answers 402 with a sentence for every refusal — wrong token,
 * amount under the price, recipient mismatch, expired window, bad signature,
 * reverted settlement — and that sentence is what the caller sees.
 */
async function settleSigned(header: string, to: Address): Promise<Settlement> {
  const settler = settlerAccount();
  if (!settler) {
    return { paid: false, reason: "no settler key on this instance, so the signed x402 rails are not for sale here; pay the native rail" };
  }
  const store = await open();
  if (!store) return { paid: false, reason: "the payment ledger is unreadable; refusing to accept" };

  const result = await merchantFor(to, settler).requirePayment(header);
  if (result.status !== 200) {
    return { paid: false, reason: typeof result.body.error === "string" ? result.body.error : "payment rejected" };
  }
  const { receipt } = result;

  // The settlement transaction is Kawal's own and cannot be replayed — the
  // nonce burned on-chain — but it is banked beside the native receipts so
  // the ledger is one list of everything that ever bought a report.
  try {
    await store.run(
      "INSERT OR IGNORE INTO spent (tx_hash, payer, amount_wei, spent_at) VALUES (?, ?, ?, ?)",
      [receipt.txHash.toLowerCase(), receipt.payer.toLowerCase(), receipt.amount.toString(), Math.floor(Date.now() / 1000)],
    );
  } catch {
    // The money moved; a ledger write failing must not turn a paid request
    // into a refused one.
  }

  return {
    paid: true,
    rail: receipt.rail === "eip3009" ? "eip3009" : "permit2-exact",
    payer: receipt.payer,
    amount: receipt.amount,
    asset: receipt.token,
    txHash: receipt.txHash,
  };
}

/** Base64 of a JSON object carrying a `payload`, which is what every B402 buyer sends. */
function looksLikeEnvelope(header: string): boolean {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && "payload" in parsed;
  } catch {
    return false;
  }
}

/**
 * Verifies one claimed payment against the chain.
 *
 * Every branch here refuses rather than assumes. The failure mode being
 * guarded is not a caller who mistypes a hash — it is one who finds any
 * transaction on BSC that happens to touch this address and offers it as
 * theirs, so the amount, the recipient, the status, the confirmation depth
 * and the age are all checked against the receipt rather than against the
 * claim.
 */
export async function settle(header: string): Promise<Settlement> {
  const to = payTo();
  if (!to) return { paid: false, reason: "this instance has no wallet, so nothing is for sale" };

  const trimmed = header.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    // Not a hash. A base64 JSON envelope is the other thing the header can
    // legitimately carry; anything else is neither and is refused as such.
    if (looksLikeEnvelope(trimmed)) return settleSigned(trimmed, to);
    return { paid: false, reason: "PAYMENT-SIGNATURE (or X-PAYMENT) must be a transaction hash on the native rail, or a signed x402 envelope on the others" };
  }

  const hash = trimmed.toLowerCase() as Hex;

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

  const [head, block] = await Promise.all([
    rpc.getBlockNumber(),
    rpc.getBlock({ blockNumber: receipt.blockNumber }),
  ]);
  if (head - receipt.blockNumber < MIN_CONFIRMATIONS) {
    return {
      paid: false,
      reason: `only ${head - receipt.blockNumber} confirmation(s); ${MIN_CONFIRMATIONS} are needed`,
    };
  }

  // The challenge advertises `maxTimeoutSeconds`, so it is held to it: a
  // transfer mined longer ago than the quote lasted is a stale payment, not a
  // current one. Measured from the block the chain stamped, not from when the
  // header arrived.
  const age = BigInt(Math.floor(Date.now() / 1000)) - block.timestamp;
  if (age > BigInt(QUOTE_TIMEOUT_SECONDS)) {
    return {
      paid: false,
      reason: `that transaction is stale: mined ${age} seconds ago, and a quote is good for ${QUOTE_TIMEOUT_SECONDS} seconds (maxTimeoutSeconds)`,
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

  return { paid: true, rail: "native-transfer", payer: tx.from, amount: tx.value, asset: "BNB", txHash: hash };
}
