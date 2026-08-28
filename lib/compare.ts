import { getAgent, getQuality, getScoreHistory } from "@/lib/scan";
import { proveAgent, type EndpointProof } from "@/lib/probe";
import { uptimeFor, observedFor, type Uptime } from "@/lib/uptime";
import { classify } from "@/lib/taxonomy";
import { assess, type Assessment } from "@/lib/signals";
import { categoryLabel, seatColor } from "@/components/listing";
import type { ScanAgentDetail, AgentQuality, ScoreHistory } from "@/lib/scan";

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
  proof: EndpointProof | null;
  uptime: Uptime | null;
  assessment: Assessment;
  category: string;
  confidence: number;
};

/** Parses "56:43129,56:45422" into chain/token pairs, dropping anything odd. */
export function parseRefs(raw: string | string[] | undefined): Array<{ chainId: number; tokenId: string }> {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return [];

  const seen = new Set<string>();
  const out: Array<{ chainId: number; tokenId: string }> = [];
  for (const part of value.split(",")) {
    const [chain, token] = part.trim().split(":");
    const chainId = Number(chain);
    if (!Number.isInteger(chainId) || chainId <= 0) continue;
    if (!token || !/^\d+$/.test(token)) continue;
    const key = `${chainId}:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chainId, tokenId: token });
    if (out.length === MAX_COLUMNS) break;
  }
  return out;
}

export async function loadColumn(chainId: number, tokenId: string): Promise<Column | null> {
  const agent = await getAgent(chainId, tokenId).catch(() => null);
  if (!agent) return null;

  const [quality, proof, history] = await Promise.all([
    getQuality(chainId, tokenId),
    proveAgent(agent),
    getScoreHistory(chainId, tokenId),
  ]);

  const classification = classify(agent.name, agent.description);
  return {
    ref: `${chainId}:${tokenId}`,
    agent,
    quality,
    proof,
    uptime: proof ? await uptimeFor(proof.endpoint) : null,
    history,
    assessment: assess(agent, undefined, await observedFor(proof?.endpoint)),
    category: categoryLabel(classification.category),
    confidence: classification.confidence,
    color: seatColor(classification.category),
  };
}

