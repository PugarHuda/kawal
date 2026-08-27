/**
 * The two files Kawal keeps on disk, and the only module that names them.
 *
 * The admin key path was written out in four modules and the ledger path in
 * three, which is three chances to typo the location of the key that spends
 * real money. Worse, `LedgerSeat` was declared twice: `preempt.run.ts` wrote
 * `supersedes` and `preemptedBy` onto every replaced seat, while
 * `sessions.ts` — the definition the UI reads through — had never heard of
 * either. The data was on disk and invisible in the product.
 *
 * One shape, one reader, one writer.
 *
 * Deliberately free of `server-only`: the CLI scripts need this too, and the
 * import that keeps secrets out of a client bundle lives in `sessions.ts`
 * where the UI actually enters.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Hex } from "viem";
import type { GrantedSeat } from "./altana.ts";

// The `server-only` package would say this more loudly, but it throws when
// imported outside a React server context and the CLI scripts import this
// module directly. This guard holds in both: Node has no `window`, a browser
// bundle does, and a bundle carrying session private keys should fail at the
// first import rather than ship.
//
// The `node:fs` import above would already break most bundlers. This turns a
// confusing polyfill error into a sentence that says what went wrong.
if (typeof window !== "undefined") {
  throw new Error(
    "lib/vault.ts holds session private keys and must never reach a browser bundle",
  );
}

/**
 * Resolved on every call, never captured at module load.
 *
 * The uptime module learned this the expensive way: a constant read at import
 * time was already pointing at production before a test could redirect it,
 * because static imports hoist. Same shape, same trap, so the same fix.
 */
/**
 * Anchored to the working directory rather than left relative.
 *
 * A bare `.kawal-sessions.json` resolves against whatever CWD the process
 * happens to have, which is the project root for the CLI scripts and not
 * guaranteed to be for a server started from elsewhere — the ledger would
 * simply read as empty and the control room would show nothing, with no error
 * to explain it.
 *
 * Turbopack still warns that a computed path forces it to trace the project.
 * The documented `turbopackIgnore` opt-out was tried and made it worse — six
 * warnings instead of one — so the warning stands, and it is correct: these
 * are runtime state files, a private key and a ledger, and the one outcome
 * that must never happen is either of them being treated as a build input.
 * Nothing here is one.
 */
function resolve(value: string) {
  return isAbsolute(value) ? value : join(process.cwd(), value);
}

export function keyFile() {
  return resolve(process.env.KAWAL_ADMIN_KEY_FILE ?? ".kawal-admin.key");
}

export function sessionFile() {
  return resolve(process.env.KAWAL_SESSION_FILE ?? ".kawal-sessions.json");
}

/** Kept for messages that name the default location to an operator. */
export const KEY_FILE = ".kawal-admin.key";
export const SESSION_FILE = ".kawal-sessions.json";

/**
 * A granted seat plus everything that has happened to it since.
 *
 * Seats are never deleted. A revoked key stays in the ledger because the
 * record of what an agent was once allowed to do is worth more than a tidy
 * list — and because KeyStore revocation is monotonic, so the row is the only
 * remaining trace.
 */
export type LedgerSeat = GrantedSeat & {
  revokedAt?: number;
  revokeTx?: Hex;
  /** Set when a revoke was attempted and did not confirm. */
  revokeError?: string;
  /** On a replacement seat: the public key it was granted to supersede. */
  supersedes?: Hex;
  /** Which seat's priority forced the narrowing. */
  preemptedBy?: string;
};

export function readLedger(): LedgerSeat[] {
  if (!existsSync(sessionFile())) return [];
  try {
    const parsed = JSON.parse(readFileSync(sessionFile(), "utf8"));
    return Array.isArray(parsed) ? (parsed as LedgerSeat[]) : [];
  } catch {
    // A corrupt ledger must not take the whole page down — an empty control
    // room is recoverable, a crashed one is not.
    return [];
  }
}

/**
 * Replaces the ledger in one step that either happens or does not.
 *
 * `writeFileSync` truncates the target and then writes into it. A crash, a
 * full disk or a killed process between those two leaves a truncated file —
 * and this file holds five session private keys that exist nowhere else. The
 * sessions would stay live on-chain with nothing left able to drive or revoke
 * them.
 *
 * Writing to a sibling and renaming makes the swap atomic: readers see either
 * the old file or the new one, never a half-written one. The `fsync` before
 * the rename is what makes that true after a power loss rather than only
 * after a process crash.
 */
export function writeLedger(seats: LedgerSeat[]) {
  const target = sessionFile();
  const temp = `${target}.tmp`;

  writeFileSync(temp, JSON.stringify(seats, null, 2), { mode: 0o600 });

  const handle = openSync(temp, "r+");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }

  renameSync(temp, target);
}

/** A lock older than this is assumed abandoned by a dead process. */
const LOCK_STALE_MS = 30_000;

/**
 * Runs a read-modify-write against the ledger with nobody else in the middle.
 *
 * Both writers do the same dance — read every seat, change one, write them all
 * back — and without a lock the second overwrites the first. Demonstrated, not
 * assumed: two concurrent writers left one seat where two were added.
 *
 * The scenario that makes it matter: an operator clicks Revoke in the browser
 * while `npm run preempt -- --send` is running. The revoke lands on-chain and
 * cannot be undone, but the ledger loses the record — so the control room goes
 * on showing a dead seat as live, and the next click spends gas revoking a key
 * that is already gone.
 *
 * `wx` fails if the lock exists, which is the whole mechanism: creating the
 * file *is* acquiring the lock, with no gap between checking and taking.
 */
export function withLedgerLock<T>(mutate: (seats: LedgerSeat[]) => T): T {
  const lock = `${sessionFile()}.lock`;
  const until = Date.now() + LOCK_STALE_MS;
  let handle: number | null = null;

  for (;;) {
    try {
      handle = openSync(lock, "wx");
      break;
    } catch {
      // A lock left behind by a process that died would otherwise block every
      // future write forever, so age it out rather than trusting it.
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        // The holder released it between our open and our stat. Try again.
        continue;
      }
      if (Date.now() > until) {
        throw new Error(`ledger is locked by another process; ${lock} has not cleared`);
      }
      // Busy-wait deliberately: this is synchronous by necessity — the callers
      // are a server action and a CLI script, and an async lock would let the
      // same process interleave two mutations against one snapshot.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  try {
    const result = mutate(readLedger());
    return result;
  } finally {
    closeSync(handle);
    try {
      unlinkSync(lock);
    } catch {
      // Already gone: nothing to release.
    }
  }
}

/** A seat is live only if it was never revoked and has not run out. */
export function isLive(seat: LedgerSeat, now = Math.floor(Date.now() / 1000)) {
  return !seat.revokedAt && seat.expiry > now;
}

export class MissingAdminKeyError extends Error {}

/**
 * The key that owns the wallet.
 *
 * Environment first so a deployment can keep it out of the filesystem
 * entirely; the gitignored file is the local-operator path. Never logged,
 * never returned anywhere it could reach a response body.
 */
export function adminKey(): Hex {
  const fromEnv = process.env.KAWAL_ADMIN_KEY;
  if (fromEnv) return fromEnv as Hex;
  if (!existsSync(keyFile())) {
    throw new MissingAdminKeyError(
      `no admin key on this machine — set KAWAL_ADMIN_KEY or create ${keyFile()}`,
    );
  }
  return readFileSync(keyFile(), "utf8").trim() as Hex;
}

export function hasAdminKey() {
  return Boolean(process.env.KAWAL_ADMIN_KEY) || existsSync(keyFile());
}
