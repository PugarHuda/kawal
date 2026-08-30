/**
 * Is an agent's "track record" made of reviews, or of something else?
 *
 * Kawal refuses to take the registry's word about interfaces, and refuses it
 * about payment. Reputation was the one claim still passed through verbatim:
 * `assess` printed "N feedbacks, average X" straight off the registration.
 *
 * A sample of 1,200 BSC records taken from both ends of the register says two
 * different things, and the difference is the point.
 *
 * The numbers are real. All 1,200 carry an ERC-8004 `value`, spread across 23
 * distinct marks — 70 and 85 are commoner than 100 — so this is a graded
 * register, not an empty one. An early draft of this file called it empty and
 * was wrong.
 *
 * What is thin is who wrote them. Fifty-three addresses account for all 1,200,
 * and at the old end of the register a single address wrote 265 of 600 under
 * the tag `get top 1 rank >`. Nine of ten of those records are one party's
 * opinion repeated, which an average silently turns into a consensus.
 *
 * Separately, 8004scan's own normalised `score` field — the one an
 * `average_score` is computed from — is null on 1,192 of the 1,200. The mark
 * the ecosystem publishes is taken over a field almost nothing populates,
 * while the marks that exist sit in a field it does not read.
 *
 * So this asks who wrote the records rather than whether they exist. An agent
 * with forty feedbacks from one address does not have a track record; it has
 * a fan.
 *
 * Run `npm run reputation` for today's figures rather than trusting these.
 *
 * What this deliberately does not do is call anyone a liar. Concentration has
 * innocent explanations — an uptime prober like GEBO writes hundreds of honest
 * records — so the numbers are reported and the reader draws the conclusion,
 * exactly as the MCP probe reports silence without calling it fraud.
 */

import { memo } from "./memo.ts";
import { getAgent } from "./scan.ts";
import { FeedbackReplySchema } from "./scan.schema.ts";

const ORIGIN = process.env.SCAN_API_ORIGIN ?? "https://8004scan.io";

/**
 * How many records are pulled per agent.
 *
 * Chain-wide there are roughly 11,700 feedbacks across 280,000 agents, so a
 * hundred covers essentially every agent whole. An agent that exceeds it is
 * already so far from the norm that the sample tells the reader what they came
 * for, and `total` still reports the true count.
 */
const SAMPLE = 100;

export type Reputation = {
  /** Records the registry holds, before sampling. */
  total: number;
  /** Records read to compute everything below. */
  sampled: number;
  /** Of those, how many carry an ERC-8004 `value` — a mark somebody set. */
  valued: number;
  /**
   * How many carry 8004scan's normalised `score`.
   *
   * Kept separate from `valued` because they measure different things and the
   * gap between them is itself worth seeing: null on 1,192 of 1,200 sampled,
   * which is what every published `average_score` is computed over.
   */
  scored: number;
  /** Of those, how many carry a written comment. */
  commented: number;
  /** Records the writer later withdrew. */
  revoked: number;
  /** Separate addresses that wrote them. */
  raters: number;
  /** Share of the sample written by the single busiest address, 0..1. */
  topRaterShare: number;
  /** The busiest address, so a reader can go and look at it. */
  topRater: string | null;
  checkedAt: string;
  /**
   * What the busiest address tagged its records, most used first. A wall of
   * `get top 1 rank >` reads differently from a spread of `uptime` and
   * `accuracy`, and the count alone cannot show which it is.
   */
  topRaterTags: Array<{ tag: string; count: number }>;
  /** The two most recent written comments, newest first. */
  recentComments: Array<{ by: string; at: string | null; comment: string; tag: string | null }>;
  /**
   * The owner's on-chain answers — ERC-8004 `appendResponse` — across the
   * sample. An owner who replies to feedback is running the agent; a record
   * with none tells you nothing either way, so this is shown, not scored.
   */
  replies: Array<{ feedbackId: string; by: string; at: string | null; uri: string | null }>;
  /**
   * Records written by the agent's own side: a rater whose address is the
   * agent's wallet, its owner, or the address that minted it. A count that
   * includes them is an agent grading itself. Shown, and named in the
   * verdict, rather than subtracted: the reader should see it was done.
   *
   * Rarer than it sounds, and the reason is on-chain: simulated against the
   * live BSC registry, `giveFeedback` from an agent's owner reverts with
   * `Self-feedback not allowed`. What the contract cannot see is a wallet
   * set apart from the owner with `setAgentWallet` — a hundred of the 445
   * BSC agents with feedback have one — or the address that minted a token
   * since transferred. Across all 11,730 BSC records and 66 writers on 29
   * Aug 2026, none had done either; the count is zero everywhere today and
   * this is the check that notices the first one.
   */
  selfRated: number;
  /** Which of the insider addresses did it, lowercased. */
  selfRaters: string[];
};

/**
 * The addresses that are the agent, for the purpose of `selfRated`. The
 * three 8004scan publishes on a registration; `agentWalletOf` in feedback.ts
 * reads the first from the chain if the registry's copy is in doubt.
 */
export type Insiders = {
  agent_wallet?: string | null;
  owner_address?: string | null;
  creator_address?: string | null;
};

type FeedbackRow = {
  score?: number | null;
  /** Atomic, scaled by `value_decimals`. Arrives as a string or a number. */
  value?: string | number | null;
  value_decimals?: number | null;
  comment?: string | null;
  is_revoked?: boolean | null;
  user_address?: string | null;
  tag1?: string | null;
  tag2?: string | null;
  feedback_id?: string | null;
  submitted_at?: string | null;
  created_at?: string | null;
  /**
   * Present when `include_replies` was asked for: up to ten, embedded. The
   * separate `/feedbacks/{id}/replies` endpoint exists for the eleventh
   * onward, which nothing on BSC has, so it is not called.
   */
  replies?: { items?: unknown[] | null } | null;
};

/**
 * A record carries a mark when `value` is a number, or a string of one.
 *
 * The type test comes first and is not decoration. `Number()` is far too
 * willing: it turns `" "` and `[]` into 0 and `true` into 1, all of them
 * finite, so an earlier version counted a whitespace string and a stray
 * boolean as marks somebody had set. That inflates `valued`, and `valued`
 * decides whether an agent is shown as having a track record — a malformed
 * row upstream would have promoted an agent here.
 *
 * Values arrive in scientific notation ("1E+4") as often as in plain digits,
 * so the string case parses rather than pattern-matches.
 */
function hasValue(r: FeedbackRow): boolean {
  const v = r.value;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "string") return false;
  if (v.trim() === "") return false;
  return Number.isFinite(Number(v));
}

/**
 * Reads what the sample says, given rows.
 *
 * Exported and pure so the offline suite can drive it with fixtures. The
 * arithmetic here decides whether a number on a page reads as a track record
 * or as one address talking to itself, which is worth checking against cases
 * chosen on purpose rather than against whatever the chain holds today.
 */
export function summarise(rows: FeedbackRow[], total: number, checkedAt: string, insiders: Insiders = {}): Reputation {
  const byRater = new Map<string, number>();
  let scored = 0;
  let valued = 0;
  let commented = 0;
  let revoked = 0;
  let selfRated = 0;
  const selfRaters = new Set<string>();
  const own = new Set(
    [insiders.agent_wallet, insiders.owner_address, insiders.creator_address]
      .filter((a): a is string => typeof a === "string" && a !== "")
      .map((a) => a.toLowerCase()),
  );

  for (const r of rows) {
    if (typeof r.score === "number") scored++;
    if (hasValue(r)) valued++;
    if (typeof r.comment === "string" && r.comment.trim() !== "") commented++;
    if (r.is_revoked === true) revoked++;

    // Addresses are compared lowercased: the same wallet appears in both
    // cases across this API, and counting one writer as two would report
    // concentration as diversity — the error that flatters.
    const who = (r.user_address ?? "").toLowerCase();
    if (who !== "") byRater.set(who, (byRater.get(who) ?? 0) + 1);
    if (who !== "" && own.has(who)) {
      selfRated++;
      selfRaters.add(who);
    }
  }

  let topRater: string | null = null;
  let topCount = 0;
  for (const [addr, n] of byRater) {
    if (n > topCount) {
      topCount = n;
      topRater = addr;
    }
  }

  const tags = new Map<string, number>();
  const comments: Reputation["recentComments"] = [];
  const replies: Reputation["replies"] = [];
  for (const r of rows) {
    const who = (r.user_address ?? "").toLowerCase();
    const at = r.submitted_at ?? r.created_at ?? null;
    if (who === topRater) {
      for (const t of [r.tag1, r.tag2]) {
        if (typeof t === "string" && t.trim() !== "") tags.set(t, (tags.get(t) ?? 0) + 1);
      }
    }
    if (typeof r.comment === "string" && r.comment.trim() !== "") {
      comments.push({ by: who, at, comment: r.comment.trim(), tag: r.tag1 ?? null });
    }
    for (const raw of r.replies?.items ?? []) {
      // The same shape scan.schema.ts checks everywhere else; a reply that
      // cannot be read is dropped, not allowed to fail the record it hangs off.
      const reply = FeedbackReplySchema.safeParse(raw);
      if (!reply.success) continue;
      replies.push({
        feedbackId: r.feedback_id ?? "",
        by: reply.data.responder_address.toLowerCase(),
        at: reply.data.responded_at || null,
        uri: reply.data.response_uri,
      });
    }
  }
  // Newest first, by the registry's own stamp; rows without one sink.
  comments.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  return {
    topRaterTags: [...tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
    recentComments: comments.slice(0, 2),
    replies,
    total,
    sampled: rows.length,
    valued,
    scored,
    commented,
    revoked,
    raters: byRater.size,
    topRaterShare: rows.length === 0 ? 0 : topCount / rows.length,
    topRater,
    checkedAt,
    selfRated,
    selfRaters: [...selfRaters],
  };
}

/**
 * Pulls one agent's feedback records.
 *
 * Revoked records are included on purpose. Leaving them out would quietly
 * improve every agent whose reviewer took it back, and "two of these six were
 * withdrawn" is exactly the kind of thing someone about to grant a spend cap
 * should get to see.
 *
 * Lives outside the `/public` namespace and answers unwrapped, so it does not
 * go through the `get()` helper in scan.ts — the same exception quality and
 * score history make.
 *
 * The rows do not say who the agent is — a feedback's embedded `agent` has a
 * name and a token id, no addresses — so the registration is read for its
 * wallet, owner and creator unless the caller already holds it. Fetched
 * here rather than left to callers because a caller that forgets is a
 * self-rated count silently reported as zero, and the page already has this
 * document in Next's fetch cache.
 */
export async function getReputation(chainId: number, tokenId: string, agent?: Insiders): Promise<Reputation | null> {
  const url = new URL(`${ORIGIN}/api/v1/feedbacks`);
  url.searchParams.set("chain_id", String(chainId));
  url.searchParams.set("agent_token_id", tokenId);
  url.searchParams.set("limit", String(SAMPLE));
  url.searchParams.set("include_revoked", "true");
  // Owner responses ride along embedded, up to ten per record; the separate
  // replies endpoint exists for the eleventh onward, which nothing on BSC has.
  url.searchParams.set("include_replies", "true");

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      next: { revalidate: 900 },
      // Bounded like every other registry call: a hung connection here would
      // hold the agent page open for as long as the socket lived.
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const body = (await res.json()) as { items?: unknown; total?: unknown };
    const items = Array.isArray(body.items) ? (body.items as FeedbackRow[]) : [];
    const total = typeof body.total === "number" ? body.total : items.length;
    // A registration that cannot be read leaves the insiders empty: the
    // count is then a floor, which is the honest direction to be wrong in.
    const insiders = agent ?? (await getAgent(chainId, tokenId).catch((): Insiders => ({})));
    return summarise(items, total, new Date().toISOString(), insiders);
  } catch {
    // A missing reputation read must not blank the agent page. The rest of the
    // evidence stands on its own.
    return null;
  }
}

/**
 * How long a reputation read is reused.
 *
 * Longer than a liveness probe and shorter than a price: feedback accrues at
 * roughly a dozen records an hour across the entire chain, so a quarter of an
 * hour cannot go meaningfully stale.
 *
 * The window is set by cost as much as by freshness. Measured against a live
 * agent holding 59 records, this call takes ~1.3 s where the other three the
 * page makes take 250-550 ms, so on a cold cache it is the one setting the
 * critical path — about 750 ms of it, since all four run together. It is not
 * optional: `assess` consumes the result to decide the track-record signal, so
 * deferring it would mean rendering a verdict before the evidence for it
 * arrived. Fifteen minutes of reuse is what keeps that a first-visitor cost
 * rather than a per-visit one.
 */
const TTL_MS = 900_000;

/** `getReputation`, shared across concurrent callers and reused while fresh. */
export function getReputationCached(chainId: number, tokenId: string, agent?: Insiders) {
  return memo(`reputation:${chainId}:${tokenId}`, TTL_MS, () => getReputation(chainId, tokenId, agent));
}

/**
 * Whether a pile of feedback is worth calling a track record.
 *
 * The test is who wrote it, not whether a number is present. Marks are present
 * nearly everywhere on BSC — an earlier version of this function keyed off
 * 8004scan's `score` field and failed almost every agent on the chain for a
 * reason that had nothing to do with the agent.
 *
 * Two conditions remain. Records with no mark at all cannot support any
 * judgement, and records written almost entirely by one address describe that
 * address rather than the agent.
 *
 * The concentration line sits at two thirds rather than a half because two
 * honest reviewers rarely split evenly, and calling a 60/40 split captured
 * would flag the ordinary case.
 */
export const CAPTURED_SHARE = 2 / 3;

export function isTrackRecord(r: Reputation | null | undefined): boolean {
  if (!r || r.sampled === 0) return false;
  if (r.valued === 0) return false;
  return r.raters > 1 && r.topRaterShare < CAPTURED_SHARE;
}
