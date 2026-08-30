/**
 * 8004scan (AltLayer) public API client.
 *
 * The roster, reputation and semantic search for every ERC-8004 agent.
 * Docs: https://api.8004scan.io/openapi.json
 *
 * Two namespaces, and the difference is not cosmetic. `/api/v1/public/*`
 * wraps its payload in an envelope, takes camelCase parameters and is what
 * the roster has always been read from. `/api/v1/*` answers unwrapped, takes
 * snake_case, and is the only one that honours the `has_mcp` / `has_a2a` /
 * `has_oasf` / `min_feedbacks` filters — the public path accepts them without
 * complaint and returns the whole 288,000-row roster regardless, which was
 * measured before this comment was written. A filter that fails by returning
 * everything is worse than one that errors.
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
  ScoreV5Schema,
  WalletMetricsSchema,
  VerificationRequestSchema,
  parseAgents,
  type ScanAgent,
  type ScoreHistory,
  type ScanAgentDetail,
  type ScanStats,
  type AgentQuality,
  type ScoreV5,
  type WalletMetrics,
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
/**
 * How long any one registry call may take before it is treated as an outage.
 *
 * Six seconds, not fifteen. Measured on 2026-08-31, the registry answers in
 * 0.3-1.2 s; the ceiling only ever applies to a call that has already gone
 * wrong. Fifteen let one of those hold a streamed section — and the page's
 * open connection — for fifteen seconds, which twice timed out a test that
 * waits for the network to go quiet, and is far past the point where a reader
 * has decided the site is broken. Every section that reads the registry has
 * an honest "could not be read" state; reaching it in six seconds is better
 * than reaching it in fifteen, and much better than not reaching it at all.
 */
export const REGISTRY_TIMEOUT_MS = 6_000;
const BASE = `${ORIGIN}/api/v1/public`;
const API = `${ORIGIN}/api/v1`;

export {
  ScoreHistorySchema,
  ScanAgentSchema,
  ScanAgentDetailSchema,
  ScanStatsSchema,
  AgentQualitySchema,
  ScoreV5Schema,
  WalletMetricsSchema,
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
  ScoreV5,
  V5Dimension,
  WalletMetrics,
  VerificationRequest,
} from "./scan.schema.ts";

type Envelope<T> = {
  success: boolean;
  data: T;
  meta?: {
    timestamp?: string;
    pagination?: { page: number; limit: number; total: number; hasMore: boolean };
  };
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

/**
 * The API key goes in `X-API-Key`. Named by the `XApiKey` security scheme in
 * the OpenAPI document ("8004scan API key for programmatic access and higher
 * rate limits"); the other two schemes there are JWTs for logged-in users,
 * which Kawal is not.
 */
function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (process.env.SCAN_API_KEY) h["X-API-Key"] = process.env.SCAN_API_KEY;
  return h;
}

/**
 * When the registry last spoke to us, as the registry stamps it.
 *
 * Results are held in Next's fetch cache for five minutes, so a page can be
 * rendering a roster read some time ago. Rather than pretend otherwise, every
 * response's own timestamp is kept — the public envelope carries one, and the
 * `date` header stands in elsewhere — and the newest is what a page prints
 * after "registry data as of". A cached response keeps the header it was
 * cached with, which is exactly the age we want to admit to.
 */
let latestAsOf: string | null = null;

function noteAsOf(stamp: string | null | undefined): string {
  const asOf = stamp && !Number.isNaN(Date.parse(stamp)) ? new Date(stamp).toISOString() : new Date().toISOString();
  if (!latestAsOf || asOf > latestAsOf) latestAsOf = asOf;
  return asOf;
}

/** ISO time of the freshest registry response this process has seen, if any. */
export function registryAsOf(): string | null {
  return latestAsOf;
}

type Params = Record<string, string | number | boolean | undefined>;

function withParams(url: URL, params: Params) {
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  return url;
}

async function get<T>(path: string, params: Params = {}) {
  const url = withParams(new URL(BASE + path), params);

  // A category page now costs a dozen upstream calls: each probe is run once
  // against semantic search and once per callable protocol. Rendering that
  // uncached would hammer the API and make every visit slow, so results are
  // held for five minutes — well inside how fast the roster actually moves
  // (roughly 2,000 new registrations a day, none of them urgent).
  //
  // ponytail: Next's fetch cache, not a database. The `next` option is ignored
  // outside Next, so the CLI scripts still read live. Move to Postgres + a
  // cron refresh when we add liveness probes and KPIs.
  // Bounded. During an 8004scan outage the connection was accepted and then
  // held open: the deployed health check took 125 seconds to report that the
  // registry was down, and every page reading the roster hung with it. A
  // registry that has not answered in fifteen seconds is not going to.
  const res = await fetch(url, {
    headers: headers(),
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new ScanError(res.status, path);

  const body = (await res.json()) as Envelope<T>;
  return { body, asOf: noteAsOf(body.meta?.timestamp ?? res.headers.get("date")) };
}

/**
 * The unwrapped `/api/v1` namespace: quality, scores, wallets, feedback and
 * the filtered roster. Same key, same bound, same cache; no envelope.
 */
async function apiGet<T>(path: string, params: Params = {}, revalidate = 300) {
  const url = withParams(new URL(API + path), params);
  const res = await fetch(url, {
    headers: headers(),
    next: { revalidate },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new ScanError(res.status, path);
  return { body: (await res.json()) as T, asOf: noteAsOf(res.headers.get("date")) };
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
  /**
   * Server-side filters. Any of these routes the call through `/api/v1/agents`,
   * the only path that applies them; see the module comment for why the
   * public path cannot be trusted with them.
   */
  hasMcp?: boolean;
  hasA2a?: boolean;
  hasOasf?: boolean;
  minFeedbacks?: number;
  x402Supported?: boolean;
};

type Paged = { items?: unknown; total?: unknown };

export async function listAgents(params: ListParams = {}) {
  const limit = params.limit ?? 50;
  const page = params.page ?? 1;
  const filtered =
    params.hasMcp !== undefined ||
    params.hasA2a !== undefined ||
    params.hasOasf !== undefined ||
    params.minFeedbacks !== undefined ||
    params.x402Supported !== undefined;

  if (filtered) {
    // The public path sorts by `star_count`; this one calls it `stars`.
    const sortBy = params.sortBy === "star_count" ? "stars" : (params.sortBy ?? "total_score");
    const { body, asOf } = await apiGet<Paged>("/agents", {
      chain_id: params.chainId ?? BSC_MAINNET,
      limit,
      offset: (page - 1) * limit,
      search: params.search,
      supported_protocol: params.protocol,
      owner_address: params.ownerAddress,
      sort_by: sortBy,
      sort_order: params.sortOrder ?? "desc",
      is_testnet: params.isTestnet,
      has_mcp: params.hasMcp,
      has_a2a: params.hasA2a,
      has_oasf: params.hasOasf,
      min_feedbacks: params.minFeedbacks,
      x402_supported: params.x402Supported,
    });
    const { agents } = parseAgents(body.items);
    return { agents, total: typeof body.total === "number" ? body.total : agents.length, asOf };
  }

  const { body, asOf } = await get<unknown[]>("/agents", {
    chainId: params.chainId ?? BSC_MAINNET,
    page,
    limit,
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
  return { agents, total: body.meta?.pagination?.total ?? 0, asOf };
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
): Promise<{ agents: ScanAgent[]; total: number; semantic: boolean; asOf: string }> {
  const limit = opts.limit ?? 40;
  const chainId = opts.chainId ?? BSC_MAINNET;

  try {
    const { body, asOf } = await get<unknown[]>("/agents/search", {
      q,
      limit,
      chainId,
      semanticWeight: opts.semanticWeight,
    });
    const { agents } = parseAgents(body.data);
    if (agents.length) return { agents, total: agents.length, semantic: true, asOf };
  } catch {
    // fall through to keyword search
  }

  const { agents, total, asOf } = await listAgents({ chainId, search: q, limit });
  return { agents, total, semantic: false, asOf };
}

export async function getAgent(chainId: number, tokenId: string) {
  const { body } = await get<unknown>(`/agents/${chainId}/${tokenId}`);
  // A detail page has one row and no fallback, so a shape we cannot parse is
  // a hard failure rather than a silent drop — the caller already renders a
  // 404 for a missing agent, which is the honest outcome either way.
  return ScanAgentDetailSchema.parse(body.data) satisfies ScanAgentDetail;
}

/**
 * Quality Center data: liveness, latency, domain verification and risk flags.
 *
 * Worth the exception to the envelope path — this is the only endpoint that
 * answers "is this thing actually up right now", which is the difference
 * between a directory and a marketplace.
 */
export async function getQuality(
  chainId: number,
  tokenId: string,
): Promise<AgentQuality | null> {
  try {
    const { body } = await apiGet<unknown>(`/agents/${chainId}/${tokenId}/quality`);
    const parsed = AgentQualitySchema.safeParse(body);
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
 */
export async function getScoreHistory(
  chainId: number,
  tokenId: string,
): Promise<ScoreHistory | null> {
  try {
    const { body } = await apiGet<unknown>(`/agents/score-history/${chainId}/${tokenId}`, {}, 3600);
    const parsed = ScoreHistorySchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  } catch {
    // A missing trend must not blank the agent page.
    return null;
  }
}

/**
 * The v5 breakdown behind `total_score`: engagement, service, publisher,
 * compliance, momentum. One number on a listing is an opinion; five weighted
 * ones with an explanation each is something a reader can disagree with.
 */
export async function getScoreV5(chainId: number, tokenId: string): Promise<ScoreV5 | null> {
  try {
    const { body } = await apiGet<unknown>(`/agents/scores/v5/${chainId}/${tokenId}`, {}, 3600);
    const parsed = ScoreV5Schema.safeParse(body);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type TrendingPeriod = "24h" | "7d" | "30d";

/**
 * What 8004scan's visitors are looking at: `view_count / (hours + 2)^1.5`, by
 * the API's own description. Attention, not evidence — shown as such.
 */
export async function getTrending(
  period: TrendingPeriod = "24h",
  opts: { chainId?: number; limit?: number } = {},
) {
  const { body, asOf } = await apiGet<Paged>("/agents/trending", {
    period,
    chain_id: opts.chainId ?? BSC_MAINNET,
    limit: opts.limit ?? 10,
  }, 60);
  const { agents } = parseAgents(body.items);
  return { agents, total: typeof body.total === "number" ? body.total : agents.length, asOf };
}

/**
 * On-chain facts about the wallet behind a registration: age, transaction
 * count, x402 revenue, whether it is a contract. Null when 8004scan has never
 * indexed the address, which it answers with a 404 rather than an empty row.
 */
export async function getWalletMetrics(address: string): Promise<WalletMetrics | null> {
  try {
    const { body } = await apiGet<unknown>(`/wallets/${address}/metrics`, {}, 120);
    const parsed = WalletMetricsSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Reads a JSON document back off IPFS through 8004scan's gateway fan-out.
 *
 * No login needed. Content-addressed, so it is held for an hour: the bytes
 * behind a CID cannot change, only fail to be found. Null when no gateway
 * had it or it was not JSON — a record whose evidence is unreachable is a
 * finding for `--verify`, not an exception.
 */
export async function fetchEvidence(cid: string): Promise<unknown | null> {
  try {
    const { body } = await apiGet<{ cid?: string; content?: unknown }>("/ipfs/fetch", { cid }, 3600);
    return body.content ?? null;
  } catch {
    return null;
  }
}

export type Verification =
  | { queued: true; estimatedCheckAt: string | null }
  /** 8004scan allows one request an hour per agent; this is the second. */
  | { queued: false; reason: "rate-limited"; retryAt: string | null }
  | { queued: false; reason: "refused"; status: number };

/**
 * Asks 8004scan to re-verify an agent's endpoint domain against its
 * `.well-known/agent-registration.json`. No auth, one an hour per agent —
 * the 429 carries the time it may be asked again and is an outcome, not an
 * error, because the sweep will hit it on every agent it has already asked
 * about this hour.
 *
 * The one registry call Kawal makes that is not a read. It changes nothing
 * about the agent; it asks the registry to look, which is what the sweep just
 * did itself.
 */
export async function verifyEndpoint(chainId: number, tokenId: string): Promise<Verification> {
  const path = `/agents/verify-endpoint/${chainId}/${tokenId}`;
  const res = await fetch(API + path, {
    method: "POST",
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
    const at = typeof body.detail === "string" ? body.detail.match(/\d{4}-\d{2}-\d{2}T[\d:.+]+/)?.[0] : null;
    return { queued: false, reason: "rate-limited", retryAt: at ?? null };
  }
  if (!res.ok) return { queued: false, reason: "refused", status: res.status };
  const parsed = VerificationRequestSchema.safeParse(await res.json());
  // A 200 that says `queued: false` has not been seen; if it ever arrives it
  // is a refusal with a friendlier status, and is filed as one.
  if (parsed.success && !parsed.data.queued) return { queued: false, reason: "refused", status: res.status };
  return { queued: true, estimatedCheckAt: parsed.success ? parsed.data.estimated_check_at : null };
}

export async function getStats() {
  const { body } = await get<unknown>("/stats");
  return ScanStatsSchema.parse(body.data) satisfies ScanStats;
}

export function bscStats(stats: ScanStats) {
  return stats.chain_stats.find((c) => c.chain_id === BSC_MAINNET);
}
