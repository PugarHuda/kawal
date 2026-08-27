/**
 * The catalog: retrieval + classification + evidence, composed into listings.
 *
 * 8004scan gives us a roster and a reputation number. Everything a person needs
 * to actually choose an agent -- what it does, whether it can be reached,
 * whether it is one of a hundred identical mints -- is assembled here.
 */

import { listAgents, searchAgents, type ScanAgent } from "./scan.ts";
import { BSC_MAINNET } from "./chains.ts";
import { memo } from "./memo.ts";

import {
  CATEGORIES,
  classify,
  MIN_CONFIDENCE,
  type Category,
  type Classification,
} from "./taxonomy.ts";
import {
  assess,
  duplicateIndex,
  fingerprint,
  rank,
  seriesKey,
  stencilKey,
  type Assessment,
  type Observed,
} from "./signals.ts";

/**
 * The protocol values 8004scan indexes for agents you can actually call.
 *
 * Case matters: the API's `protocol` filter is exact, and "mcp" silently
 * returns zero rows where "MCP" returns 5,069. A filter that fails by
 * returning nothing is the worst kind — it looks like an empty category.
 */
const CALLABLE_PROTOCOLS = ["MCP", "A2A", "OASF"] as const;


export type Listing = {
  agent: ScanAgent;
  classification: Classification;
  assessment: Assessment;
  score: number;
};

export function toListings(agents: ScanAgent[]): Listing[] {
  const dupes = duplicateIndex(agents);
  return agents
    .map((agent) => {
      const assessment = assess(agent, dupes);
      return {
        agent,
        classification: classify(agent.name, agent.description),
        assessment,
        score: rank(agent, assessment),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Collapses bulk-minted padding down to one representative each.
 *
 * Runs on an already-ranked list, so the survivor of each group is its best
 * entry rather than whichever happened to be indexed first.
 *
 * Three keys, because minting scripts vary either the name or the description
 * but rarely both: the exact pair, the name with edition numbers stripped,
 * and the description on its own. An agent is dropped if it collides on any
 * of them with something already kept.
 */
export function collapseDuplicates(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  return listings.filter((l) => {
    const exact = `exact:${fingerprint(l.agent)}`;
    const keys = [exact, seriesKey(l.agent), stencilKey(l.agent)].filter(
      (k): k is string => k !== null,
    );

    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
}

/**
 * Re-scores listings against what Kawal has actually observed, then re-ranks.
 *
 * `toListings` scores from the registry alone, because that is all a list
 * response carries. Once endpoints have been called, some of those scores are
 * known to be wrong — an agent the registry calls hireable that has never
 * answered should not sit at the top of the page it is wrong about.
 */
export function reassess(
  listings: Listing[],
  observations: Map<string, { observed?: Observed }>,
): Listing[] {
  return listings
    .map((l) => {
      const observed = observations.get(l.agent.agent_id)?.observed;
      if (!observed) return l;

      const assessment = assess(l.agent, undefined, observed);
      return { ...l, assessment, score: rank(l.agent, assessment) };
    })
    .sort((a, b) => b.score - a.score);
}

export type CategoryResult = {
  category: Category;
  listings: Listing[];
  /** How many the registry returned before we collapsed and filtered. */
  retrieved: number;
  /** Chain-wide match count for this category's strongest probe. */
  chainTotal: number;
  semantic: boolean;
};

/**
 * Retrieves candidates for one category.
 *
 * Runs every probe rather than one, because a single keyword misses most of a
 * sparse category -- "health factor" matches three agents chain-wide, but
 * "liquidation" and "collateral" reach others that never use the phrase.
 */
export async function retrieveCategory(
  c: Category,
  opts: { chainId?: number; perProbe?: number } = {},
): Promise<CategoryResult> {
  const chainId = opts.chainId ?? BSC_MAINNET;
  const perProbe = opts.perProbe ?? 25;

  // One fan-out per category at a time, whatever the traffic. Without this,
  // concurrent cold requests each issued their own twelve upstream calls.
  return memo(`category:${c.id}:${chainId}:${perProbe}`, CATEGORY_TTL_MS, () =>
    retrieveCategoryUncached(c, chainId, perProbe),
  );
}

/** Five minutes, matching the fetch cache the individual probes already use. */
const CATEGORY_TTL_MS = 5 * 60 * 1000;

async function retrieveCategoryUncached(
  c: Category,
  chainId: number,
  perProbe: number,
): Promise<CategoryResult> {

  const byId = new Map<string, ScanAgent>();
  let chainTotal = 0;
  let semantic = false;

  // Two sweeps, because searching the whole roster and searching the callable
  // pool find different things.
  //
  // Semantic search ranks over all 278k registrations, the overwhelming
  // majority of which declare no interface at all, so the agents a user can
  // actually hire get buried under bulk-minted noise long before they surface.
  // Filtering by protocol first inverts that: start from the ~22k that can be
  // called, then ask which of them do this job. Measured across a 2,093-agent
  // sample, the second sweep is what turns Grid and Yield from zero hireable
  // agents into a real shortlist.
  const results = await Promise.allSettled([
    ...c.probes.map((p) => searchAgents(p, { chainId, limit: perProbe })),
    ...c.probes.flatMap((p) =>
      CALLABLE_PROTOCOLS.map(async (protocol) => {
        const { agents, total } = await listAgents({
          chainId,
          protocol,
          search: p,
          limit: perProbe,
        });
        return { agents, total, semantic: false };
      }),
    ),
  ]);

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    semantic = semantic || r.value.semantic;
    chainTotal = Math.max(chainTotal, r.value.total);
    for (const a of r.value.agents) byId.set(a.agent_id, a);
  }

  const retrieved = byId.size;
  const listings = collapseDuplicates(toListings([...byId.values()])).filter(
    (l) => l.classification.category === c.id && l.classification.confidence >= MIN_CONFIDENCE,
  );

  return { category: c, listings, retrieved, chainTotal, semantic };
}

export async function retrieveAllCategories(chainId = BSC_MAINNET) {
  return Promise.all(CATEGORIES.map((c) => retrieveCategory(c, { chainId })));
}

/** The unfiltered roster, ranked by evidence. Used by the browse view. */
export async function browse(opts: { chainId?: number; search?: string; limit?: number } = {}) {
  const { agents, total } = await listAgents({
    chainId: opts.chainId ?? BSC_MAINNET,
    search: opts.search,
    limit: opts.limit ?? 60,
    sortBy: "total_score",
    sortOrder: "desc",
  });
  // The unfiltered tab needs the same collapse as a category page: without it
  // "All" is where every minted series reappears in full.
  return { listings: collapseDuplicates(toListings(agents)), total };
}

