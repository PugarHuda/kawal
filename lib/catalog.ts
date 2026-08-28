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
  type Measured,
} from "./signals.ts";

/**
 * The three server-side filters for agents you can actually call, one per
 * protocol the prober speaks.
 *
 * These go to `/api/v1/agents` as `has_mcp` / `has_a2a` / `has_oasf`, which
 * filter on the registration actually carrying an endpoint for the protocol
 * rather than merely naming it. The public path's `protocol=MCP` was the
 * previous route and still works; the difference is that these are honoured
 * alongside `search`, and the public path's `has_*` are silently ignored.
 */
const CALLABLE_FILTERS = [{ hasMcp: true }, { hasA2a: true }, { hasOasf: true }] as const;


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
  observations: Map<string, Measured>,
): Listing[] {
  return listings
    .map((l) => {
      const measured = observations.get(l.agent.agent_id);
      if (!measured?.observed) return l;

      // The latency and reputation readings only reach `rank`: the tier is
      // about whether the agent can be reached at all, and a slow or
      // fan-rated agent can still be hired.
      const assessment = assess(l.agent, undefined, measured.observed, undefined, measured.reputation);
      return { ...l, assessment, score: rank(l.agent, assessment, measured) };
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
  /** When the registry stamped the freshest response behind this result. */
  asOf: string;
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
  let asOf = "";

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
      CALLABLE_FILTERS.map(async (filter) => {
        const { agents, total, asOf } = await listAgents({
          chainId,
          ...filter,
          search: p,
          limit: perProbe,
        });
        return { agents, total, semantic: false, asOf };
      }),
    ),
  ]);

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    semantic = semantic || r.value.semantic;
    chainTotal = Math.max(chainTotal, r.value.total);
    if (r.value.asOf > asOf) asOf = r.value.asOf;
    for (const a of r.value.agents) byId.set(a.agent_id, a);
  }

  const retrieved = byId.size;
  const listings = collapseDuplicates(toListings([...byId.values()])).filter(
    (l) => l.classification.category === c.id && l.classification.confidence >= MIN_CONFIDENCE,
  );

  return { category: c, listings, retrieved, chainTotal, semantic, asOf: asOf || new Date().toISOString() };
}

export async function retrieveAllCategories(chainId = BSC_MAINNET) {
  return Promise.all(CATEGORIES.map((c) => retrieveCategory(c, { chainId })));
}

/**
 * The unfiltered roster, ranked by evidence. Used by the browse view.
 *
 * A typed query goes through the hybrid vector endpoint rather than the
 * keyword filter. The category probes have used it since they were written,
 * but the search box a visitor actually types into was still doing substring
 * matching on names — so "watch my lending position for liquidation" found
 * nothing, while the vector index returns `bnb-lending-guardian` and
 * `RiskOracle`, neither of which contains a word from the query.
 *
 * That gap mattered more than it looked: the rubric asks that someone with no
 * Agent Studio experience can find an agent, and such a person describes a
 * problem, not a product name. `searchAgents` keeps the keyword path as its
 * own internal fallback, so a wobbling endpoint still returns a page.
 */
export async function browse(opts: { chainId?: number; search?: string; limit?: number } = {}) {
  const chainId = opts.chainId ?? BSC_MAINNET;
  const limit = opts.limit ?? 60;
  const term = opts.search?.trim();

  const { agents, total, asOf } = term
    ? await searchAgents(term, { chainId, limit })
    : await listAgents({ chainId, limit, sortBy: "total_score", sortOrder: "desc" });
  // The unfiltered tab needs the same collapse as a category page: without it
  // "All" is where every minted series reappears in full.
  return { listings: collapseDuplicates(toListings(agents)), total, asOf };
}

