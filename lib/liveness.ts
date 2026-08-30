/**
 * Answers "which of these actually respond" for a whole listing.
 *
 * The agent page proves one endpoint. A listing is where the choice is made,
 * and until now every row there looked equally alive — including the ones
 * whose MCP endpoint is a 502 or an image file. Those two exist in the live
 * registry today, so the gap is not hypothetical.
 *
 * Bounded on purpose, in three ways, because this is the one place where a
 * page's cost scales with how many agents it shows:
 *
 *   only the hireable rows are probed — the rest have nothing to call
 *   at most MAX_PROBES of them, however long the list is
 *   at most CONCURRENCY in flight, so a slow endpoint cannot pile up
 *
 * Every result is memoised by `probeMcp`, so a second visitor pays nothing and
 * nobody can turn the listing into an amplifier by reloading it.
 */

import { getAgent, getTrending, type ScanAgentDetail, type TrendingPeriod } from "./scan.ts";
import { proveAgent, type EndpointProof } from "./probe.ts";
import { observedFor, uptimeFor, type Uptime } from "./uptime.ts";
import { mapLimit } from "./concurrency.ts";
import type { Observed, Measured } from "./signals.ts";
import { reassess, toListings, type Listing } from "./catalog.ts";

const MAX_PROBES = 5;
const CONCURRENCY = 3;
/** Tighter than the agent page: a listing must not wait on one slow host. */
const PROBE_TIMEOUT_MS = 6_000;

/**
 * Probes the hireable agents in a listing, keyed by agent id.
 *
 * A failure to fetch an agent's detail is not a failure of the page: the row
 * simply carries no verdict, which is honest — we did not check it, rather
 * than we checked and it was fine.
 */
export type ListingProbe = {
  proof: EndpointProof;
  /** The running record for this endpoint, when Kawal has one. */
  observed?: Observed;
  /** The same record with latency, for the ranking's speed term. */
  uptime?: Uptime | null;
};

export async function probeListings(listings: Listing[]): Promise<Map<string, ListingProbe>> {
  const candidates = listings
    .filter((l) => l.assessment.tier === "hireable")
    .slice(0, MAX_PROBES);

  const proofs = new Map<string, ListingProbe>();
  if (candidates.length === 0) return proofs;

  await mapLimit(candidates, CONCURRENCY, async (listing) => {
    try {
      // The list endpoint carries no `services`, so the endpoint has to come
      // from the agent's detail record. Both are memoised.
      const detail = await getAgent(listing.agent.chain_id, listing.agent.token_id);
      const proof = await proveAgent(detail, { timeoutMs: PROBE_TIMEOUT_MS });
      if (proof) {
        const [observed, uptime] = await Promise.all([observedFor(proof.endpoint), uptimeFor(proof.endpoint)]);
        proofs.set(listing.agent.agent_id, {
          proof,
          uptime,
          // The database records whether a call answered as MCP, which is the
          // right thing for uptime and the wrong thing for this question. The
          // proof in hand knows the difference; the row does not.
          observed: observed && { ...observed, reachedAnotherWay: proof.descriptor !== null },
        });
      }
    } catch {
      // Leave the row without a verdict rather than inventing one.
    }
  });

  return proofs;
}

/**
 * The endpoint the prober would dial for a detail record, in the prober's own
 * order — MCP, then A2A, then OASF — without dialling it.
 *
 * Kawal's history is keyed by endpoint, so anything that wants to read the
 * record for an agent it has not called has to resolve the same URL the
 * probe would. Null when the registration declares nothing to call.
 */
export function declaredEndpoint(agent: ScanAgentDetail): { endpoint: string; protocol: "mcp" | "a2a" | "oasf" } | null {
  for (const protocol of ["mcp", "a2a", "oasf"] as const) {
    const endpoint = agent.services?.[protocol]?.endpoint;
    if (typeof endpoint === "string" && endpoint) return { endpoint, protocol };
  }
  return null;
}

/**
 * What Kawal already knows about a listing, without a single new call.
 *
 * The listing probe above dials; this only reads. It exists for the surfaces
 * that show the registry's own ranking — trending, a search an agent asked
 * for — where the point is the contrast between the registry's opinion and
 * Kawal's record, and where dialling everything shown would turn a cover
 * sheet into an amplifier. Each row costs one cached detail read and one
 * database read; a row Kawal has never called simply carries no record.
 */
export async function observeListings(listings: Listing[]): Promise<Map<string, Measured>> {
  const seen = new Map<string, Measured>();
  await mapLimit(listings, CONCURRENCY, async (l) => {
    try {
      const detail = await getAgent(l.agent.chain_id, l.agent.token_id);
      const declared = declaredEndpoint(detail);
      if (!declared) return;
      const [observed, uptime] = await Promise.all([observedFor(declared.endpoint), uptimeFor(declared.endpoint)]);
      if (observed) seen.set(l.agent.agent_id, { observed, uptime });
    } catch {
      // No detail, no record: the row keeps the registry's word alone.
    }
  });
  return seen;
}

export type TrendingRow = { rank: number; listing: Listing; measured: Measured | undefined };

/**
 * 8004scan's trending list with Kawal's stamp beside each entry.
 *
 * The registry ranks by how many people looked (`view_count / (hours+2)^1.5`
 * by its own description); Kawal's record says whether the thing they looked
 * at ever answered. The two are kept side by side rather than merged: the
 * order is the registry's, the stamp is Kawal's, and a trending agent that
 * has never answered is exactly what the contrast exists to show.
 *
 * Throws when the registry does not answer; callers omit the section.
 */
export async function trendingListings(
  period: TrendingPeriod,
  limit: number,
  chainId?: number,
): Promise<{ rows: TrendingRow[]; asOf: string }> {
  const { agents, asOf } = await getTrending(period, { limit, chainId });
  const order = new Map(agents.map((a, i) => [a.agent_id, i]));
  // `toListings` ranks by evidence; the registry's order is put back after,
  // because on this surface its order is the datum.
  const listings = toListings(agents).sort((a, b) => order.get(a.agent.agent_id)! - order.get(b.agent.agent_id)!);
  const measured = await observeListings(listings);
  return {
    asOf,
    rows: reassess(listings, measured)
      .sort((a, b) => order.get(a.agent.agent_id)! - order.get(b.agent.agent_id)!)
      .map((listing) => ({ rank: order.get(listing.agent.agent_id)! + 1, listing, measured: measured.get(listing.agent.agent_id) })),
  };
}
