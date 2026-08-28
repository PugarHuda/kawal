import { NextResponse } from "next/server";
import { CATEGORIES } from "@/lib/taxonomy";
import { retrieveCategory } from "@/lib/catalog";
import { getAgent } from "@/lib/scan";
import { proveAgent } from "@/lib/probe";
import { mapLimit } from "@/lib/concurrency";
import { BSC_MAINNET } from "@/lib/chains";

/**
 * The scheduled sweep: probes on a clock, not only when somebody looks.
 *
 * Every reputation record Kawal writes carries this among its stated defects:
 * "probes are made when the site is used rather than on a schedule, so the
 * sample is not evenly spaced in time." That was true. A history that only
 * grows when a visitor happens to open a page measures the visitors as much
 * as the agents. This route is what Vercel Cron calls, and it removes the
 * defect rather than restating it.
 *
 * Bounded like the listing probe is: at most `PER_RUN` agents, at most
 * `CONCURRENCY` in flight, the listing's shorter timeout. The bound rotates —
 * which agents go first depends on the hour — so a daily run covers the
 * roster over a few days rather than the same head of it every time.
 *
 * Authenticated with the secret Vercel sends its cron requests with. Without
 * it this is a public button that makes Kawal dial the whole roster, and the
 * rate limiter would be the only thing between that and an amplifier.
 */

export const dynamic = "force-dynamic";
/** Fluid compute allows this; the default would cut a sweep off mid-roster. */
export const maxDuration = 300;

const PER_RUN = 40;
const CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 8_000;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  // No secret configured means no schedule was set up, and an endpoint that
  // runs unauthenticated because a variable is missing is the wrong default.
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured; the sweep is disabled" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }

  const started = Date.now();
  const seen = new Set<string>();
  const targets: Array<{ chainId: number; tokenId: string; name: string }> = [];

  for (const category of CATEGORIES) {
    const result = await retrieveCategory(category, { chainId: BSC_MAINNET });
    for (const l of result.listings) {
      const ref = `${l.agent.chain_id}:${l.agent.token_id}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      // Only agents that declare something to call. The rest have no endpoint
      // and a sweep that "probed" them would be recording nothing.
      if (l.assessment.tier === "registered") continue;
      targets.push({ chainId: l.agent.chain_id, tokenId: l.agent.token_id, name: l.agent.name });
    }
  }

  // Rotate by the hour so successive runs start from different points.
  const offset = targets.length === 0 ? 0 : (new Date().getUTCHours() * 7) % targets.length;
  const batch = [...targets.slice(offset), ...targets.slice(0, offset)].slice(0, PER_RUN);

  const results = await mapLimit(batch, CONCURRENCY, async (t) => {
    try {
      const detail = await getAgent(t.chainId, t.tokenId);
      const proof = await proveAgent(detail, { timeoutMs: PROBE_TIMEOUT_MS });
      return {
        tokenId: t.tokenId,
        name: t.name,
        probed: proof !== null,
        answered: proof?.answered ?? null,
        protocol: proof?.protocol ?? null,
      };
    } catch {
      return { tokenId: t.tokenId, name: t.name, probed: false, answered: null, protocol: null };
    }
  });

  const probed = results.filter((r) => r.probed);
  return NextResponse.json(
    {
      ranAt: new Date(started).toISOString(),
      ms: Date.now() - started,
      eligible: targets.length,
      offset,
      probed: probed.length,
      answered: probed.filter((r) => r.answered === true).length,
      results,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
