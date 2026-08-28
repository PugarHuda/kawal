/**
 * A token bucket per caller, for the endpoints that fetch on a caller's
 * behalf.
 *
 * `/api/mcp`, `/api/a2a` and `/api/report` each turn one inbound request into
 * outbound calls at other people's servers, `/compare` and an agent page turn
 * one into a probe apiece, and `/owner` turns one into as many as two dozen.
 * Without a ceiling, anyone can point a loop at Kawal and have it dial the
 * whole roster on their behalf — an amplifier with Kawal's name on the
 * traffic. The memo layer blunts this for repeated targets and does nothing
 * for a caller who varies them.
 *
 * Two stores for the same bucket. In memory, per process, which is exact and
 * free; and, when `TURSO_DATABASE_URL` is set, one row per bucket in the same
 * libSQL database the probe history lives in, so every instance Vercel spins
 * up draws from one ceiling instead of each keeping its own. The arithmetic
 * happens inside a single upsert, which is what makes two instances taking a
 * token at the same instant count as two rather than one. If the database
 * cannot be reached the in-memory bucket takes over — a limiter that fails
 * open on its own outage is the right way round, since the alternative is a
 * site that refuses everyone whenever its database blinks.
 */

import { openStore, isRemote, type Store } from "./db.ts";

export type Limit = {
  /** Requests a caller may make in a burst. */
  capacity: number;
  /** Requests per second the bucket refills at. */
  perSecond: number;
};

/**
 * The suite runs two hundred tests from one address, most of which dial
 * /api/mcp and /api/a2a, and would trip the production ceiling that exists
 * for exactly that shape of caller. The ceilings scale by this factor so the
 * test server can be loosened without changing what a deployment enforces;
 * unset, it is 1, and the outage server leaves it unset so the 429 test
 * still proves the ceiling is real.
 */
const SCALE = Math.max(1, Number(process.env.KAWAL_RATE_SCALE) || 1);

export const LIMITS: Record<"api" | "owner" | "page", Limit> = {
  // One a second with a minute's burst: more than any client needs and far
  // less than a loop wants.
  api: { capacity: 60 * SCALE, perSecond: 1 * SCALE },
  // Each lookup fans out to every agent an owner holds, so this is tighter.
  owner: { capacity: 20 * SCALE, perSecond: SCALE / 3 },
  // One probe per view, memoised for a minute per endpoint, so a page costs
  // at most one outbound call. Loose enough that a person clicking through
  // never meets it; tight enough that walking 288,000 token ids takes a
  // caller a week, and Kawal dials at most two strangers a second on their
  // behalf while they try.
  page: { capacity: 120 * SCALE, perSecond: 2 * SCALE },
};

type Bucket = { tokens: number; at: number };

const buckets = new Map<string, Bucket>();

/**
 * Buckets are dropped wholesale past this many rather than expired one by
 * one. A caller who has not been seen since the map filled is back to a full
 * bucket, which is the generous direction to fail in.
 */
const MAX_BUCKETS = 10_000;

export type Decision = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Takes one token for `key` under `limit`, or says how long until one exists.
 *
 * `now` is a parameter so the offline suite can move time rather than wait.
 */
export function take(key: string, limit: Limit, now = Date.now()): Decision {
  if (buckets.size >= MAX_BUCKETS) buckets.clear();

  const b = buckets.get(key) ?? { tokens: limit.capacity, at: now };
  const elapsed = Math.max(0, now - b.at) / 1000;
  const tokens = Math.min(limit.capacity, b.tokens + elapsed * limit.perSecond);

  if (tokens < 1) {
    buckets.set(key, { tokens, at: now });
    return { ok: false, retryAfterSeconds: Math.ceil((1 - tokens) / limit.perSecond) };
  }

  buckets.set(key, { tokens: tokens - 1, at: now });
  return { ok: true };
}

/* ---------------------------------------------------------- durable --- */

/** The file, when it is a file: only ever the case in a test or a script. */
const LOCAL_FILE = ".kawal-buckets.db";
/** Longer than a libSQL round trip from Vercel, shorter than a visitor notices. */
const STORE_DEADLINE_MS = 1_500;

let ready: Promise<Store | null> | null = null;

function open(): Promise<Store | null> {
  if (!ready) {
    ready = (async () => {
      const store = await openStore(LOCAL_FILE);
      if (!store) return null;
      try {
        await store.exec(`
          CREATE TABLE IF NOT EXISTS buckets (
            key     TEXT PRIMARY KEY,
            tokens  REAL    NOT NULL,
            at      INTEGER NOT NULL,
            last_ok INTEGER NOT NULL
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

/**
 * `take`, against the shared database when there is one.
 *
 * One statement does the refill, the decision and the write, so two
 * instances racing on the same key serialise on the row rather than both
 * reading "one token left" and both taking it. `last_ok` records which way
 * the decision went, because after the update the stored count alone cannot
 * say — 0.4 tokens is what remains after a grant from 1.4 and also what
 * remains after a refusal at 0.4.
 *
 * Falls back to memory on any failure, and never throws: the limiter sits in
 * front of every limited route, and a route that 500s because the limiter's
 * database is unreachable has replaced a ceiling with an outage.
 */
export async function takeDurable(key: string, limit: Limit, now = Date.now()): Promise<Decision> {
  if (!isRemote()) return take(key, limit, now);

  const store = await open();
  if (!store) return take(key, limit, now);

  try {
    // Bounded: the limiter sits in front of every limited route, and a
    // database that accepts the connection and then thinks about it must not
    // hold each of those requests for as long as it likes.
    const row = await Promise.race([
      store.get<{ tokens: number; last_ok: number }>(
        `INSERT INTO buckets (key, tokens, at, last_ok) VALUES (?1, ?2 - 1, ?3, 1)
         ON CONFLICT(key) DO UPDATE SET
           tokens  = MIN(?2, tokens + MAX(0, ?3 - at) / 1000.0 * ?4)
                     - CASE WHEN MIN(?2, tokens + MAX(0, ?3 - at) / 1000.0 * ?4) >= 1 THEN 1 ELSE 0 END,
           last_ok = CASE WHEN MIN(?2, tokens + MAX(0, ?3 - at) / 1000.0 * ?4) >= 1 THEN 1 ELSE 0 END,
           at      = ?3
         RETURNING tokens, last_ok`,
        [key, limit.capacity, now, limit.perSecond],
      ),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), STORE_DEADLINE_MS).unref?.()),
    ]);
    if (!row) return take(key, limit, now);
    if (Number(row.last_ok) === 1) return { ok: true };
    return { ok: false, retryAfterSeconds: Math.ceil((1 - Number(row.tokens)) / limit.perSecond) };
  } catch {
    return take(key, limit, now);
  }
}

/**
 * Which ceiling a path sits under, or none.
 *
 * An agent page and a comparison each dial a declared endpoint once per
 * minute per agent, which is nothing until someone enumerates token ids.
 */
export function groupOf(pathname: string): keyof typeof LIMITS | null {
  if (pathname.startsWith("/api/mcp") || pathname.startsWith("/api/a2a") || pathname.startsWith("/api/report")) {
    return "api";
  }
  if (pathname === "/owner" || pathname === "/owner/") return "owner";
  if (pathname === "/compare" || pathname === "/compare/" || /^\/agents\/\d+\/\d+\/?$/.test(pathname)) {
    return "page";
  }
  return null;
}

/** Only for the offline suite: a fresh map between cases. */
export function resetForTests() {
  buckets.clear();
  ready = null;
}
