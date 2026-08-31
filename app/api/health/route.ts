import { NextResponse } from "next/server";
import { getStats } from "@/lib/scan";
import { loadLedger, isLive, hasAdminKey } from "@/lib/sessions";
import { uptimeFor, lastSweep, sweepLine } from "@/lib/uptime";
import { isRemote } from "@/lib/db";

/**
 * Whether this instance can actually do its job.
 *
 * Deliberately not `{ ok: true }`. Kawal is a thin layer over things that
 * break independently of it — a registry that returned 502 for days during
 * this build, a ledger on disk, a SQLite file — and an endpoint that answers
 * 200 while the registry is unreachable tells an operator nothing they could
 * not have guessed from the port being open.
 *
 * So each dependency is exercised, not pinged: the registry check reads real
 * chain statistics, the ledger check parses the file, the database check runs
 * a query. Every one of them is something a page would do.
 *
 * Nothing secret is returned. The admin key is reported as present or absent
 * and never read — a health endpoint is the last place a private key should
 * be able to reach.
 */

export const dynamic = "force-dynamic";

type Probe = { name: string; ok: boolean; detail: string; ms: number };

async function timed(name: string, work: () => Promise<string> | string): Promise<Probe> {
  const started = performance.now();
  try {
    const detail = await work();
    return { name, ok: true, detail, ms: Math.round(performance.now() - started) };
  } catch (e) {
    return {
      name,
      ok: false,
      detail: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      ms: Math.round(performance.now() - started),
    };
  }
}

export async function GET() {
  const probes = await Promise.all([
    timed("registry", async () => {
      const stats = await getStats();
      const bsc = stats.chain_stats.find((c) => c.chain_id === 56);
      if (!bsc) throw new Error("8004scan answered but reported no BSC chain");
      return `${bsc.total_agents.toLocaleString()} agents indexed on BSC`;
    }),

    timed("sweep", async () => {
      const run = await lastSweep();
      // A fresh instance has no run yet; that is a fact, not a failure.
      if (!run) return "no scheduled sweep has run on this instance";
      return sweepLine(run);
    }),

    timed("ledger", async () => {
      const seats = await loadLedger();
      // An empty ledger is healthy — it means no mandate has been granted on
      // this instance, which is the normal state for a fresh deployment.
      const live = seats.filter((s) => isLive(s)).length;
      return seats.length === 0
        ? "no sessions granted on this instance"
        : `${live} live of ${seats.length} recorded`;
    }),

    timed("probe-history", async () => {
      // Reads through the same path the agent page uses. A locked or
      // unwritable database returns null there and silently drops the
      // reliability panel, which is exactly the kind of quiet degradation an
      // operator should hear about here instead.
      await uptimeFor("https://health-check.invalid/never-probed");
      return isRemote() ? "shared database (libSQL) readable" : "local file readable — resets on a host without a disk";
    }),
  ]);

  const degraded = probes.filter((p) => !p.ok);

  return NextResponse.json(
    {
      status: degraded.length === 0 ? "ok" : "degraded",
      // Capability, not permission: an instance without the wallet key can
      // serve the catalog and cannot revoke anything, and an operator needs to
      // know which kind they are looking at.
      canRevoke: hasAdminKey(),
      checkedAt: new Date().toISOString(),
      probes,
    },
    {
      // 503 when a dependency is down, so an uptime monitor sees it without
      // having to parse the body. A degraded Kawal still serves pages, but it
      // is not serving the thing anyone came for.
      status: degraded.length === 0 ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
