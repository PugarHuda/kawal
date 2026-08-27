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

import { getAgent } from "./scan.ts";
import { proveAgent, type EndpointProof } from "./probe.ts";
import { observedFor } from "./uptime.ts";
import { mapLimit } from "./concurrency.ts";
import type { Observed } from "./signals.ts";
import type { Listing } from "./catalog.ts";

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
        const observed = observedFor(proof.endpoint);
        proofs.set(listing.agent.agent_id, {
          proof,
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
