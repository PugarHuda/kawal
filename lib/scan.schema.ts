/**
 * The shape 8004scan actually returns, checked at runtime.
 *
 * Every response used to be cast straight to a hand-written type — `as
 * ScanAgent[]` and nothing else — which meant the compiler was reassuring us
 * about a foreign server's JSON. Two bugs came out of exactly that gap:
 * `services` was declared as an array when the API returns an object, so
 * `services.mcp` was unreachable; and a missing `total_score` would reach
 * `.toFixed(2)` and take the agent page down with a TypeError.
 *
 * Types are derived from these schemas rather than written alongside them, so
 * the description and the check cannot drift apart again.
 *
 * The parsing is deliberately lenient about *rows* and strict about *fields*:
 * one malformed agent is dropped and counted, never allowed to blank a whole
 * category. A registry with 280,000 entries will always contain something
 * strange, and a marketplace that dies on the strangest one is not a
 * marketplace.
 */

import { z } from "zod";

/** Anything the API may legitimately omit or null out. */
const nullableString = z.string().nullable().catch(null);
const nullableNumber = z.number().nullable().catch(null);

export const ScanAgentSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  token_id: z.string(),
  chain_id: z.number(),
  chain_type: z.string().catch("evm"),
  contract_address: z.string(),
  is_testnet: z.boolean().catch(false),
  owner_address: z.string().catch(""),
  owner_ens: nullableString,
  owner_username: nullableString,
  owner_publisher_tier: nullableString,
  owner_certified_name: nullableString,
  name: z.string(),
  description: nullableString,
  image_url: nullableString,
  is_verified: z.boolean().catch(false),
  star_count: z.number().catch(0),
  // The values arrive capitalised ("MCP", "A2A", "Web"). Normalising here
  // would hide that from the protocol filter, which is case-sensitive
  // upstream, so they are kept verbatim and compared case-insensitively.
  supported_protocols: z.array(z.string()).catch([]),
  x402_supported: z.boolean().catch(false),
  total_score: z.number().catch(0),
  rank: nullableNumber,
  network_rank: nullableNumber,
  health_score: nullableNumber,
  total_feedbacks: z.number().catch(0),
  average_score: z.number().catch(0),
  created_at: z.string(),
  updated_at: z.string().catch(""),
});

const DeclaredServiceSchema = z.object({
  endpoint: z.string().optional(),
  version: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

export const ScanAgentDetailSchema = ScanAgentSchema.extend({
  agent_type: nullableString,
  agent_wallet: nullableString,
  creator_address: nullableString,
  watch_count: z.number().catch(0),
  tags: z.array(z.string()).catch([]),
  categories: z.array(z.string()).catch([]),
  /** Keyed by protocol — "mcp", "web", "oasf". An object, not an array. */
  services: z.record(z.string(), DeclaredServiceSchema).nullable().catch(null),
  scores: z.unknown().nullable().catch(null),
  created_block_number: nullableNumber,
  /**
   * Whether 8004scan is where this row came from.
   *
   * Absent on everything the index returns, so it defaults to true. A row
   * built from the Identity Registry because the index had never heard of the
   * token sets it false, and pages say so rather than presenting a thin row as
   * if it were a scored one.
   */
  indexed: z.boolean().catch(true),
});

export const ChainStatSchema = z.object({
  chain_id: z.number(),
  name: z.string().catch(""),
  is_testnet: z.boolean().catch(false),
  total_agents: z.number().catch(0),
  daily_new_agents: z.number().catch(0),
  total_feedbacks: z.number().catch(0),
  average_feedback_score: nullableNumber,
  mcp_agents: z.number().catch(0),
  a2a_agents: z.number().catch(0),
  oasf_agents: z.number().catch(0),
});

export const ScanStatsSchema = z.object({
  total_agents: z.number().catch(0),
  total_users: z.number().catch(0),
  total_feedbacks: z.number().catch(0),
  daily_new_agents: z.number().catch(0),
  average_feedback_score: z.number().catch(0),
  chain_stats: z.array(ChainStatSchema).catch([]),
  protocol_distribution: z.record(z.string(), z.number()).catch({}),
});

const ServiceHealthSchema = z.object({
  key: z.string(),
  label: z.string().catch(""),
  status: z.enum(["healthy", "degraded", "unhealthy", "unknown", "skipped"]).catch("unknown"),
  message: nullableString,
  latency_ms: nullableNumber,
  checked_at: nullableString,
  domain: nullableString,
  domain_verified: z.boolean().catch(false),
  verification_status: nullableString,
  verification_error: nullableString,
});

const RiskFlagSchema = z.object({
  id: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]).catch("low"),
  category: z.string().catch(""),
  title: z.string().catch(""),
  description: z.string().catch(""),
  source: z.string().catch(""),
});

const QualityDimensionSchema = z.object({
  key: z.string(),
  label: z.string().catch(""),
  score: z.number().catch(0),
  weight: z.number().catch(0),
  weighted_score: z.number().catch(0),
});

export const AgentQualitySchema = z.object({
  agent_id: z.string(),
  generated_at: z.string().catch(""),
  score: z
    .object({
      total_score: z.number().catch(0),
      last_scored_at: nullableString,
      version: z.string().catch(""),
      dimensions: z.array(QualityDimensionSchema).catch([]),
    })
    .catch({ total_score: 0, last_scored_at: null, version: "", dimensions: [] }),
  endpoint_health: z
    .object({
      overall_status: z.string().catch("unknown"),
      health_score: nullableNumber,
      checked_at: nullableString,
      declared_services_count: z.number().catch(0),
      services: z.array(ServiceHealthSchema).catch([]),
    })
    .nullable()
    .catch(null),
  metadata_validation: z
    .object({
      status: z.string().catch("unknown"),
      counts: z
        .object({
          errors: z.number().catch(0),
          warnings: z.number().catch(0),
          info: z.number().catch(0),
        })
        .catch({ errors: 0, warnings: 0, info: 0 }),
    })
    .nullable()
    .catch(null),
  risk_flags: z.array(RiskFlagSchema).catch([]),
});

/**
 * One day's scoring snapshot.
 *
 * Only the fields Kawal reads are named; 8004scan sends a dozen more
 * sub-scores per point and this schema is not strict, so extras pass through
 * untouched rather than failing the row.
 */
const ScorePointSchema = z.object({
  scored_at: z.string(),
  total_score: z.number().catch(0),
  total_feedbacks: z.number().catch(0),
  total_stars: z.number().catch(0),
});

/**
 * A score's direction over the last month, which a snapshot cannot show.
 *
 * Most BSC registrations have no history at all — the chain adds thousands a
 * day — so `insufficient_data` is the common answer and a real signal in its
 * own right: nothing has been observed about this agent over time yet.
 */
export const ScoreHistorySchema = z.object({
  period_days: z.number().catch(30),
  data_points: z.number().catch(0),
  history: z.array(ScorePointSchema).catch([]),
  current_score: z.number().nullable().catch(null),
  score_trend: z.string().catch("insufficient_data"),
  score_change: z.number().nullable().catch(null),
});

/**
 * One of the five v5 dimensions. `details` differs per dimension and is kept
 * as-is: the service block, for instance, carries the tool count 8004scan's
 * own health check saw, which is worth printing next to Kawal's.
 */
const V5DimensionSchema = z.object({
  score: z.number().catch(0),
  weight: z.number().catch(0),
  weighted_score: z.number().catch(0),
  explanation: z.string().catch(""),
  details: z.record(z.string(), z.unknown()).catch({}),
});

/**
 * The v5 score breakdown, read live off `/agents/scores/v5/56/43129`.
 *
 * Every dimension is nullable because the endpoint says it "falls back to a
 * legacy response" for agents not yet scored under v5 — and that response has
 * none of them.
 */
export const ScoreV5Schema = z.object({
  agent_id: z.string(),
  agent_name: z.string().catch(""),
  total_score: z.number().catch(0),
  last_scored_at: nullableString,
  version: z.string().catch(""),
  algorithm: z.string().catch(""),
  engagement: V5DimensionSchema.nullable().catch(null),
  service: V5DimensionSchema.nullable().catch(null),
  publisher: V5DimensionSchema.nullable().catch(null),
  compliance: V5DimensionSchema.nullable().catch(null),
  momentum: V5DimensionSchema.nullable().catch(null),
  weights: z.record(z.string(), z.number()).catch({}),
});

/**
 * What 8004scan knows about a wallet from the chain itself.
 *
 * `balance` and `total_revenue` are wei as decimal strings — wider than a
 * double — and are left as strings for the same reason feedback `value` is.
 */
export const WalletMetricsSchema = z.object({
  address: z.string(),
  primary_chain_id: nullableNumber,
  ens_name: nullableString,
  balance: z.string().catch("0"),
  tx_count: z.number().catch(0),
  wallet_age_days: z.number().catch(0),
  first_tx_at: nullableString,
  last_tx_at: nullableString,
  payment_count: z.number().catch(0),
  total_revenue: z.string().catch("0"),
  is_agent_wallet: z.boolean().catch(false),
  is_contract: z.boolean().catch(false),
  metrics_updated_at: nullableString,
  total_associated_agents: z.number().catch(0),
});

/** An owner's on-chain `appendResponse` to a feedback record. */
export const FeedbackReplySchema = z.object({
  id: z.string().catch(""),
  feedback_id: z.string().catch(""),
  responder_address: z.string().catch(""),
  response_uri: nullableString,
  offchain_data: z.record(z.string(), z.unknown()).nullable().catch(null),
  transaction_hash: z.string().catch(""),
  responded_at: z.string().catch(""),
});

/** `POST /agents/verify-endpoint/{c}/{t}` on success. */
export const VerificationRequestSchema = z.object({
  message: z.string().catch(""),
  queued: z.boolean().catch(true),
  estimated_check_at: nullableString,
});

export type ScoreV5 = z.infer<typeof ScoreV5Schema>;
export type V5Dimension = z.infer<typeof V5DimensionSchema>;
export type WalletMetrics = z.infer<typeof WalletMetricsSchema>;
export type FeedbackReply = z.infer<typeof FeedbackReplySchema>;
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;

export type ScorePoint = z.infer<typeof ScorePointSchema>;
export type ScoreHistory = z.infer<typeof ScoreHistorySchema>;

export type ScanAgent = z.infer<typeof ScanAgentSchema>;
export type ScanAgentDetail = z.infer<typeof ScanAgentDetailSchema>;
export type ChainStat = z.infer<typeof ChainStatSchema>;
export type ScanStats = z.infer<typeof ScanStatsSchema>;
export type AgentQuality = z.infer<typeof AgentQualitySchema>;
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;
export type RiskFlag = z.infer<typeof RiskFlagSchema>;
export type QualityDimension = z.infer<typeof QualityDimensionSchema>;

/**
 * Parses a list, dropping rows that cannot be understood.
 *
 * Returns the survivors and how many were dropped, so a caller can surface
 * the loss instead of quietly showing a shorter list.
 */
export function parseAgents(rows: unknown): { agents: ScanAgent[]; dropped: number } {
  if (!Array.isArray(rows)) return { agents: [], dropped: 0 };

  const agents: ScanAgent[] = [];
  let dropped = 0;
  for (const row of rows) {
    const result = ScanAgentSchema.safeParse(row);
    if (result.success) agents.push(result.data);
    else dropped++;
  }
  return { agents, dropped };
}
