import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { isDeployed } from "@/lib/anchor";
import { anchorableDays, anchorDay, readAnchors, type AnchorOutcome } from "@/lib/anchor.run";

/**
 * The scheduled anchoring: writes each finished day of probes to KawalLedger.
 *
 * This used to run at the tail of the sweep, after forty agents had been
 * dialled. From 2026-09-28 on it wrote nothing: the anchor key sat funded and
 * untouched while the sweep kept recording runs, so the anchoring step was
 * never reached or never finished inside the sweep's time limit, and the
 * response that would have said which was not logged anywhere. On its own
 * schedule it cannot be starved by a slow roster, and every outcome is logged.
 *
 * Oldest day first, three at most per run: retention deletes rows older than
 * thirty days, so the day nearest that edge is the one about to become
 * impossible to anchor. The key is the dedicated anchoring key, which can
 * write day roots and nothing else. Same secret as the sweep.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PER_RUN = 3;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured; anchoring is disabled" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }

  let anchoring: AnchorOutcome[] | string = "no KAWAL_ANCHOR_KEY on this instance";
  let backlog = 0;
  const anchorKey = process.env.KAWAL_ANCHOR_KEY;
  if (anchorKey && isDeployed()) {
    try {
      const days = await anchorableDays();
      if (days === null) anchoring = "probe store unreadable; nothing anchored";
      else {
        const held = await readAnchors(days);
        const todo = days.filter((d) => !held.has(d));
        backlog = todo.length;
        const account = privateKeyToAccount(anchorKey as `0x${string}`);
        anchoring = [];
        for (const day of todo.slice(0, PER_RUN)) anchoring.push(await anchorDay(day, account));
      }
    } catch (e) {
      anchoring = `anchoring failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`;
    }
  }
  console.log("[cron/anchor]", JSON.stringify({ backlog, anchoring }));
  return NextResponse.json({ backlog, anchoring }, { headers: { "cache-control": "no-store" } });
}
