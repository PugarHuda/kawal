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

import type { ScanAgent } from "./scan.ts";

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
};

export type Assessment = {
  tier: Tier;
  signals: Signal[];
  /** How many of the listed agents share this exact name + description. */
  duplicates: number;
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

export function assess(
  agent: ScanAgent,
  dupes?: Map<string, number>,
  observed?: Observed,
  payment?: Payment,
): Assessment {
  const protocols = agent.supported_protocols ?? [];
  const interfaces = protocols.filter((p) => CALLABLE_PROTOCOLS.has(p.toUpperCase()));
  const callable = interfaces.length > 0;
  const payable = agent.x402_supported === true;
  const rated = agent.total_feedbacks > 0;
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
      detail: rated
        ? `${agent.total_feedbacks} feedback${agent.total_feedbacks === 1 ? "" : "s"}, average ${agent.average_score.toFixed(1)}`
        : "Never rated",
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

  return { tier, signals, duplicates };
}

/** Ranking within a category: evidence first, popularity a distant second. */
export function rank(agent: ScanAgent, a: Assessment) {
  // An endpoint proven silent ranks below one that merely never declared an
  // interface: the second is honest about having nothing, the first is not.
  const tierWeight =
    a.tier === "hireable" ? 1000 : a.tier === "reachable" ? 500 : a.tier === "unreachable" ? -200 : 0;
  const dupPenalty = a.duplicates > 1 ? 400 : 0;
  return (
    tierWeight -
    dupPenalty +
    agent.total_score * 3 +
    (agent.health_score ?? 0) +
    Math.min(agent.total_feedbacks, 50) * 2 +
    Math.min(agent.star_count, 50)
  );
}
