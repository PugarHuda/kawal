/**
 * Can this agent actually be hired?
 *
 * BSC carries hundreds of thousands of registered agents and adds a few
 * thousand a day, but under a tenth of them declare a protocol you could call
 * and feedback is close to non-existent chain-wide. Run `npm run
 * audit:coverage` for today's figures — they move too fast to hardcode here,
 * and a stale number in a comment is worse than no number.
 *
 * A marketplace that lists all of them is a landfill, so every listing here
 * carries its evidence.
 *
 * Deliberately a transparent breakdown rather than one opaque score -- the
 * rubric asks that a user "make a genuinely informed call", which means seeing
 * why, not just how much.
 */

import type { ScanAgent, RiskFlag, ScoreV5, V5Dimension } from "./scan.ts";
import { isTrackRecord, CAPTURED_SHARE, type Reputation } from "./reputation.ts";

export type Tier = "hireable" | "reachable" | "unreachable" | "registered";

/**
 * What Kawal has observed about an endpoint, when it has observed anything.
 *
 * Passed in rather than read here, the same way duplicate counts are: `assess`
 * stays a pure function of its arguments, so it can be reasoned about and
 * checked offline while the caller owns the database.
 */
export type Observed = {
  checks: number;
  answered: number;
  /**
   * Set when the endpoint answered, but with a published route that is not an
   * HTTP call — an ERC-8004 service descriptor, or a source repository.
   *
   * Without this, such an agent walks straight into "unreachable": Kawal
   * called three times, never got MCP back, and concluded silence. It was not
   * silent. It answered with an install command. Ranking it below a
   * registration that declared nothing at all gets the ordering backwards.
   */
  reachedAnotherWay?: boolean;
};

/**
 * How many failed calls before the registry's claim is overruled.
 *
 * Three, because one timeout is weather and two could be a deploy. By the
 * third the agent is not having a bad moment, it is not there — a sweep of the
 * 19 agents currently labelled hireable found two whose declared endpoint has
 * never answered across six and seven attempts.
 */
export const MIN_OBSERVATIONS_TO_OVERRULE = 3;

export type Signal = {
  key: string;
  label: string;
  pass: boolean;
  detail: string;
  /** How many observations the verdict rests on, when it rests on any. */
  evidence?: number;
};

export type Assessment = {
  tier: Tier;
  signals: Signal[];
  /** How many of the listed agents share this exact name + description. */
  duplicates: number;
  /**
   * High or critical risk flags 8004scan's Quality Center raised. Zero when
   * none were raised, and also zero when nobody looked — the `flagged` signal
   * is only present in the second case, and the difference is kept there.
   */
  flagged: number;
};

const TIER_LABEL: Record<Tier, string> = {
  hireable: "Hireable",
  reachable: "Reachable",
  unreachable: "Does not answer",
  registered: "Registered only",
};

export function tierLabel(t: Tier) {
  return TIER_LABEL[t];
}

/**
 * The exact-match key: name and description, trimmed and lowercased.
 *
 * Exported because the catalog collapses on the same key. It was spelled out
 * a second time there, which is one edit away from the two drifting apart.
 */
export function fingerprint(a: ScanAgent) {
  return `${a.name.trim().toLowerCase()}::${(a.description ?? "").trim().toLowerCase()}`;
}

/**
 * Strips the parts that a minting script varies per token: edition numbers,
 * hashes, stat rolls. "BORT Yield Weaver #10877" and "BORT Yield Weaver
 * #10997" both come back as "bort yield weaver".
 */
function normalise(s: string) {
  return s
    .toLowerCase()
    .replace(/[#\d]+/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The two shapes of padding that an exact name+description match misses.
 *
 * Both were found in the live Yield listing, below the genuinely hireable
 * agents:
 *
 *   series — "BORT Yield Weaver #10877" … #10997, one mint per edition, each
 *            with its own power roll in the description. Names differ, so an
 *            exact match keeps all fifteen.
 *   stencil — twenty registrations under different names ("HubKey223",
 *            "CyberHub38", …) sharing the description "AI agent for vault".
 *            Descriptions match but names do not, so again all twenty stay.
 *
 * Neither tells a buyer anything the first one didn't.
 */
export function seriesKey(a: ScanAgent) {
  return `series:${normalise(a.name)}`;
}

export function stencilKey(a: ScanAgent) {
  const desc = normalise(a.description ?? "");
  // Too short to be distinctive: collapsing on "defi agent" would merge
  // unrelated registrations that merely wrote a thin description.
  return desc.length >= 12 ? `stencil:${desc}` : null;
}

/**
 * Counts identical name+description pairs across a result set. The newest
 * registrations on BSC arrive in bulk-minted clusters that are byte-identical
 * apart from the token id, so this has to be computed over the batch, not the
 * single agent.
 */
export function duplicateIndex(agents: ScanAgent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of agents) {
    const key = fingerprint(a);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Protocols that actually give you something to call.
 *
 * 8004scan also reports "Web" and "Email", which are a homepage and an inbox
 * — useful to a human, useless to an agent. Counting them as an interface
 * would let a registration with nothing but a landing page show up as
 * reachable, which is the exact padding this listing exists to strip out.
 */
const CALLABLE_PROTOCOLS = new Set(["MCP", "A2A", "OASF"]);

/**
 * The result of actually asking an endpoint to charge, when Kawal has asked.
 *
 * Passed in for the same reason `Observed` is: `assess` stays a pure function,
 * and the network lives in the caller.
 */
export type Payment = { demanded: boolean };

/**
 * The part of a Quality Center report that `assess` reads.
 *
 * Passed in like everything else that came over the network. The flags are
 * 8004scan's finding, not Kawal's, and the signal says so.
 */
export type Quality = { risk_flags: RiskFlag[] };

const SERIOUS = new Set(["high", "critical"]);

/** Which flags are worth failing a signal over. Low and medium are noted, not counted. */
export function seriousFlags(quality: Quality | null | undefined): RiskFlag[] {
  return (quality?.risk_flags ?? []).filter((f) => SERIOUS.has(f.severity));
}

/**
 * What to say about a feedback count, given whether the records were read.
 *
 * Three states, and conflating any two of them is a lie of a different size:
 * Kawal has not looked; Kawal looked and found something worth calling a
 * record; Kawal looked and found the count does not survive contact. The last
 * one names the reason rather than just failing, because "40 records, 96% from
 * one address" is actionable and "no track record" is not.
 */
function trackRecordDetail(agent: ScanAgent, r?: Reputation | null): string {
  const count = agent.total_feedbacks;
  const plural = count === 1 ? "" : "s";

  if (r === undefined || r === null) {
    return count > 0
      ? `${count} feedback${plural} on the registry — records not read here`
      : "Never rated";
  }
  if (r.total === 0) return "Never rated";

  if (r.valued === 0) {
    return `${r.total} record${r.total === 1 ? "" : "s"}, none carrying a mark — nothing to judge on`;
  }

  const who =
    r.raters === 1
      ? "all from one address"
      : r.topRaterShare >= CAPTURED_SHARE
        ? `${Math.round(r.topRaterShare * 100)}% from one address`
        : `from ${r.raters} addresses`;

  const withdrawn = r.revoked > 0 ? `, ${r.revoked} withdrawn` : "";
  // The registry refuses self-feedback from the owner, so any hit here came
  // through a separately set agent wallet — worth naming when it happens.
  const self =
    (r.selfRated ?? 0) > 0
      ? `, ${r.selfRated} written by the agent's own address${r.selfRated === 1 ? "" : "es"}`
      : "";
  return `${r.valued} of ${r.sampled} marked, ${who}${self}${withdrawn}`;
}

export function assess(
  agent: ScanAgent,
  dupes?: Map<string, number>,
  observed?: Observed,
  payment?: Payment,
  reputation?: Reputation | null,
  quality?: Quality | null,
): Assessment {
  const protocols = agent.supported_protocols ?? [];
  const interfaces = protocols.filter((p) => CALLABLE_PROTOCOLS.has(p.toUpperCase()));
  const callable = interfaces.length > 0;
  const payable = agent.x402_supported === true;
  // The registry counts feedback records; it does not ask who wrote them. A
  // sample of 1,200 BSC records found 53 addresses behind all of them, one of
  // which wrote 265 of the oldest 600. A count is not evidence of a track
  // record. Where Kawal has read the records, the reading wins.
  const rated =
    reputation === undefined || reputation === null
      ? agent.total_feedbacks > 0
      : isTrackRecord(reputation);
  const healthy = agent.health_score !== null && agent.health_score >= 60;
  const duplicates = dupes?.get(fingerprint(agent)) ?? 1;

  // The registry says an interface is declared. It never calls anything, so
  // that is a claim, not a fact. Where Kawal has called repeatedly and never
  // got an answer, the observation wins.
  const proven =
    observed && observed.checks >= MIN_OBSERVATIONS_TO_OVERRULE
      ? observed.answered > 0
      : null;

  // Silence is the absence of any answer, not the absence of the answer we
  // wanted. An agent that published a way in has not gone quiet.
  const silent = proven === false && observed?.reachedAnotherWay !== true;

  const signals: Signal[] = [
    {
      key: "callable",
      label: "Declares an interface",
      pass: callable,
      detail: callable
        ? interfaces.join(", ").toUpperCase()
        : protocols.length > 0
          ? `Only ${protocols.join(", ")} — a page to read, not an interface to call`
          : "No MCP, A2A or OASF protocol declared — nothing to call",
    },
    {
      key: "observed",
      label: "Answers when called",
      pass: proven === true,
      detail:
        !observed || observed.checks === 0
          ? "Kawal has not called this endpoint yet"
          : observed.reachedAnotherWay
            ? `Not an HTTP server — it publishes a route Kawal cannot call for you`
            : `${observed.answered} of ${observed.checks} call${observed.checks === 1 ? "" : "s"} answered`,
      // The verdict rests on this many calls. Printed so a reader can tell
      // "answered 1 of 1" from "answered 83 of 85" without doing arithmetic.
      evidence: observed?.checks,
    },
    {
      /*
       * The flag is set by the registration, about itself, and 37.5% of a
       * 200-agent sample sets it while none of the reachable ones asks for
       * money. Showing a green tick for that was Kawal repeating an
       * unverified claim as evidence — the exact thing it strips out
       * elsewhere.
       *
       * The tier still treats the declaration as sufficient. Refusing to
       * charge is not refusing to be hired: an agent whose tools run on-chain
       * or for free is perfectly hireable, and demoting every one of them
       * over an unanswered 402 would be a worse error than the one being
       * fixed.
       */
      key: "payable",
      label: "Accepts x402 payment",
      pass: payment ? payment.demanded : payable,
      detail: !payable
        ? "No x402 payment path"
        : payment?.demanded
          ? "Quoted a price when Kawal asked"
          : payment
            ? "Declared, but asked for nothing when called"
            : "Declared by the registration — not verified here",
    },
    {
      key: "rated",
      label: "Has a track record",
      pass: rated,
      detail: trackRecordDetail(agent, reputation),
    },
    {
      key: "healthy",
      label: "Health score",
      pass: healthy,
      detail:
        agent.health_score === null
          ? "Not scored by 8004scan"
          : `${agent.health_score.toFixed(0)} / 100`,
    },
    {
      key: "distinct",
      label: "Distinct registration",
      pass: duplicates === 1,
      detail:
        duplicates === 1
          ? "No identical twin in this result set"
          : `${duplicates} identical registrations — bulk-minted`,
    },
  ];

  // Only when the Quality Center was actually read. A row saying "no flags"
  // for an agent nobody checked would be the same unearned tick the payable
  // row used to be.
  const flags = seriousFlags(quality);
  if (quality) {
    const all = quality.risk_flags.length;
    signals.push({
      key: "flagged",
      label: "Risk flags",
      pass: flags.length === 0,
      detail:
        flags.length > 0
          ? `8004scan raised ${flags.map((f) => `${f.severity}: ${f.title || f.id}`).join("; ")}`
          : all > 0
            ? `${all} low or medium flag${all === 1 ? "" : "s"} from 8004scan — none serious`
            : "No risk flags raised by 8004scan",
    });
  }

  // Hiring needs both an interface to call and a way to pay for the call.
  // Everything else is quality, not possibility.
  //
  // Except silence. An endpoint we have called three times and never reached
  // is not reachable, whatever the registration says, and listing it as
  // hireable would be the exact unearned confidence this module exists to
  // strip out.
  const tier: Tier =
    silent
      ? "unreachable"
      : callable && payable
        ? "hireable"
        : callable
          ? "reachable"
          : "registered";

  return { tier, signals, duplicates, flagged: flags.length };
}

/**
 * What Kawal has measured, offered to `rank` on top of the registry's numbers.
 *
 * All optional, because a list response carries none of it and the score has
 * to be computable from the registry alone. Where any of it is present it
 * outweighs the registry's own popularity figures, which is the point: the
 * registry's numbers are claims and these are calls.
 */
export type Measured = {
  observed?: Observed;
  /** Median answering latency, when there is one. */
  uptime?: { medianMs: number | null } | null;
  reputation?: Reputation | null;
};

/**
 * Ranking within a category: evidence first, popularity a distant second.
 *
 * The score is a sum, so each term can be read off on its own:
 *
 *   tier          hireable +1000, reachable +500, registered 0, unreachable -200
 *                 An endpoint proven silent ranks below one that never
 *                 declared an interface: the second is honest about having
 *                 nothing, the first is not.
 *   duplicates    -400 when the registration has an identical twin
 *   risk flags    -300 per high or critical flag 8004scan raised
 *   answered      +300 × (answered ÷ checks), once Kawal has called at least
 *                 MIN_OBSERVATIONS_TO_OVERRULE times. Skipped for an agent
 *                 that publishes a non-HTTP route: it was not silent, it was
 *                 not a server, and neither reading is an uptime figure.
 *   latency       +0 … +50, linear from a 5 s median down to instant. Small
 *                 on purpose: speed is a tiebreak, not a reason.
 *   total_score   × 3, 8004scan's own composite
 *   health_score  as is, 8004scan's cached health check
 *   feedbacks     × 2, capped at 50 records — halved when Kawal read the
 *                 records and two thirds or more came from one address, since
 *                 a count that one writer produced is not a count of opinions
 *   stars         capped at 50
 *
 * Kawal's own answered-rate term is worth as much as 150 registry feedbacks
 * because that is the ratio of how much each is trusted here.
 */
export function rank(agent: ScanAgent, a: Assessment, measured: Measured = {}) {
  const tierWeight =
    a.tier === "hireable" ? 1000 : a.tier === "reachable" ? 500 : a.tier === "unreachable" ? -200 : 0;
  const dupPenalty = a.duplicates > 1 ? 400 : 0;
  const flagPenalty = a.flagged * 300;

  const o = measured.observed;
  const answeredTerm =
    o && o.checks >= MIN_OBSERVATIONS_TO_OVERRULE && !o.reachedAnotherWay
      ? (o.answered / o.checks) * 300
      : 0;

  const median = measured.uptime?.medianMs;
  const latencyTerm =
    typeof median === "number" && median >= 0 ? Math.max(0, 50 - median / 100) : 0;

  const r = measured.reputation;
  const captured = r != null && r.sampled > 0 && r.topRaterShare >= CAPTURED_SHARE;
  const feedbackTerm = Math.min(agent.total_feedbacks, 50) * (captured ? 1 : 2);

  return (
    tierWeight -
    dupPenalty -
    flagPenalty +
    answeredTerm +
    latencyTerm +
    agent.total_score * 3 +
    (agent.health_score ?? 0) +
    feedbackTerm +
    Math.min(agent.star_count, 50)
  );
}

/*
 * 8004scan's own score, read as parts rather than as one number. Kept here
 * beside Kawal's signals because the comparison, the agent sheet and the
 * MCP tool all print the same five rows, and the offline check loads this
 * module where it cannot load the page layer.
 */

/** The five v5 components in the order and weight 8004scan publishes them. */
export const V5_COMPONENTS = [
  ["engagement", "Engagement"],
  ["service", "Service"],
  ["publisher", "Publisher"],
  ["compliance", "Compliance"],
  ["momentum", "Momentum"],
] as const;

export type V5Row = {
  key: (typeof V5_COMPONENTS)[number][0];
  label: string;
  dimension: V5Dimension;
  /**
   * The registry's weight as a share of the whole score, out of 100.
   *
   * 8004scan publishes it as a fraction — engagement 0.3, momentum 0.1, the
   * five summing to 1 — and `weighted_score` is `score × weight`, so the
   * total lands on a 0-100 scale. Printing the fraction beside a part scored
   * out of 100 read as a rounding error rather than a share: "6 / 100 × 0.3"
   * hides that engagement is the heaviest part of the five. As a percentage
   * the arithmetic is legible on the page — 6/100 of 30 is 1.9 — and the
   * five weights visibly sum to 100, which is what the caption promises.
   */
  weightPct: number;
};

/**
 * The scored components, dropping the ones the registry left null.
 *
 * Empty for an agent the endpoint answered with its legacy shape, which is
 * the common case on BSC; a caller with an empty list has nothing to draw.
 */
export function v5Rows(v5: ScoreV5 | null | undefined): V5Row[] {
  if (!v5) return [];
  return V5_COMPONENTS.flatMap(([key, label]) => {
    const dimension = v5[key];
    return dimension ? [{ key, label, dimension, weightPct: Math.round(dimension.weight * 100) }] : [];
  });
}

/**
 * The component holding the score down. On the 0-100 scale, not the
 * weighted one: a weak momentum at weight 10 is still the thing a reader
 * would ask about, and the weight is printed beside it.
 */
export function weakestV5(v5: ScoreV5 | null | undefined): V5Row | null {
  return v5Rows(v5).reduce<V5Row | null>((low, row) => (low === null || row.dimension.score < low.dimension.score ? row : low), null);
}
