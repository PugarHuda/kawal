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
 * Storage goes through `lib/db.ts`: a SQLite file on a machine with a disk,
 * the shared libSQL database on a platform without one. Same SQL either way.
 * Chosen over a JSON file because this is append-heavy time series read by
 * aggregate, and over a real database because a marketplace that needs
 * Postgres running to render a page is a worse marketplace.
 *
 * Writes are the side effect of a read, which is unusual and deliberate: the
 * probe is memoised for a minute, so a page under any amount of traffic
 * records at most one row per endpoint per minute.
 */

import { openStore, type Store } from "./db.ts";
import type { EndpointProof } from "./probe.ts";

/**
 * The file, when it is a file.
 *
 * Read when the store is first opened rather than when this module loads.
 * Static imports hoist: `scripts/check.ts` pulls in `probe.ts`, which pulls
 * in this module, so a constant evaluated at load time was already pointing
 * at the real database before the check could redirect it — and the
 * self-check was writing its synthetic rows into production history.
 */
function file() {
  return process.env.KAWAL_UPTIME_DB ?? ".kawal-uptime.db";
}

/** Rows older than this are dropped: a month is as far back as anyone reads. */
const RETAIN_DAYS = 30;

let ready: Promise<Store | null> | null = null;

async function open(): Promise<Store | null> {
  if (!ready) {
    ready = (async () => {
      const store = await openStore(file());
      if (!store) return null;
      try {
        await store.exec(`
          CREATE TABLE IF NOT EXISTS probe (
            endpoint   TEXT    NOT NULL,
            checked_at INTEGER NOT NULL,
            is_mcp     INTEGER NOT NULL,
            latency_ms INTEGER NOT NULL,
            error      TEXT
          );
          CREATE INDEX IF NOT EXISTS probe_endpoint_time ON probe (endpoint, checked_at)
        `);

        // `is_mcp` predates the prober speaking anything but MCP. It now means
        // "answered in its declared protocol", and the protocol is its own
        // column so an A2A answer is not filed as an MCP one. Added in place
        // rather than by renaming: a rename would orphan every row of history
        // already kept, and the history is the whole point of this file. Rows
        // from before the column exists default to 'mcp', which is what they
        // were.
        const columns = await store.all<{ name: string }>("PRAGMA table_info(probe)");
        if (!columns.some((c) => c.name === "protocol")) {
          await store.exec("ALTER TABLE probe ADD COLUMN protocol TEXT NOT NULL DEFAULT 'mcp'");
        }

        // One row per scheduled sweep, in the same store as the probes it
        // made, so "when did Kawal last look" is answerable from the same
        // place as "what did it find".
        await store.exec(`
          CREATE TABLE IF NOT EXISTS sweep (
            ran_at   INTEGER NOT NULL,
            probed   INTEGER NOT NULL,
            answered INTEGER NOT NULL,
            verified INTEGER NOT NULL
          )
        `);
        // Added after the table existed on the deployed store; the ALTER
        // fails harmlessly where the column is already there.
        await store.exec("ALTER TABLE sweep ADD COLUMN health_checked INTEGER NOT NULL DEFAULT 0").catch(() => {});
        return store;
      } catch {
        return null;
      }
    })();
  }
  return ready;
}

/** Only for the offline suite, which redirects the file between sections. */
export function resetUptimeForTests() {
  ready = null;
}

/** Writes one observation. Silent on failure: monitoring must not break the page. */
export async function recordProbe(proof: EndpointProof): Promise<void> {
  const store = await open();
  if (!store) return;

  try {
    await store.run(
      "INSERT INTO probe (endpoint, checked_at, is_mcp, latency_ms, error, protocol) VALUES (?, ?, ?, ?, ?, ?)",
      [
        proof.endpoint,
        Math.floor(new Date(proof.checkedAt).getTime() / 1000),
        proof.answered ? 1 : 0,
        Math.round(proof.latencyMs),
        proof.error,
        proof.protocol,
      ],
    );
    await store.run("DELETE FROM probe WHERE checked_at < ?", [
      Math.floor(Date.now() / 1000) - RETAIN_DAYS * 86_400,
    ]);
  } catch {
    // A failed insert costs one data point, never a render.
  }
}

export type SweepRun = {
  ranAt: string;
  /** Agents whose declared endpoint was actually dialled. */
  probed: number;
  /** Of those, how many answered in their declared protocol. */
  answered: number;
  /** How many 8004scan accepted a re-verification request for. */
  verified: number;
  /** How many 8004scan queued its own health check for (owner-only, so zero until Kawal owns agents). */
  healthChecked?: number;
};

/** Writes one sweep's tally. Silent on failure, like every write here. */
export async function recordSweep(run: SweepRun): Promise<void> {
  const store = await open();
  if (!store) return;
  try {
    await store.run(
      "INSERT INTO sweep (ran_at, probed, answered, verified, health_checked) VALUES (?, ?, ?, ?, ?)",
      [
        Math.floor(new Date(run.ranAt).getTime() / 1000),
        run.probed,
        run.answered,
        run.verified,
        run.healthChecked ?? 0,
      ],
    );
    await store.run("DELETE FROM sweep WHERE ran_at < ?", [Math.floor(Date.now() / 1000) - RETAIN_DAYS * 86_400]);
  } catch {
    // A lost tally costs one line on the health page, never the sweep.
  }
}

/**
 * The most recent scheduled sweep, or null when none has run — which on a
 * fresh deployment is the honest answer and worth printing as such.
 */
export async function lastSweep(): Promise<SweepRun | null> {
  const store = await open();
  if (!store) return null;
  try {
    const row = await store.get<{
      ran_at: number;
      probed: number;
      answered: number;
      verified: number;
      health_checked: number | null;
    }>("SELECT ran_at, probed, answered, verified, health_checked FROM sweep ORDER BY ran_at DESC LIMIT 1");
    if (!row) return null;
    return {
      ranAt: new Date(Number(row.ran_at) * 1000).toISOString(),
      probed: Number(row.probed),
      answered: Number(row.answered),
      verified: Number(row.verified),
      healthChecked: Number(row.health_checked ?? 0),
    };
  } catch {
    return null;
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
  /** Whether the newest check answered: the cell the tally strip outlines. */
  lastAnswered: boolean;
};

/**
 * What we have observed about one endpoint.
 *
 * Null when there is nothing yet — the first visitor to an agent page creates
 * the first row, and a panel claiming "0 of 0 checks" would say less than
 * showing nothing.
 */
export async function uptimeFor(endpoint: string): Promise<Uptime | null> {
  const store = await open();
  if (!store) return null;

  try {
    const row = await store.get<{
      checks: number;
      answered: number | null;
      since: number | null;
      last_checked_at: number | null;
    }>(
      `SELECT COUNT(*)      AS checks,
              SUM(is_mcp)   AS answered,
              MIN(checked_at) AS since,
              MAX(checked_at) AS last_checked_at
         FROM probe
        WHERE endpoint = ?`,
      [endpoint],
    );

    if (!row || Number(row.checks) === 0) return null;

    // Median over answering checks only: a timeout's latency is the timeout,
    // not the agent's speed, and mixing the two flatters nothing and misleads
    // everyone.
    const latencies = (
      await store.all<{ latency_ms: number }>(
        "SELECT latency_ms FROM probe WHERE endpoint = ? AND is_mcp = 1 ORDER BY latency_ms",
        [endpoint],
      )
    ).map((r) => Number(r.latency_ms));

    const newest = await store.get<{ is_mcp: number }>(
      "SELECT is_mcp FROM probe WHERE endpoint = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1",
      [endpoint],
    );

    const mid = latencies.length >> 1;
    const medianMs =
      latencies.length === 0
        ? null
        : latencies.length % 2
          ? (latencies[mid] ?? null)
          : Math.round(((latencies[mid - 1] ?? 0) + (latencies[mid] ?? 0)) / 2);

    return {
      checks: Number(row.checks),
      answered: Number(row.answered ?? 0),
      since: Number(row.since ?? 0),
      lastCheckedAt: Number(row.last_checked_at ?? 0),
      medianMs,
      worstMs: latencies[latencies.length - 1] ?? null,
      lastAnswered: Number(newest?.is_mcp ?? 0) === 1,
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
export async function observedFor(endpoint: string | null | undefined) {
  if (!endpoint) return undefined;
  const seen = await uptimeFor(endpoint);
  return seen ? { checks: seen.checks, answered: seen.answered } : undefined;
}

export type Observed = {
  /** Every probe Kawal has kept, across all agents. */
  checks: number;
  /** Distinct endpoints called at least once. */
  endpoints: number;
  /** Of those, how many have ever answered in their declared protocol. */
  answered: number;
  /** Unix seconds of the oldest retained observation. */
  since: number;
};

/**
 * What Kawal has measured for itself, across every agent it has called.
 *
 * The home page otherwise repeats 8004scan's figures, which are the registry's
 * claims about itself — the exact thing this product exists to distrust. This
 * is the only number on that page Kawal earned, so it is worth the one query.
 *
 * Null when the history is empty or unreadable, for the same reason
 * `uptimeFor` is: a band reading "0 of 0" says less than no band.
 */
export async function observedTotals(): Promise<Observed | null> {
  const store = await open();
  if (!store) return null;

  try {
    const row = await store.get<{ checks: number; endpoints: number; answered: number; since: number | null }>(
      `SELECT COUNT(*)                               AS checks,
              COUNT(DISTINCT endpoint)               AS endpoints,
              COUNT(DISTINCT CASE WHEN is_mcp = 1
                                  THEN endpoint END) AS answered,
              MIN(checked_at)                        AS since
         FROM probe`,
    );
    if (!row || Number(row.checks) === 0) return null;
    return {
      checks: Number(row.checks),
      endpoints: Number(row.endpoints),
      answered: Number(row.answered),
      since: Number(row.since ?? 0),
    };
  } catch {
    return null;
  }
}
