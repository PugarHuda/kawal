/**
 * Kawal as something an agent can call, rather than only something a person
 * can read.
 *
 * Everything this project verifies — whether a declared endpoint answers,
 * whether an agent that claims x402 ever asks to be paid, who actually wrote
 * an agent's feedback — has until now been reachable only by loading a page.
 * That is the wrong shape for the thing it is about. The ecosystem it serves
 * is agents calling agents; 8004scan itself publishes MCP tools, so a registry
 * answering over MCP is the convention here, not an invention.
 *
 * The tool surface is deliberately the questions Kawal can answer *from
 * evidence it collected*, not a mirror of the registry. Anyone can read
 * 8004scan. Only Kawal can say "I called this endpoint 74 times since the 24th
 * and it answered 72".
 *
 * One rule shapes every signature below: no tool takes a URL.
 *
 * A public endpoint that accepts a URL and fetches it is an open proxy, and
 * this one would be an open proxy with a server-side fetch behind it. Callers
 * name an agent by chain and token id, or an owner by wallet address; the
 * endpoint that gets dialled is the one the *registry* published for that
 * agent, and it still goes through the SSRF guard on the way out. The blast
 * radius of a hostile caller is therefore "made Kawal probe a registered
 * agent", which is what the site does anyway.
 *
 * Two protocol eras are served on one endpoint. Clients from 2025 open with
 * `initialize` and expect a negotiated version back; clients from 2026-07-28
 * send no handshake at all and declare their version on every request. The
 * server does not care which: nothing here ever depended on a session, so
 * every request is answered on its own, and the extra fields the newer
 * revision requires (`resultType`, cache hints, server identity in `_meta`)
 * are harmless to the older clients and so are always present.
 */

import { getAgent, getQuality, listAgents } from "./scan.ts";
import { proveAgent } from "./probe.ts";
import { assess, tierLabel } from "./signals.ts";
import { CATEGORIES, classify } from "./taxonomy.ts";
import { observedFor, uptimeFor } from "./uptime.ts";
import { checkX402Cached } from "./x402.ts";
import { getReputationCached } from "./reputation.ts";
import { browse } from "./catalog.ts";
import { diagnose, failureLabel } from "./failure.ts";
import { mapLimit } from "./concurrency.ts";
import { KNOWN_DEFECTS } from "./feedback.ts";
import { MAX_DURATION_DAYS, planMandate, SEAT_POLICIES, VENUES } from "./mandate.ts";
import { BSC_MAINNET, SUPPORTED_CHAINS } from "./chains.ts";
import type { Column } from "./compare.ts";

export const SERVER_NAME = "kawal";
export const SERVER_VERSION = "0.1.0";

/**
 * The revisions this server speaks.
 *
 * First is the stateless one; the other two are the handshake-based ones the
 * clients on BSC (and Kawal's own prober) still open with. A client asking for
 * one of these gets it back verbatim; one asking for anything else is offered
 * `PROTOCOL_VERSION`, the newest revision that still has an `initialize` to
 * answer, because a client that sent `initialize` cannot be handed a revision
 * in which that method does not exist.
 */
export const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"] as const;
export const MODERN_VERSION = SUPPORTED_VERSIONS[0];
export const PROTOCOL_VERSION = SUPPORTED_VERSIONS[1];

/**
 * Ceiling on how many agents one search call can ask Kawal to assess.
 *
 * Each result costs upstream work, and a caller asking for two hundred would
 * be spending someone else's rate limit. Twenty is more than a decision needs.
 */
const MAX_SEARCH = 20;

/** The comparison form holds three columns; the tool holds the same. */
const MAX_COMPARE = 3;

/**
 * Bounds on the owner lookup, which dials other people's servers.
 *
 * Twelve agents at four in flight with a six-second timeout is at worst
 * eighteen seconds of wall clock, inside any client's patience and gentle on
 * the endpoints being called. The page allows twenty-four; an agent asking
 * over MCP gets less because it cannot watch a spinner.
 */
const MAX_OWNER_AGENTS = 12;
const OWNER_CONCURRENCY = 4;
const OWNER_PROBE_TIMEOUT_MS = 6_000;

/**
 * USDT on BSC, the settlement token every seat's cap is denominated in, and
 * its decimals. The same two facts the mandate form is built on.
 */
const USDT = "0x55d398326f99059fF775485246999027B3197955" as const;
const USDT_DECIMALS = 18n;
/** Above this a double stops representing whole cents exactly; see the form. */
const MAX_CAPITAL_USDT = 1e12;

type Json = Record<string, unknown>;

/** Rejects anything that is not one of the chains Kawal actually knows. */
function chainOf(args: Json): number {
  const raw = args.chainId ?? args.chain_id ?? BSC_MAINNET;
  const n = Number(raw);
  if (!SUPPORTED_CHAINS.includes(n as (typeof SUPPORTED_CHAINS)[number])) {
    throw new Error(`chainId must be one of ${SUPPORTED_CHAINS.join(", ")}`);
  }
  return n;
}

/**
 * A token id, as digits.
 *
 * Validated rather than passed through: it is interpolated into an upstream
 * path, and "any string the caller sent" is not something to put there.
 */
function tokenOf(args: Json): string {
  const raw = String(args.tokenId ?? args.token_id ?? "");
  if (!/^\d+$/.test(raw)) throw new Error("tokenId must be a decimal token id");
  return raw;
}

/** A wallet address, lower-cased. Goes into an upstream query, so checked. */
function ownerOf(args: Json): string {
  const raw = String(args.owner ?? args.address ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("owner must be a wallet address: 0x followed by forty hex characters");
  return raw.toLowerCase();
}

/**
 * Behaviour hints, per the MCP tool specification. Every tool here reads and
 * reports; the one that can move state is the paid report, whose settlement
 * marks a receipt spent, and it says so.
 */
type Annotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** True when the tool leaves this server: dials an agent or reads the registry. */
  openWorldHint: boolean;
};

const READS_OUTSIDE: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const PURE: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: Annotations;
  run: (args: Json) => Promise<Json>;
};

const CHAIN_PROPERTY = {
  type: "number",
  description: `Chain id. One of ${SUPPORTED_CHAINS.join(", ")}. Defaults to ${BSC_MAINNET}.`,
};
const TOKEN_PROPERTY = { type: "string", description: "ERC-8004 token id, decimal digits." };

const AGENT_INPUT: Json = {
  type: "object",
  properties: { chainId: CHAIN_PROPERTY, tokenId: TOKEN_PROPERTY },
  required: ["tokenId"],
};

export const TOOLS: Tool[] = [
  {
    name: "verify_agent",
    title: "Verify an agent by calling it",
    description:
      "Call an agent's declared endpoint right now and report what answered. " +
      "This is a live handshake made by Kawal, not a reading of the registry: " +
      "an agent whose registration declares MCP but whose endpoint is gone is " +
      "reported as not answering. Returns the hireability tier and the evidence " +
      "behind it, including how many times Kawal has reached this endpoint before.",
    inputSchema: AGENT_INPUT,
    annotations: READS_OUTSIDE,
    async run(args) {
      const chainId = chainOf(args);
      const tokenId = tokenOf(args);
      const agent = await getAgent(chainId, tokenId);

      const proof = await proveAgent(agent);
      const [observed, reputation, quality] = await Promise.all([
        observedFor(proof?.endpoint),
        getReputationCached(chainId, tokenId),
        getQuality(chainId, tokenId).catch(() => null),
      ]);
      const payment =
        agent.x402_supported === true && proof?.endpoint
          ? await checkX402Cached(proof.endpoint)
          : null;

      const assessment = assess(
        agent,
        undefined,
        observed && { ...observed, reachedAnotherWay: proof?.descriptor != null },
        payment ? { demanded: payment.demanded } : undefined,
        reputation,
        quality,
      );

      return {
        agent: { chainId, tokenId, name: agent.name, owner: agent.owner_address },
        tier: assessment.tier,
        tierLabel: tierLabel(assessment.tier),
        seat: classify(agent.name, agent.description).category,
        declared: agent.supported_protocols ?? [],
        probe: proof && {
          endpoint: proof.endpoint,
          protocol: proof.protocol,
          answered: proof.answered,
          a2a: proof.a2a,
          latencyMs: Math.round(proof.latencyMs),
          toolCount: proof.toolCount,
          error: proof.error,
          checkedAt: proof.checkedAt,
        },
        // The part no one else holds. A single reading is weather.
        history: proof?.endpoint ? await uptimeFor(proof.endpoint) : null,
        signals: assessment.signals.map((s) => ({ key: s.key, pass: s.pass, detail: s.detail })),
      };
    },
  },

  {
    name: "check_payment",
    title: "Ask whether an agent really charges",
    description:
      "Send the opening request of the x402 protocol — no payment header — and " +
      "report whether the server actually demands payment. `x402_supported` on " +
      "the registry is a flag a registration sets about itself; this is the " +
      "answer to asking. Kawal never settles a payment, so the price is quoted " +
      "in the server's own words and nothing moves.",
    inputSchema: AGENT_INPUT,
    annotations: READS_OUTSIDE,
    async run(args) {
      const chainId = chainOf(args);
      const tokenId = tokenOf(args);
      const agent = await getAgent(chainId, tokenId);
      const proof = await proveAgent(agent);

      if (!proof?.endpoint) {
        return { claimsX402: agent.x402_supported === true, asked: false, reason: "no endpoint to ask" };
      }
      const check = await checkX402Cached(proof.endpoint);
      return {
        claimsX402: agent.x402_supported === true,
        asked: true,
        demandedPayment: check.demanded,
        endpoint: check.endpoint,
        status: check.status,
        quote: check.quote,
        accepts: check.accepts,
        error: check.error,
        checkedAt: check.checkedAt,
      };
    },
  },

  {
    name: "read_reputation",
    title: "Who wrote an agent's feedback",
    description:
      "Report who wrote an agent's ERC-8004 feedback, not how much of it there " +
      "is. A sample of 1,200 BSC records came from 53 addresses, one of which " +
      "wrote 265 of the oldest 600, so a count of records is a count of writes " +
      "rather than of opinions. Returns how many carry a mark, how many " +
      "distinct addresses wrote them, and what share came from the busiest one.",
    inputSchema: AGENT_INPUT,
    annotations: READS_OUTSIDE,
    async run(args) {
      const chainId = chainOf(args);
      const tokenId = tokenOf(args);
      const r = await getReputationCached(chainId, tokenId);
      if (!r) return { read: false, reason: "the registry did not answer" };
      return {
        read: true,
        records: r.total,
        sampled: r.sampled,
        carryingAMark: r.valued,
        inRegistryScoreField: r.scored,
        withComment: r.commented,
        withdrawn: r.revoked,
        distinctWriters: r.raters,
        busiestWriter: r.topRater,
        busiestWriterShare: r.topRaterShare,
        checkedAt: r.checkedAt,
      };
    },
  },

  {
    name: "find_agents",
    title: "Search the roster by problem",
    description:
      "Search the BSC roster by describing the problem rather than naming a " +
      "product, and get back agents ranked with Kawal's evidence attached. " +
      "Duplicate registrations are collapsed: roughly two thirds of the newest " +
      "registrations are copies of a template, and returning all of them would " +
      "be returning the same agent many times.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you need done, in plain words." },
        limit: { type: "number", description: `How many to return, at most ${MAX_SEARCH}.` },
        chainId: CHAIN_PROPERTY,
      },
      required: ["query"],
    },
    annotations: READS_OUTSIDE,
    async run(args) {
      const query = String(args.query ?? "").trim();
      if (query === "") throw new Error("query must not be empty");
      const limit = Math.min(MAX_SEARCH, Math.max(1, Number(args.limit ?? 5) || 5));

      const { listings, total } = await browse({ chainId: chainOf(args), search: query, limit });
      return {
        query,
        matchedChainWide: total,
        // The tier here is the catalogue's, which has not dialled anything for
        // this call. `verify_agent` is what turns a listing into a probe.
        results: listings.slice(0, limit).map((l) => ({
          chainId: l.agent.chain_id,
          tokenId: l.agent.token_id,
          name: l.agent.name,
          tier: l.assessment.tier,
          declared: l.agent.supported_protocols ?? [],
          feedbackRecords: l.agent.total_feedbacks,
          duplicateRegistrations: l.assessment.duplicates,
        })),
        note: "Tiers here come from the registry plus anything Kawal has already observed. Call verify_agent to dial one now.",
      };
    },
  },

  {
    name: "agents_by_owner",
    title: "Every agent an address minted, called now",
    description:
      "List the agents one wallet registered on BSC and call each of their " +
      "declared endpoints now. Nothing on the chain tells an owner their " +
      "endpoint went dark — the registry keeps listing it — so this is the " +
      "answer to \"is my agent still answering?\": what answered, how each " +
      `failure looks, and every probe Kawal kept. At most ${MAX_OWNER_AGENTS} ` +
      "agents are dialled, so a large owner sees the first page.",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "The wallet that minted the registrations: 0x followed by forty hex characters. `address` is accepted as an alias.",
        },
        chainId: CHAIN_PROPERTY,
      },
      required: ["owner"],
    },
    annotations: READS_OUTSIDE,
    async run(args) {
      const chainId = chainOf(args);
      const owner = ownerOf(args);
      const { agents, total } = await listAgents({ chainId, ownerAddress: owner, limit: MAX_OWNER_AGENTS });

      // The probe is what makes this worth asking. Reading the registry back
      // to an owner would just be showing them what they already filled in.
      const rows = await mapLimit(agents, OWNER_CONCURRENCY, async (a) => {
        try {
          const detail = await getAgent(a.chain_id, a.token_id);
          const proof = await proveAgent(detail, { timeoutMs: OWNER_PROBE_TIMEOUT_MS });
          const failure = proof?.error ? diagnose(proof.error) : null;
          const runsLocally = proof?.descriptor != null;
          return {
            chainId: a.chain_id,
            tokenId: a.token_id,
            name: a.name,
            endpoint: proof?.endpoint ?? null,
            protocol: proof?.protocol ?? null,
            answered: proof?.answered ?? false,
            runsLocally,
            verdict: proof?.answered
              ? "answering"
              : runsLocally
                ? "runs locally"
                : failure
                  ? failureLabel(failure.failure)
                  : "no endpoint",
            failure: failure && !runsLocally ? { kind: failure.failure, label: failureLabel(failure.failure), summary: failure.summary, mayRecover: failure.transient } : null,
            history: proof?.endpoint ? await uptimeFor(proof.endpoint) : null,
          };
        } catch (e) {
          return { chainId: a.chain_id, tokenId: a.token_id, name: a.name, endpoint: null, protocol: null, answered: false, runsLocally: false, verdict: "could not be read", failure: null, history: null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
        }
      });

      return {
        owner,
        chainId,
        registrations: total,
        shown: rows.length,
        notAnswering: rows.filter((r) => r.endpoint && !r.answered && !r.runsLocally).length,
        agents: rows,
        caveat: KNOWN_DEFECTS[0],
      };
    },
  },

  {
    name: "compare_agents",
    title: "The same questions of two or three agents",
    description:
      "Put two or three agents side by side and answer the same questions of " +
      "each — the ones a buyer weighs before handing over a spend cap: can it " +
      "be hired, does it answer right now, has it kept answering, what does it " +
      "offer, what does it say it costs, does its domain verify, what is its " +
      "track record, what is flagged against it, and when it was registered. " +
      "Each agent is dialled for this call. No combined score: the " +
      "disagreements are the point.",
    inputSchema: {
      type: "object",
      properties: {
        agents: {
          type: "array",
          description: `One to ${MAX_COMPARE} agents to compare.`,
          minItems: 1,
          maxItems: MAX_COMPARE,
          items: {
            type: "object",
            properties: { chainId: CHAIN_PROPERTY, tokenId: TOKEN_PROPERTY },
            required: ["tokenId"],
          },
        },
      },
      required: ["agents"],
    },
    annotations: READS_OUTSIDE,
    async run(args) {
      const asked = Array.isArray(args.agents) ? (args.agents as unknown[]) : null;
      if (!asked || asked.length === 0) throw new Error("agents must be a non-empty array of { chainId, tokenId }");
      if (asked.length > MAX_COMPARE) throw new Error(`agents must hold at most ${MAX_COMPARE} entries`);
      const refs = asked.map((a) => {
        const entry = (typeof a === "object" && a !== null ? a : {}) as Json;
        return { chainId: chainOf(entry), tokenId: tokenOf(entry) };
      });

      // Loaded lazily: the comparison module reaches into the page layer for
      // seat labels, which the offline self-check cannot resolve, and the
      // check only needs this tool's schema and its argument validation.
      const { loadColumn } = await import("./compare.ts");
      const columns = await Promise.all(refs.map((r) => loadColumn(r.chainId, r.tokenId)));

      return {
        agents: columns.flatMap((c) => (c ? [compareRow(c)] : [])),
        notLoaded: refs.filter((_, i) => columns[i] === null).map((r) => `${r.chainId}:${r.tokenId}`),
        note: "Prices are what each agent states in its own tool descriptions; nothing has been paid or independently confirmed.",
      };
    },
  },

  {
    name: "uptime_history",
    title: "Every probe Kawal has made of an agent",
    description:
      "Read the history Kawal keeps of one agent's endpoint without dialling " +
      "it: how many times it was called, how many times it answered in the " +
      "protocol it declared, since when, and the median and worst latency of " +
      "the answering calls. This is the record the registry does not have. " +
      "Null when Kawal has never called this endpoint; verify_agent makes the " +
      "first call.",
    inputSchema: AGENT_INPUT,
    annotations: READS_OUTSIDE,
    async run(args) {
      const chainId = chainOf(args);
      const tokenId = tokenOf(args);
      const agent = await getAgent(chainId, tokenId);
      // The endpoint the prober would dial, resolved the same way it does —
      // MCP first — but not dialled: this tool reads the ledger, it does not
      // add to it.
      const endpoint = agent.services?.mcp?.endpoint ?? agent.services?.a2a?.endpoint ?? null;
      if (!endpoint) return { agent: { chainId, tokenId, name: agent.name }, endpoint: null, history: null, reason: "no MCP or A2A endpoint declared" };
      const history = await uptimeFor(endpoint);
      return {
        agent: { chainId, tokenId, name: agent.name },
        endpoint,
        protocol: agent.services?.mcp?.endpoint ? "mcp" : "a2a",
        history,
        ...(history ? {} : { reason: "Kawal has never called this endpoint" }),
        knownDefects: KNOWN_DEFECTS,
      };
    },
  },

  {
    name: "plan_mandate",
    title: "Plan four bounded seats for a capital amount",
    description:
      "Turn a capital amount and a duration into the four scoped sessions " +
      "Kawal would grant on Altana — one per seat, each with its own contract " +
      "allowlist, spend cap and expiry — without granting anything. Pure " +
      "arithmetic over the venue table: the same plan the mandate form shows, " +
      "and the same refusals, since a plan that would widen authority (an " +
      "unproven venue, an empty allowlist, caps that overcommit) is refused " +
      "rather than built.",
    inputSchema: {
      type: "object",
      properties: {
        capitalUsdt: { type: "number", description: `Capital to entrust, in USDT. Positive, at most ${MAX_CAPITAL_USDT}.`, exclusiveMinimum: 0, maximum: MAX_CAPITAL_USDT },
        days: { type: "integer", description: `How long the mandate runs, in whole days. 1 to ${MAX_DURATION_DAYS}.`, minimum: 1, maximum: MAX_DURATION_DAYS },
        chainId: CHAIN_PROPERTY,
      },
      required: ["capitalUsdt", "days"],
    },
    annotations: PURE,
    async run(args) {
      const chainId = chainOf(args);
      const capitalUsdt = Number(args.capitalUsdt);
      if (!Number.isFinite(capitalUsdt) || capitalUsdt <= 0) throw new Error("capitalUsdt must be a positive number");
      if (capitalUsdt > MAX_CAPITAL_USDT) throw new Error(`capitalUsdt must be at most ${MAX_CAPITAL_USDT}`);
      const days = Number(args.days);
      if (!Number.isInteger(days)) throw new Error("days must be a whole number");

      // Cents are the smallest unit anyone types; below that the form rounds too.
      const capital = (BigInt(Math.round(capitalUsdt * 100)) * 10n ** USDT_DECIMALS) / 100n;
      const now = Math.floor(Date.now() / 1000);
      // UnsafeMandateError carries the reason in its message and surfaces as a
      // tool error, which is a refusal the caller can read.
      const plans = planMandate({ chainId, capital: capital, token: USDT, durationDays: days, now });

      return {
        chainId,
        token: USDT,
        capitalUsdt,
        days,
        expiresAt: new Date((now + days * 86_400) * 1000).toISOString(),
        seats: plans.map((p) => ({
          seat: p.seat,
          category: p.category,
          priority: p.priority,
          contracts: (p.permissions.calls ?? []).flatMap((c) => ("to" in c ? [c.to] : [])),
          spendCap: (p.permissions.spend ?? []).map((s) => ({
            limit: s.limit.toString(),
            limitUsdt: Number(s.limit / 10n ** (USDT_DECIMALS - 2n)) / 100,
            period: s.period,
          })),
          expiry: p.expiry,
          explain: p.explain,
        })),
        committedUsdt: Number(plans.reduce((s, p) => s + (p.permissions.spend?.[0]?.limit ?? 0n), 0n) / 10n ** (USDT_DECIMALS - 2n)) / 100,
        note: "A plan, not a grant. Nothing was signed or registered.",
      };
    },
  },

  {
    name: "deep_report",
    title: "Everything Kawal holds about one agent (paid)",
    description:
      "Everything Kawal holds about one agent in a single answer: the live " +
      "handshake, the full probe history, how the endpoint fails when it " +
      "fails, whether it really charges, and who wrote its feedback. This one " +
      "costs money. Kawal measured that 75 of 200 BSC registrations declare " +
      "x402 support and that none of the reachable ones ever asks to be paid; " +
      "this is the counter-example. Calling it without payment returns the " +
      "terms rather than the report. Pay the terms with a plain BNB transfer " +
      "and call again with `txHash`; the receipt is read on-chain and spent " +
      "once.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: CHAIN_PROPERTY,
        tokenId: TOKEN_PROPERTY,
        txHash: {
          type: "string",
          description: "Hash of the BNB transfer that paid the terms: 0x followed by 64 hex characters. Omit to receive the terms.",
          pattern: "^0x[0-9a-fA-F]{64}$",
        },
      },
      required: ["tokenId"],
    },
    // Settlement marks a receipt spent, so a second call with the same hash
    // is refused: neither read-only nor idempotent, and it says so.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args) {
      const chainId = chainOf(args);
      const tokenId = tokenOf(args);
      const raw = args.txHash ?? args.tx_hash;
      const txHash = raw === undefined || raw === null || raw === "" ? null : String(raw);
      if (txHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new Error("txHash must be a transaction hash: 0x followed by 64 hex characters");
      }

      // The terms are the same document the HTTP route emits, so a caller
      // holding either can pay the other.
      const { payTo, challenge, PRICE_WEI } = await import("./x402.terms.ts");
      const to = payTo();
      if (!to) {
        return { paid: false, forSale: false, reason: "this instance holds no wallet, so it charges for nothing" };
      }
      const terms = {
        paid: false,
        forSale: true,
        priceWei: PRICE_WEI.toString(),
        // The quote lists every rail the deployment can actually settle: the
        // native transfer always, the signed Altana rails only when a funded
        // settler is on this instance.
        terms: challenge(to, await settlerFor()),
        payAt: `/api/report?chainId=${chainId}&tokenId=${tokenId}`,
        how: "Send the amount to the address in the terms, then call this tool again with txHash, or GET payAt with a PAYMENT-SIGNATURE (or X-PAYMENT) header carrying the hash — or, on the signed rails, the base64 payment envelope.",
      };
      if (txHash === null) return terms;

      // Server-only: it opens the spent-receipt ledger and reads the chain.
      // Loaded here so the offline self-check, which drives this module in
      // plain Node, can still import it.
      const { settle } = await import("./settle.ts");
      const settled = await settle(txHash);
      if (!settled.paid) return { ...terms, rejected: settled.reason };

      const payment = { txHash: settled.txHash, payer: settled.payer, amount: settled.amount.toString(), asset: settled.asset, rail: settled.rail };
      try {
        return { paid: true, payment, report: await deepReport(chainId, tokenId) };
      } catch (e) {
        // The receipt is spent and the report failed. Say so rather than
        // leaving the payer guessing whether they were charged.
        return {
          paid: true,
          payment,
          error: e instanceof Error ? e.message : String(e),
          note: "Payment was accepted and the report could not be built. This receipt is spent; contact the operator.",
        };
      }
    },
  },
];

/**
 * One comparison column as the rows Form K-4 prints, in the same order.
 *
 * Kept beside the tool rather than in `compare.ts` so the comparison module
 * stays a data loader; this is the JSON rendering of it, the way the page is
 * the HTML one.
 */
function compareRow(c: Column): Json {
  const priced = c.proof?.tools.filter((t) => t.declaredPrice) ?? [];
  const services = c.quality?.endpoint_health?.services ?? [];
  const checked = services.filter((s) => s.status !== "skipped");
  const h = c.history;
  return {
    ref: c.ref,
    chainId: c.agent.chain_id,
    tokenId: c.agent.token_id,
    name: c.agent.name,
    seat: c.category,
    seatConfidence: c.confidence,
    canYouHireIt: { tier: c.assessment.tier, label: tierLabel(c.assessment.tier) },
    answersRightNow: c.proof
      ? { answered: c.proof.answered, protocol: c.proof.protocol, latencyMs: Math.round(c.proof.latencyMs), error: c.proof.error }
      : null,
    keepsAnswering:
      c.uptime && c.uptime.checks >= 2
        ? { answered: c.uptime.answered, checks: c.uptime.checks, since: new Date(c.uptime.since * 1000).toISOString().slice(0, 10), medianMs: c.uptime.medianMs }
        : null,
    whatItCanDo: c.proof?.toolCount
      ? { count: c.proof.toolCount, kind: c.proof.protocol === "a2a" ? "skills" : "tools", names: c.proof.tools.map((t) => t.name) }
      : null,
    declaredPrice:
      priced.length > 0
        ? priced.map((t) => `${t.declaredPrice!.amount} ${t.declaredPrice!.token}`).filter((v, i, a) => a.indexOf(v) === i)
        : c.proof?.tools.some((t) => t.declaredFree)
          ? "free"
          : null,
    domainProven: checked.length === 0 ? null : { verified: checked.filter((s) => s.domain_verified).length, checked: checked.length },
    trackRecord: { feedbackRecords: c.agent.total_feedbacks, averageScore: c.agent.average_score, registryScore: c.agent.total_score },
    scoreTrend: h && h.data_points >= 2 && h.score_change !== null ? { change: h.score_change, periodDays: h.period_days } : null,
    flaggedRisks: (c.quality?.risk_flags ?? []).slice(0, 4).map((f) => ({ id: f.id, severity: f.severity, title: f.title })),
    registered: new Date(c.agent.created_at).toISOString().slice(0, 10),
  };
}

/**
 * Everything Kawal holds about one agent, in one answer.
 *
 * The free tools each answer one question and each cost an upstream round
 * trip. This is all of them at once plus the parts that only exist here — the
 * full probe history, and a reading of *how* the endpoint fails rather than
 * just that it did.
 *
 * Exported because two surfaces serve it: the paid HTTP endpoint, and the
 * `deep_report` tool. Neither of them decides what it contains.
 */
export async function deepReport(chainId: number, tokenId: string): Promise<Json> {
  const agent = await getAgent(chainId, tokenId);
  const proof = await proveAgent(agent);
  const [observed, reputation, quality] = await Promise.all([
    observedFor(proof?.endpoint),
    getReputationCached(chainId, tokenId),
    getQuality(chainId, tokenId).catch(() => null),
  ]);
  const payment =
    agent.x402_supported === true && proof?.endpoint ? await checkX402Cached(proof.endpoint) : null;

  const assessment = assess(
    agent,
    undefined,
    observed && { ...observed, reachedAnotherWay: proof?.descriptor != null },
    payment ? { demanded: payment.demanded } : undefined,
    reputation,
    quality,
  );

  const failure = proof?.error ? diagnose(proof.error) : null;

  return {
    agent: {
      chainId,
      tokenId,
      name: agent.name,
      owner: agent.owner_address,
      registered: agent.created_at,
      declared: agent.supported_protocols ?? [],
    },
    tier: assessment.tier,
    tierLabel: tierLabel(assessment.tier),
    seat: classify(agent.name, agent.description).category,
    probe: proof && {
      endpoint: proof.endpoint,
      protocol: proof.protocol,
      answered: proof.answered,
      a2a: proof.a2a,
      serverName: proof.serverName,
      protocolVersion: proof.protocolVersion,
      toolCount: proof.toolCount,
      tools: proof.tools.map((t) => ({ name: t.name, declaredPrice: t.declaredPrice })),
      latencyMs: Math.round(proof.latencyMs),
      checkedAt: proof.checkedAt,
      error: proof.error,
    },
    // The part that is only here. "Does not answer" covers a vanished domain,
    // a host that disowned the agent, and an origin having a bad afternoon,
    // and they are not the same thing to a buyer.
    failure: failure && {
      kind: failure.failure,
      label: failureLabel(failure.failure),
      summary: failure.summary,
      mayRecover: failure.transient,
    },
    history: proof?.endpoint ? await uptimeFor(proof.endpoint) : null,
    payment: payment && {
      claimsX402: agent.x402_supported === true,
      demandedPayment: payment.demanded,
      quote: payment.quote,
      accepts: payment.accepts,
    },
    reputation: reputation && {
      records: reputation.total,
      sampled: reputation.sampled,
      carryingAMark: reputation.valued,
      inRegistryScoreField: reputation.scored,
      distinctWriters: reputation.raters,
      busiestWriter: reputation.topRater,
      busiestWriterShare: reputation.topRaterShare,
      withdrawn: reputation.revoked,
    },
    signals: assessment.signals.map((s) => ({ key: s.key, pass: s.pass, detail: s.detail })),
    caveats: [
      "Measured from a single vantage point: an endpoint that blocks this prober is indistinguishable from one that is down.",
      "The handshake (MCP) or the agent card plus a harmless JSON-RPC question (A2A) were read; no tool or skill was executed, so this is evidence the agent answers rather than that it works.",
    ],
  };
}

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ------------------------------------------------------- resources ---
 *
 * The documents an agent would rather read once than have paraphrased in
 * every tool answer. Each is the module the site itself is built from,
 * imported rather than copied, so the resource cannot drift from the page.
 */

type Resource = { uri: string; name: string; title: string; description: string; read: () => unknown };

export const RESOURCES: Resource[] = [
  {
    uri: "kawal://taxonomy",
    name: "taxonomy",
    title: "The seat taxonomy",
    description:
      "The five categories Kawal files agents under — four seats plus security — with the seat each fills, the search query that finds it and the terms that classify it. 8004scan has no category field; this is the layer that supplies one.",
    read: () => CATEGORIES.map((c) => ({ id: c.id, core: c.core, seat: c.seat, label: c.label, blurb: c.blurb, query: c.query, terms: c.terms })),
  },
  {
    uri: "kawal://venues",
    name: "venues",
    title: "The venue table and seat policies",
    description:
      "Every contract a seat may be allowed to call, with the chain it is proven on and what the identity call returned; and the four seat policies — cap share, period, venues, priority — that plan_mandate builds sessions from. No address here was written from memory.",
    read: () => ({ venues: VENUES, seats: SEAT_POLICIES }),
  },
  {
    uri: "kawal://known-defects",
    name: "known-defects",
    title: "What Kawal's measurements cannot see",
    description:
      "The defects of the probing method, published with every uptime record Kawal writes into the ERC-8004 reputation registry. Read this before treating a failed probe as a verdict.",
    read: () => KNOWN_DEFECTS,
  },
];

const RESOURCE_BY_URI = new Map(RESOURCES.map((r) => [r.uri, r]));

/* --------------------------------------------------------- prompts ---
 *
 * One workflow, the one the site is for: find an agent for a job, check it
 * answers, bound what it may spend. Written as the sequence of tool calls
 * rather than as advice, so an agent following it makes the same calls a
 * person clicking through the forms would.
 */

type Prompt = {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  render: (args: Record<string, string>) => string;
};

export const PROMPTS: Prompt[] = [
  {
    name: "hire_under_cap",
    title: "Find, verify and bound an agent",
    description:
      "Walk through hiring from the BSC roster the way Kawal does it: search by the problem, call the candidates, compare the evidence, read who rated them, and plan the spend cap before anything is granted.",
    arguments: [
      { name: "need", description: "What you need done, in plain words.", required: true },
      { name: "capitalUsdt", description: "Capital to entrust, in USDT. Defaults to 10000.", required: false },
      { name: "days", description: "How long the mandate runs. Defaults to 30.", required: false },
    ],
    render: ({ need, capitalUsdt = "10000", days = "30" }) =>
      [
        `You are hiring an ERC-8004 agent on BNB Smart Chain to: ${need}`,
        "",
        "Work through Kawal's tools in this order. Every answer is evidence Kawal gathered by calling agents itself; none is a registry claim repeated.",
        "",
        `1. find_agents { "query": ${JSON.stringify(need)}, "limit": 5 } — candidates by problem, duplicate registrations collapsed. The tier here is from what Kawal has already observed, not from a call made now.`,
        "2. verify_agent { \"tokenId\": <id> } for each candidate worth a look — a live handshake. Drop any whose probe.answered is false unless failure.mayRecover is true and the history says it usually answers.",
        "3. compare_agents { \"agents\": [{ \"tokenId\": <a> }, { \"tokenId\": <b> }] } for the two or three that answered — the same questions of each. Prefer the one whose domain verifies and whose keepsAnswering ratio is high; a declared price is the agent's claim, not a measurement.",
        "4. read_reputation { \"tokenId\": <id> } for the front-runner. If busiestWriterShare is high, the record is one voice, not many.",
        "5. check_payment { \"tokenId\": <id> } if the agent declares x402: whether it really asks to be paid before you budget for it.",
        `6. plan_mandate { "capitalUsdt": ${Number(capitalUsdt) || 10000}, "days": ${Number(days) || 30} } — the four bounded seats Kawal would grant on Altana. Nothing is granted by this call; read the seat the agent's category maps to and that seat's spend cap is the most it could ever spend.`,
        "",
        "Read the resource kawal://known-defects before treating any failed probe as a verdict: a single vantage point cannot tell 'down' from 'unreachable from here'.",
      ].join("\n"),
  },
];

const PROMPT_BY_NAME = new Map(PROMPTS.map((p) => [p.name, p]));

/* -------------------------------------------------------- protocol ---
 */

/** JSON-RPC error codes this server uses. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
/**
 * The settler the quote may advertise, or null when this instance has none.
 * Read through a dynamic import so the server module stays loadable in the
 * offline self-check, which never touches a wallet.
 */
async function settlerFor() {
  try {
    const { advertisedSettler } = await import("./settle.ts");
    return await advertisedSettler();
  } catch {
    return null;
  }
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** From the 2026-07-28 revision's reserved range. */
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** How long a client may cache the lists. They change with a deploy, not a request. */
const LIST_TTL_MS = 300_000;

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };
const CAPABILITIES = {
  tools: { listChanged: false },
  resources: { subscribe: false, listChanged: false },
  prompts: { listChanged: false },
};
const INSTRUCTIONS =
  "Kawal reports evidence it gathered itself. find_agents searches by problem; verify_agent dials an agent now; " +
  "compare_agents asks the same questions of up to three; uptime_history reads every probe kept; read_reputation says who wrote " +
  "an agent's feedback; check_payment asks whether it really charges; agents_by_owner dials everything one wallet minted; " +
  "plan_mandate turns capital into four bounded seats without granting them; deep_report is the paid whole. " +
  "The prompt hire_under_cap walks find, verify, compare, plan in order. Nothing here repeats a registry claim without saying so.";

/**
 * The transport-level facts a request arrived with. The Streamable HTTP
 * revision mirrors body fields into headers so intermediaries can route on
 * them, and a server that reads the body must check the two agree.
 */
export type RpcHeaders = {
  mcpMethod?: string | null;
  mcpName?: string | null;
  protocolVersion?: string | null;
};

export type RpcResponse = {
  status: number;
  body: Json | null;
  /** The revision the answer is in, for the response header. */
  version: string;
};

/**
 * Undoes the Base64 sentinel the transport uses for header values that are
 * not plain ASCII. A value not wearing the sentinel is returned as it came.
 */
function decodeHeaderValue(value: string): string {
  const m = value.match(/^=\?base64\?(.*)\?=$/);
  return m ? Buffer.from(m[1] ?? "", "base64").toString("utf8") : value;
}

/**
 * Answers one JSON-RPC message.
 *
 * Split from the route handler so the offline suite can drive the whole
 * protocol without a server: the handshake, an unknown method, a tool that
 * throws, and a notification that must not be answered at all.
 */
export async function handleRpc(message: unknown, headers: RpcHeaders = {}): Promise<RpcResponse> {
  if (typeof message !== "object" || message === null) {
    return { status: 400, body: rpcError(null, PARSE_ERROR, "expected a JSON-RPC object"), version: PROTOCOL_VERSION };
  }

  const msg = message as Json;
  const id = (msg.id ?? null) as string | number | null;
  const method = typeof msg.method === "string" ? msg.method : null;
  const params = (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Json;

  // Which revision the caller is speaking. A modern client says so in
  // `_meta` and in a header, which must agree; a legacy client says so in
  // `initialize` and nowhere else, and gets the negotiated answer below.
  const meta = (typeof params._meta === "object" && params._meta !== null ? params._meta : {}) as Json;
  const declaredInBody = typeof meta["io.modelcontextprotocol/protocolVersion"] === "string" ? (meta["io.modelcontextprotocol/protocolVersion"] as string) : null;
  const declaredInHeader = headers.protocolVersion?.trim() || null;
  if (declaredInBody && declaredInHeader && declaredInBody !== declaredInHeader) {
    return {
      status: 400,
      body: rpcError(id, HEADER_MISMATCH, `MCP-Protocol-Version header '${declaredInHeader}' does not match body value '${declaredInBody}'`),
      version: PROTOCOL_VERSION,
    };
  }
  const declared = declaredInBody ?? declaredInHeader;
  if (declared && !(SUPPORTED_VERSIONS as readonly string[]).includes(declared)) {
    return {
      status: 400,
      body: rpcError(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: declared }),
      version: PROTOCOL_VERSION,
    };
  }
  const version = declared ?? PROTOCOL_VERSION;
  const modern = version === MODERN_VERSION;

  if (!method) return { status: 400, body: rpcError(id, INVALID_REQUEST, "missing method"), version };

  // The mirrored headers, when present, must say what the body says. A load
  // balancer routing on `Mcp-Name: verify_agent` while the body calls
  // `deep_report` is exactly the split the check exists to catch.
  if (headers.mcpMethod != null && headers.mcpMethod !== method) {
    return { status: 400, body: rpcError(id, HEADER_MISMATCH, `Mcp-Method header '${headers.mcpMethod}' does not match body method '${method}'`), version };
  }
  const named = typeof params.name === "string" ? params.name : typeof params.uri === "string" ? params.uri : null;
  if (headers.mcpName != null && named !== null && decodeHeaderValue(headers.mcpName) !== named) {
    return { status: 400, body: rpcError(id, HEADER_MISMATCH, `Mcp-Name header does not match body value '${named}'`), version };
  }

  // A notification carries no id and must get no response body. Answering one
  // makes a well-behaved client wait for a reply to something it never asked
  // a question about.
  if (method.startsWith("notifications/") || msg.id === undefined || msg.id === null) {
    // 202 with no body: accepted, nothing to say back.
    return { status: 202, body: null, version };
  }

  const ok = (result: Json) => ({ status: 200, body: rpcResult(id, result), version });
  const cacheable = (result: Json) => ok({ ...result, ttlMs: LIST_TTL_MS, cacheScope: "public" });

  switch (method) {
    case "initialize": {
      // Legacy negotiation: echo a revision this server speaks, otherwise
      // offer the newest one that still has a handshake to answer.
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
      const agreed = asked && (SUPPORTED_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSION;
      return {
        status: 200,
        body: rpcResult(id, { protocolVersion: agreed, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }),
        version: agreed,
      };
    }

    case "server/discover":
      return cacheable({ supportedVersions: SUPPORTED_VERSIONS, capabilities: CAPABILITIES, instructions: INSTRUCTIONS });

    case "ping":
      return ok({});

    case "tools/list":
      return cacheable({
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, ...t.annotations },
        })),
      });

    case "tools/call": {
      const name = String(params.name ?? "");
      const tool = BY_NAME.get(name);
      if (!tool) return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `no tool named ${name}`), version };

      const args = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Json;
      try {
        const value = await tool.run(args);
        return ok({
          // Text content carrying JSON is what every MCP client here can read.
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
          isError: false,
        });
      } catch (e) {
        // A failing tool is a tool result, not a transport error: the caller
        // asked a valid question and deserves to hear why it could not be
        // answered rather than getting a protocol fault.
        const detail = e instanceof Error ? e.message : String(e);
        return ok({ content: [{ type: "text", text: detail.slice(0, 500) }], isError: true });
      }
    }

    case "resources/list":
      return cacheable({
        resources: RESOURCES.map((r) => ({ uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: "application/json" })),
      });

    case "resources/read": {
      const uri = String(params.uri ?? "");
      const resource = RESOURCE_BY_URI.get(uri);
      // Invalid params, as the 2026 revision has it; the older code (-32002)
      // was an implementation-range number no client here branched on.
      if (!resource) return { status: 200, body: rpcError(id, INVALID_PARAMS, `no resource at ${uri}`), version };
      return cacheable({
        contents: [{ uri: resource.uri, mimeType: "application/json", text: JSON.stringify(resource.read(), null, 2) }],
      });
    }

    case "prompts/list":
      return cacheable({
        prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })),
      });

    case "prompts/get": {
      const name = String(params.name ?? "");
      const prompt = PROMPT_BY_NAME.get(name);
      if (!prompt) return { status: 200, body: rpcError(id, INVALID_PARAMS, `no prompt named ${name}`), version };
      const given = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Json;
      const missing = prompt.arguments.filter((a) => a.required && typeof given[a.name] !== "string").map((a) => a.name);
      if (missing.length) return { status: 200, body: rpcError(id, INVALID_PARAMS, `missing required argument(s): ${missing.join(", ")}`), version };
      const strings = Object.fromEntries(Object.entries(given).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      return ok({
        description: prompt.description,
        messages: [{ role: "user", content: { type: "text", text: prompt.render(strings) } }],
      });
    }

    default:
      // The newer revision wants an unknown method told apart from a server
      // that does not host MCP at all, hence 404 there; older clients read
      // the JSON-RPC code and expect the HTTP layer to stay out of it.
      return { status: modern ? 404 : 200, body: rpcError(id, METHOD_NOT_FOUND, `unsupported method ${method}`), version };
  }
}

function rpcResult(id: string | number | null, result: Json): Json {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      ...result,
      resultType: "complete",
      _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
    },
  };
}

function rpcError(id: string | number | null, code: number, message: string, data?: Json): Json {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

export { INTERNAL_ERROR, METHOD_NOT_FOUND, INVALID_REQUEST, PARSE_ERROR };
