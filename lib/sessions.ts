/**
 * The live session ledger.
 *
 * `lib/onchain.ts` grants sessions and writes them here; the control room
 * reads them back so a user can see what each agent may do and take it away.
 * Revocation is the half of the promise that a planning screen cannot make:
 * "limits they can't cross" is only true if crossing back is possible.
 *
 * Server-only. The file holds session private keys, so nothing here may be
 * imported into a client component.
 */

import "server-only";
import { signerFromPrivateKey } from "@altananetwork/sdk";
import { clientFor } from "./altana.ts";
import {
  adminKey,
  hasAdminKey,
  readLedger,
  loadLedger,
  mutateLedger,
  isLive,
  MissingAdminKeyError,
  type LedgerSeat,
} from "./vault.ts";

// The on-disk shape and its readers live in lib/vault.ts, which the CLI
// scripts share. Re-exported here so the UI has one import for "the control
// room's state" rather than reaching past this module for half of it.
export { readLedger, loadLedger, isLive, hasAdminKey, MissingAdminKeyError, type LedgerSeat };

/**
 * What the mandated wallet is actually holding, next to what the seats are
 * allowed to spend.
 *
 * The control room showed caps and nothing else, which reads as far more
 * authority than exists: "0.0035 BNB per day" against a wallet holding
 * 0.0009 is a cap no seat can ever reach. A spend cap is a ceiling, and a
 * ceiling without the floor next to it tells you almost nothing.
 *
 * Returns null rather than throwing — a wallet whose balance cannot be read
 * is a worse page, not a broken one.
 */
export async function walletHoldings(
  chainId: number,
  address: `0x${string}`,
): Promise<{ native: bigint } | null> {
  try {
    const client = clientFor(chainId);
    const { native } = await client.balances({ wallet: address, chainId });
    return { native };
  } catch {
    return null;
  }
}

/**
 * Revokes one seat's session on-chain, then records what happened.
 *
 * The ledger is written whether the revoke confirms or not. A revoke that
 * silently failed while the UI showed the seat as gone would be the single
 * most dangerous bug this product could have, so a failure is recorded and
 * the seat stays visibly live.
 */
export async function revokeSeat(publicKey: string): Promise<LedgerSeat | null> {
  // Read outside the lock: the chain call below takes seconds, and holding a
  // lock across it would stall every other writer for the whole transaction.
  const seat = (await loadLedger()).find((s) => s.publicKey === publicKey);
  if (!seat) return null;
  if (seat.revokedAt) return seat;

  const client = clientFor(seat.chainId);
  const signer = signerFromPrivateKey(adminKey());

  let revokedAt: number | undefined;
  let revokeTx: LedgerSeat["revokeTx"];
  let revokeError: string | undefined;

  try {
    // The public key alone, never `sessionFromSeat`. The SDK revokes by
    // `keccak256(publicKey)` and takes a bare key for exactly this case; the
    // deployed ledger arrives with `sessionPrivateKey` stripped to "0x" by
    // `ledger:push`, and rebuilding a signer from that threw before the
    // revoke was ever sent — the one button the control room exists for.
    const result = await client.revokeSession({
      wallet: { address: seat.walletAddress },
      signer,
      session: seat.publicKey,
      chainId: seat.chainId,
    });

    if (result.status === "FAILED") {
      revokeError = `revoke transaction failed (${result.callsId})`;
    } else {
      revokedAt = Math.floor(Date.now() / 1000);
      revokeTx = result.transactionHash;
    }
  } catch (e) {
    revokeError = e instanceof Error ? e.message : String(e);
  }

  // Re-read inside the lock and apply the outcome to that copy. Writing back
  // the snapshot taken before the chain call would silently undo anything the
  // preempt script changed while the transaction was in flight.
  return mutateLedger((seats) => {
    const fresh = seats.find((s) => s.publicKey === publicKey);
    if (!fresh) return null;

    if (revokedAt !== undefined) {
      fresh.revokedAt = revokedAt;
      if (revokeTx) fresh.revokeTx = revokeTx;
      delete fresh.revokeError;
    } else if (revokeError !== undefined) {
      fresh.revokeError = revokeError;
    }

    return fresh;
  });
}
