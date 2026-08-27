/**
 * 8004scan (AltLayer) public API client.
 *
 * The roster, reputation and semantic search for every ERC-8004 agent.
 * Docs: https://8004scan.io/api/v1/public/docs/openapi.json
 *
 * What this API does NOT give us, and what Kawal therefore has to build:
 *   - no category  -> lib/taxonomy.ts
 *   - no endpoint  -> onchain resolution against the identity registry
 *   - no liveness  -> our own probe
 */

import { BSC_MAINNET } from "./chains.ts";
import {
  ScanAgentDetailSchema,
  ScanStatsSchema,
  AgentQualitySchema,
  ScoreHistorySchema,
  parseAgents,
  type ScanAgent,
  type ScoreHistory,
  type ScanAgentDetail,
  type ScanStats,
  type AgentQuality,
} from "./scan.schema.ts";

/**
 * The registry Kawal reads, overridable for testing.
 *
 * Every upstream call happens server-side, so a browser cannot intercept one:
 * pointing Playwright at a route it never sees would have tested nothing. An
 * env override lets a test start the app against a host that refuses
 * connections and prove the empty-registry path is real rather than assumed.
 *
 * Also useful in anger: 8004scan has gone down for a day during this build.
 */
const ORIGIN = process.env.SCAN_API_ORIGIN ?? "https://8004scan.io";
const BASE = `${ORIGIN}/api/v1/public`;

export {
  ScoreHistorySchema,
  ScanAgentSchema,
  ScanAgentDetailSchema,
  ScanStatsSchema,
  AgentQualitySchema,
  parseAgents,
} from "./scan.schema.ts";
export type {
  ScoreHistory,
  ScorePoint,
  ScanAgent,
  ScanAgentDetail,
  ChainStat,
  ScanStats,
  AgentQuality,
  ServiceHealth,
  RiskFlag,
  QualityDimension,
} from "./scan.schema.ts";

type Envelope<T> = {
  success: boolean;
  data: T;
  meta?: { pagination?: { page: number; limit: number; total: number; hasMore: boolean } };
};

export class ScanError extends Error {
  status: number;
  path: string;
  // Parameter properties are unsupported by Node's type stripping, which the
  // audit and check scripts run under. Plain assignment keeps them runnable.
  constructor(status: number, path: string) {
    super(`8004scan ${path} failed with HTTP ${status}`);
    this.status = status;
    this.path = path;
  }
}

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { accept: "application/json" };
  // Pro tier lifts us from 10 req/min to 500. Header name to be confirmed
  // against the Developer Hub once the key is issued.
  if (process.env.SCAN_API_KEY) headers["x-api-key"] = process.env.SCAN_API_KEY;

  // A category page now costs a dozen upstream calls: each probe is run once
  // against semantic search and once per callable protocol. Rendering that
  // uncached would hammer the API and make every visit slow, so results are
  // held for five minutes — well inside how fast the roster actually moves
  // (roughly 2,000 new registrations a day, none of them urgent).
  //
  // ponytail: Next's fetch cache, not a database. The `next` option is ignored
  // outside Next, so the CLI scripts still read live. Move to Postgres + a
  // cron refresh when we add liveness probes and KPIs.
  const res = await fetch(url, { headers, next: { revalidate: 300 } });
  if (!res.ok) throw new ScanError(res.status, path);

  const body = (await res.json()) as Envelope<T>;
  return body;
}

export type ListParams = {
  chainId?: number;
  page?: number;
  limit?: number;
  search?: string;
  protocol?: string;
  ownerAddress?: string;
  sortBy?: "total_score" | "created_at" | "star_count" | "total_feedbacks";
  sortOrder?: "asc" | "desc";
  isTestnet?: boolean;
};

export async function listAgents(params: ListParams = {}) {
  const body = await get<unknown[]>("/agents", {
    chainId: params.chainId ?? BSC_MAINNET,
    page: params.page ?? 1,
    limit: params.limit ?? 50,
    search: params.search,
    protocol: params.protocol,
    ownerAddress: params.ownerAddress,
    sortBy: params.sortBy ?? "total_score",
    sortOrder: params.sortOrder ?? "desc",
    isTestnet: params.isTestnet === undefined ? undefined : String(params.isTestnet),
  });
  // Rows that cannot be understood are dropped rather than trusted. One odd
  // registration in a roster of 280,000 must not take a page down.
  const { agents } = parseAgents(body.data);
  return { agents, total: body.meta?.pagination?.total ?? 0 };
}

/**
 * Hybrid vector + keyword search.
 *
 * /agents/search was returning 502 for every query through mid-August 2026 and
 * is answering again as of 26 Aug, so this is the live path rather than the
 * fallback. The keyword fallback stays: a category page that goes blank when
 * one upstream endpoint wobbles is not a marketplace, and this endpoint has
 * already proven it wobbles.
 */
export async function searchAgents(
  q: string,
  opts: { limit?: number; chainId?: number; semanticWeight?: number } = {},
): Promise<{ agents: ScanAgent[]; total: number; semantic: boolean }> {
  const limit = opts.limit ?? 40;
  const chainId = opts.chainId ?? BSC_MAINNET;

  try {
    const body = await get<unknown[]>("/agents/search", {
      q,
      limit,
      chainId,
      semanticWeight: opts.semanticWeight,
    });
    const { agents } = parseAgents(body.data);
    if (agents.length) return { agents, total: agents.length, semantic: true };
  } catch {
    // fall through to keyword search
  }

  const { agents, total } = await listAgents({ chainId, search: q, limit });
  return { agents, total, semantic: false };
}

export async function getAgent(chainId: number, tokenId: string) {
  const body = await get<unknown>(`/agents/${chainId}/${tokenId}`);
  // A detail page has one row and no fallback, so a shape we cannot parse is
  // a hard failure rather than a silent drop — the caller already renders a
  // 404 for a missing agent, which is the honest outcome either way.
  return ScanAgentDetailSchema.parse(body.data) satisfies ScanAgentDetail;
}

/**
 * Quality Center data: liveness, latency, domain verification and risk flags.
 *
 * Lives outside the `/public` namespace and returns its payload unwrapped, so
 * it does not go through `get()`. Worth the exception — this is the only
 * endpoint that answers "is this thing actually up right now", which is the
 * difference between a directory and a marketplace.
 */
export async function getQuality(
  chainId: number,
  tokenId: string,
): Promise<AgentQuality | null> {
  try {
    const res = await fetch(
      `${ORIGIN}/api/v1/agents/${chainId}/${tokenId}/quality`,
      { headers: { accept: "application/json" }, next: { revalidate: 300 } },
    );
    if (!res.ok) return null;
    const parsed = AgentQualitySchema.safeParse(await res.json());
    return parsed.success ? (parsed.data satisfies AgentQuality) : null;
  } catch {
    // A missing health report must not blank out the agent page: the
    // registration data is still worth showing on its own.
    return null;
  }
}

/**
 * Thirty days of scoring for one agent.
 *
 * A snapshot says how an agent is doing; this says which way it is going, and
 * the two disagree often enough to matter — a score of 30 that has been
 * climbing is a different proposition from a 30 that has been falling.
 *
 * Lives outside the `/public` namespace and returns its payload unwrapped, so
 * it does not go through `get()`.
 */
export async function getScoreHistory(
  chainId: number,
  tokenId: string,
): Promise<ScoreHistory | null> {
  try {
    const res = await fetch(
      `${ORIGIN}/api/v1/agents/score-history/${chainId}/${tokenId}`,
      { headers: { accept: "application/json" }, next: { revalidate: 3600 } },
    );
    if (!res.ok) return null;
    const parsed = ScoreHistorySchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    // A missing trend must not blank the agent page.
    return null;
  }
}

export async function getStats() {
  const body = await get<unknown>("/stats");
  return ScanStatsSchema.parse(body.data) satisfies ScanStats;
}

export function bscStats(stats: ScanStats) {
  return stats.chain_stats.find((c) => c.chain_id === BSC_MAINNET);
}
