/**
 * A record of every time Kawal actually called an agent.
 *
 * The probe already answers "is it up right now". One reading is a weak
 * signal: an agent that happened to answer this second looks identical to one
 * that has answered every second for a week, and they are not the same
 * proposition when you are about to hand one a spend cap.
 *
 * Nothing in the ecosystem carries this. 8004scan publishes its own cached
 * health check but no history a buyer can read, so an agent's reliability
 * over time is simply unknown — to everyone. Kawal is already making these
 * calls; keeping them costs one insert and turns "answered in 182 ms" into
 * "answered 30 of 30 checks since Tuesday".
 *
 * Storage is `node:sqlite`, a Node builtin since 22. Chosen over a JSON file
 * because this is append-heavy time series read by aggregate: a file would
 * mean rewriting the whole history on every probe and computing medians in
 * JavaScript. Chosen over a real database because a marketplace that needs
 * Postgres running to render a page is a worse marketplace.
 *
 * Writes are the side effect of a read, which is unusual and deliberate: the
 * probe is memoised for a minute, so a page under any amount of traffic
 * records at most one row per endpoint per minute.
 */

import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join } from "node:path";
import type { EndpointProof } from "./probe.ts";

/**
 * Where the history lives, resolved when the database is first opened rather
 * than when this module loads.
 *
 * The difference is not cosmetic. Static imports hoist: `scripts/check.ts`
 * pulls in `probe.ts`, which pulls in this module, so a constant evaluated at
 * load time was already pointing at the real database before the check could
 * redirect it. The self-check was writing its synthetic rows into production
 * history and then failing on its own leftovers.
 */
function dbPath() {
  const configured = process.env.KAWAL_UPTIME_DB ?? ".kawal-uptime.db";
  // Anchored for the same reason the ledger is: a relative path follows the
  // process CWD, so a server started from elsewhere would silently open a
  // second, empty history instead of the real one. Turbopack warns about the
  // computed path — correctly, and see lib/vault.ts for why the warning is
  // left standing rather than suppressed.
  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

/** Rows older than this are dropped: a month is as far back as anyone reads. */
const RETAIN_DAYS = 30;

let db: DatabaseSync | null = null;
let broken = false;

/**
 * Opens the database, creating it on first use.
 *
 * Returns null rather than throwing if the file cannot be opened — a
 * read-only filesystem or a locked file must cost the uptime panel, not the
 * page. The failure is latched so a broken environment is not retried on
 * every render.
 */
function open(): DatabaseSync | null {
  if (db) return db;
  if (broken) return null;

  try {
    const handle = new DatabaseSync(dbPath());
    handle.exec(`
      CREATE TABLE IF NOT EXISTS probe (
        endpoint   TEXT    NOT NULL,
        checked_at INTEGER NOT NULL,
        is_mcp     INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        error      TEXT
      );
      CREATE INDEX IF NOT EXISTS probe_endpoint_time ON probe (endpoint, checked_at);
    `);
    db = handle;
    return db;
  } catch {
    broken = true;
    return null;
  }
}

/** Writes one observation. Silent on failure: monitoring must not break the page. */
export function recordProbe(proof: EndpointProof) {
  const handle = open();
  if (!handle) return;

  try {
    handle
      .prepare("INSERT INTO probe (endpoint, checked_at, is_mcp, latency_ms, error) VALUES (?, ?, ?, ?, ?)")
      .run(
        proof.endpoint,
        Math.floor(new Date(proof.checkedAt).getTime() / 1000),
        proof.isMcp ? 1 : 0,
        Math.round(proof.latencyMs),
        proof.error,
      );

    handle
      .prepare("DELETE FROM probe WHERE checked_at < ?")
      .run(Math.floor(Date.now() / 1000) - RETAIN_DAYS * 86_400);
  } catch {
    // A failed insert costs one data point, never a render.
  }
}

export type Uptime = {
  checks: number;
  answered: number;
  /** Unix seconds of the oldest retained observation. */
  since: number;
  lastCheckedAt: number;
  /** Median latency across the answering checks. */
  medianMs: number | null;
  /** Slowest answering check, so a bad tail is visible behind a good median. */
  worstMs: number | null;
};

/**
 * What we have observed about one endpoint.
 *
 * Null when there is nothing yet — the first visitor to an agent page creates
 * the first row, and a panel claiming "0 of 0 checks" would say less than
 * showing nothing.
 */
export function uptimeFor(endpoint: string): Uptime | null {
  const handle = open();
  if (!handle) return null;

  try {
    const row = handle
      .prepare(
        `SELECT COUNT(*)                                   AS checks,
                SUM(is_mcp)                                AS answered,
                MIN(checked_at)                            AS since,
                MAX(checked_at)                            AS last_checked_at
           FROM probe
          WHERE endpoint = ?`,
      )
      .get(endpoint) as
      | { checks: number; answered: number | null; since: number | null; last_checked_at: number | null }
      | undefined;

    if (!row || row.checks === 0) return null;

    // Median over answering checks only: a timeout's latency is the timeout,
    // not the agent's speed, and mixing the two flatters nothing and misleads
    // everyone.
    const latencies = handle
      .prepare("SELECT latency_ms FROM probe WHERE endpoint = ? AND is_mcp = 1 ORDER BY latency_ms")
      .all(endpoint) as Array<{ latency_ms: number }>;

    const mid = latencies.length >> 1;
    const medianMs =
      latencies.length === 0
        ? null
        : latencies.length % 2
          ? (latencies[mid]?.latency_ms ?? null)
          : Math.round(
              ((latencies[mid - 1]?.latency_ms ?? 0) + (latencies[mid]?.latency_ms ?? 0)) / 2,
            );

    return {
      checks: row.checks,
      answered: row.answered ?? 0,
      since: row.since ?? 0,
      lastCheckedAt: row.last_checked_at ?? 0,
      medianMs,
      worstMs: latencies[latencies.length - 1]?.latency_ms ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The record in the shape `assess` wants, or undefined when there is none.
 *
 * Separate from `uptimeFor` because the tier only cares whether anything ever
 * answered, while the panel wants latencies and dates. Keeping them apart
 * means the tier cannot accidentally start depending on a median.
 */
export function observedFor(endpoint: string | null | undefined) {
  if (!endpoint) return undefined;
  const seen = uptimeFor(endpoint);
  return seen ? { checks: seen.checks, answered: seen.answered } : undefined;
}

