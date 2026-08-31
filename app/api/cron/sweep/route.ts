import { NextResponse } from "next/server";
import { CATEGORIES } from "@/lib/taxonomy";
import { retrieveCategory, browse } from "@/lib/catalog";
import { getAgent, verifyEndpoint, type Verification } from "@/lib/scan";
import { requestHealthCheck, type HealthCheck } from "@/lib/scan.auth";
import { proveAgent } from "@/lib/probe";
import { recordSweep } from "@/lib/uptime";
import { guardedFetch, readCapped } from "@/lib/ssrf";
import { mapLimit } from "@/lib/concurrency";
import { BSC_MAINNET } from "@/lib/chains";

/**
 * The scheduled sweep: probes on a clock, not only when somebody looks.
 *
 * Every reputation record Kawal writes carries this among its stated defects:
 * "probes are made when the site is used rather than on a schedule, so the
 * sample is not evenly spaced in time." That was true. A history that only
 * grows when a visitor happens to open a page measures the visitors as much
 * as the agents. This route is what Vercel Cron calls, daily on the Hobby plan, and
 * it removes the defect rather than restating it.
 *
 * Bounded like the listing probe is: at most `PER_RUN` agents, at most
 * `CONCURRENCY` in flight, the listing's shorter timeout. The bound rotates —
 * which agents go first depends on the hour — so successive runs cover the
 * roster over a day rather than the same head of it every time.
 *
 * Two pools feed it: every category listing, and the top of the unfiltered
 * roster. The second is what a visitor sees first under "All", and it was
 * being probed only when a visitor chose one.
 *
 * After an agent answers, 8004scan is asked to re-verify its endpoint
 * domain — but only when the agent serves the `agent-registration.json` the
 * verification looks for, since asking otherwise burns the one request an
 * hour the registry allows on a check that cannot pass. The registry's 429
 * for an agent already asked about is an outcome to record, not an error.
 *
 * 8004scan is also asked to run its own health check on every agent that
 * answered, signed in as Kawal's wallet. Two probers disagreeing about an
 * endpoint is more informative than one, and the registry's check is the one
 * its `health_score` is built from. The registry calls it owner-triggered
 * and answers 403 for an agent this wallet does not own, so those are filed
 * as `not-owner` without asking; 429 past the daily limit is recorded on
 * the row and the sweep moves on, and an instance without the admin key
 * records that it could not ask. Until `npm run register` mints Kawal's own
 * registration, every row reads `not-owner` — which is the true state.
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
/** A registration document is small and static; a host that takes longer is not serving one. */
const DOC_TIMEOUT_MS = 5_000;

type Verified = "queued" | "rate-limited" | "refused" | "no-registration-doc" | null;

/**
 * Whether the endpoint's origin serves the ERC-8004 registration document
 * 8004scan's verifier will look for. One guarded GET, read-only, capped.
 */
async function servesRegistrationDoc(endpoint: string): Promise<boolean> {
  try {
    const origin = new URL(endpoint).origin;
    const res = await guardedFetch(`${origin}/.well-known/agent-registration.json`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DOC_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = JSON.parse(await readCapped(res, 256_000)) as unknown;
    return typeof body === "object" && body !== null;
  } catch {
    return false;
  }
}

function outcome(v: Verification): Verified {
  return v.queued ? "queued" : v.reason;
}

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

  const pools = [
    ...CATEGORIES.map((c) => retrieveCategory(c, { chainId: BSC_MAINNET }).then((r) => r.listings)),
    // The roster head throws on a dead registry where the category retrieval
    // settles; with no registry there is nothing to sweep, not a failure.
    browse({ chainId: BSC_MAINNET, limit: 60 }).then((r) => r.listings).catch(() => []),
  ];
  for (const listings of await Promise.all(pools)) {
    for (const l of listings) {
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
    const row = {
      tokenId: t.tokenId,
      name: t.name,
      probed: false,
      answered: null as boolean | null,
      protocol: null as string | null,
      verified: null as Verified,
      healthCheck: null as HealthCheck | null,
    };
    try {
      const detail = await getAgent(t.chainId, t.tokenId);
      const proof = await proveAgent(detail, { timeoutMs: PROBE_TIMEOUT_MS });
      if (!proof) return row;
      row.probed = true;
      row.answered = proof.answered;
      row.protocol = proof.protocol;
      if (proof.answered) {
        // Two independent asks of the registry; neither waits on the other.
        [row.verified, row.healthCheck] = await Promise.all([
          servesRegistrationDoc(proof.endpoint).then((serves) =>
            serves
              ? verifyEndpoint(t.chainId, t.tokenId)
                  .catch((): Verification => ({ queued: false, reason: "refused", status: 0 }))
                  .then(outcome)
              : ("no-registration-doc" as const),
          ),
          requestHealthCheck(t.chainId, t.tokenId, detail.owner_address),
        ]);
      }
      return row;
    } catch {
      return row;
    }
  });

  const probed = results.filter((r) => r.probed);
  const run = {
    ranAt: new Date(started).toISOString(),
    probed: probed.length,
    answered: probed.filter((r) => r.answered === true).length,
    healthChecked: results.filter((r) => r.healthCheck === "queued").length,
    verified: results.filter((r) => r.verified === "queued").length,
    // Counted, not discarded. `verified: 0` on its own cannot be told apart
    // from "8004scan refused all of them", and a health report nobody can read
    // that way is a health report that hides the outage it exists to show.
    refused: results.filter((r) => r.verified === "refused").length,
    rateLimited: results.filter((r) => r.verified === "rate-limited").length,
    noDoc: results.filter((r) => r.verified === "no-registration-doc").length,
  };
  await recordSweep(run);

  return NextResponse.json(
    {
      ...run,
      ms: Date.now() - started,
      eligible: targets.length,
      offset,
      results,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
