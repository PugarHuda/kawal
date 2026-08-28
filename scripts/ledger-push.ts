/**
 * Copies the seat ledger from this machine to the deployed site's database.
 *
 * Run: npm run ledger:push     (needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN)
 *
 * The mandate was granted from here, so the ledger lives here. The deployed
 * control room reads it from the shared database, and without this copy it
 * would show no seats for a mandate that is live on-chain.
 *
 * Session private keys do not travel. The deployed site reads seats and
 * revokes them with the admin key; it never drives one, so it never needs a
 * seat's key, and a key that is not there cannot leak from there. The field
 * is set to a marker rather than removed so the shape stays one shape.
 */

export {};

import { readLedger, replaceRemoteLedger, isLive, type LedgerSeat } from "../lib/vault.ts";
import { isRemote } from "../lib/db.ts";

if (!isRemote()) {
  console.error("No remote ledger is configured. Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) and run again.");
  console.error("`vercel env pull .env.local` writes them after the Turso integration is installed.\n");
  process.exit(1);
}

const local = readLedger();
if (local.length === 0) {
  console.log("The local ledger is empty; nothing to push.");
  process.exit(0);
}

const redacted: LedgerSeat[] = local.map((seat) => ({
  ...seat,
  // Not a key, and cannot be mistaken for one by anything that tries to sign.
  sessionPrivateKey: "0x" as LedgerSeat["sessionPrivateKey"],
}));

await replaceRemoteLedger(redacted);

const live = redacted.filter((s) => isLive(s)).length;
console.log(`pushed ${redacted.length} seat(s), ${live} live, session keys stripped`);
for (const s of redacted) {
  console.log(`  ${s.seat.padEnd(18)} ${s.revokedAt ? "revoked" : isLive(s) ? "live" : "expired"}`);
}
