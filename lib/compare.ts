import { getAgent, getQuality, getScoreHistory, getScoreV5 } from "@/lib/scan";
import { proveAgent, type EndpointProof } from "@/lib/probe";
import { uptimeFor, observedFor, type Uptime } from "@/lib/uptime";
import { checkX402Cached, type X402Check } from "@/lib/x402";
import { getReputationCached, type Reputation } from "@/lib/reputation";
import { classify, type CategoryId } from "@/lib/taxonomy";
import { assess, type Assessment } from "@/lib/signals";
import { categoryLabel, seatColor } from "@/components/listing";
import type { ScanAgentDetail, AgentQuality, ScoreHistory, ScoreV5 } from "@/lib/scan";

/**
 * The comparison, as data.
 *
 * Form K-4 and the `compare_agents` tool ask the same questions of each
 * agent; this is the one place those questions are asked, so the HTML and
 * the JSON-RPC answer cannot drift apart.
 */

export const MAX_COLUMNS = 3;

export type Column = {
  ref: string;
  color: string;
  agent: ScanAgentDetail;
  quality: AgentQuality | null;
  history: ScoreHistory | null;
  /** The five weighted parts behind the registry's one number; null when it has not scored this agent under v5. */
  scoreV5: ScoreV5 | null;
  proof: EndpointProof | null;
  uptime: Uptime | null;
  /** What the server said when asked to charge; null when nothing claimed x402 or nothing could be called. */
  payment: X402Check | null;
  /** Who wrote the feedback; null when the records could not be read. */
  reputation: Reputation | null;
  assessment: Assessment;
  categoryId: CategoryId | null;
  category: string;
  confidence: number;
  /** ISO time of the newest thing Kawal did for this column. */
  checkedAt: string;
};

export type Ref = { chainId: number; tokenId: string };

export type ParsedRefs = {
  refs: Ref[];
  /** Parts that were not `chain:token`, so the form can say so rather than drop them silently. */
  rejected: number;
  /** Readable refs past the third, ignored. */
  truncated: number;
};

/**
 * Parses ids into chain/token pairs.
 *
 * Takes both spellings a browser produces: `?ids=56:1,56:2` from a typed
 * address, and `?ids=56:1&ids=56:2` from a form of tick boxes. Nothing odd is
 * kept, but it is counted — a visitor who mistyped one id deserves to be told
 * which of their three columns is missing and why.
 */
export function parseRefs(raw: string | string[] | undefined): ParsedRefs {
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];

  const seen = new Set<string>();
  const refs: Ref[] = [];
  let rejected = 0;
  let truncated = 0;

  for (const part of values.flatMap((v) => v.split(","))) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const [chain, token, ...rest] = trimmed.split(":");
    const chainId = Number(chain);
    if (rest.length > 0 || !Number.isInteger(chainId) || chainId <= 0 || !token || !/^\d+$/.test(token)) {
      rejected++;
      continue;
    }
    const key = `${chainId}:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (refs.length === MAX_COLUMNS) {
      truncated++;
      continue;
    }
    refs.push({ chainId, tokenId: token });
  }
  return { refs, rejected, truncated };
}

export async function loadColumn(chainId: number, tokenId: string): Promise<Column | null> {
  const agent = await getAgent(chainId, tokenId).catch(() => null);
  if (!agent) return null;

  const [quality, proof, history, reputation, scoreV5] = await Promise.all([
    getQuality(chainId, tokenId),
    proveAgent(agent),
    getScoreHistory(chainId, tokenId),
    getReputationCached(chainId, tokenId, agent),
    getScoreV5(chainId, tokenId),
  ]);

  // Same rule as the inspection sheet: only an agent that claims to charge is
  // asked to, and only where there is an endpoint to ask.
  const payment =
    agent.x402_supported === true && proof?.endpoint ? await checkX402Cached(proof.endpoint) : null;

  const [uptime, observed] = await Promise.all([
    proof ? uptimeFor(proof.endpoint) : null,
    observedFor(proof?.endpoint),
  ]);

  const classification = classify(agent.name, agent.description);
  return {
    ref: `${chainId}:${tokenId}`,
    agent,
    quality,
    proof,
    uptime,
    payment,
    reputation,
    history,
    scoreV5,
    assessment: assess(
      agent,
      undefined,
      observed && { ...observed, reachedAnotherWay: proof?.descriptor != null },
      payment ? { demanded: payment.demanded } : undefined,
      reputation,
      quality,
    ),
    categoryId: classification.category,
    category: categoryLabel(classification.category),
    confidence: classification.confidence,
    color: seatColor(classification.category),
    checkedAt: [proof?.checkedAt, payment?.checkedAt, reputation?.checkedAt]
      .filter((t): t is string => typeof t === "string")
      .sort()
      .at(-1) ?? new Date().toISOString(),
  };
}

