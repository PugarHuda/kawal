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
 * name an agent by chain and token id; the endpoint that gets dialled is the
 * one the *registry* published for that agent, and it still goes through the
 * SSRF guard on the way out. The blast radius of a hostile caller is therefore
 * "made Kawal probe a registered agent", which is what the site does anyway.
 */

import { getAgent } from "./scan.ts";
import { proveAgent } from "./probe.ts";
import { assess, tierLabel } from "./signals.ts";
import { classify } from "./taxonomy.ts";
import { observedFor, uptimeFor } from "./uptime.ts";
import { checkX402Cached } from "./x402.ts";
import { getReputationCached } from "./reputation.ts";
import { browse } from "./catalog.ts";
import { diagnose, failureLabel } from "./failure.ts";
import { BSC_MAINNET, SUPPORTED_CHAINS } from "./chains.ts";

export const SERVER_NAME = "kawal";
export const SERVER_VERSION = "0.1.0";
/** The revision Kawal's own client speaks, so it can dial itself. */
export const PROTOCOL_VERSION = "2025-06-18";

/**
 * Ceiling on how many agents one search call can ask Kawal to assess.
 *
 * Each result costs upstream work, and a caller asking for two hundred would
 * be spending someone else's rate limit. Twenty is more than a decision needs.
 */
const MAX_SEARCH = 20;

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

export type Tool = {
  name: string;
  description: string;
  inputSchema: Json;
  run: (args: Json) => Promise<Json>;
};

const AGENT_INPUT: Json = {
  type: "object",
  properties: {
    chainId: { type: "number", description: `Chain id. One of ${SUPPORTED_CHAINS.join(", ")}. Defaults to ${BSC_MAINNET}.` },
    tokenId: { type: "string", description: "ERC-8004 token id, decimal digits." },
  },
  required: ["tokenId"],
};

export const TOOLS: Tool[] = [
  {
    name: "verify_agent",
    description:
      "Call an agent's declared endpoint right now and report what answered. " +
      "This is a live handshake made by Kawal, not a reading of the registry: " +
      "an agent whose registration declares MCP but whose endpoint is gone is " +
      "reported as not answering. Returns the hireability tier and the evidence " +
      "behind it, including how many times Kawal has reached this endpoint before.",
    inputSchema: AGENT_INPUT,
    async run(args) {
      const chainId = chainOf(args);
      const tokenId = tokenOf(args);
      const agent = await getAgent(chainId, tokenId);

      const proof = await proveAgent(agent);
      const observed = observedFor(proof?.endpoint);
      const reputation = await getReputationCached(chainId, tokenId);
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
      );

      return {
        agent: { chainId, tokenId, name: agent.name, owner: agent.owner_address },
        tier: assessment.tier,
        tierLabel: tierLabel(assessment.tier),
        seat: classify(agent.name, agent.description).category,
        declared: agent.supported_protocols ?? [],
        probe: proof && {
          endpoint: proof.endpoint,
          answeredAsMcp: proof.isMcp,
          latencyMs: Math.round(proof.latencyMs),
          toolCount: proof.toolCount,
          error: proof.error,
          checkedAt: proof.checkedAt,
        },
        // The part no one else holds. A single reading is weather.
        history: proof?.endpoint ? uptimeFor(proof.endpoint) : null,
        signals: assessment.signals.map((s) => ({ key: s.key, pass: s.pass, detail: s.detail })),
      };
    },
  },

  {
    name: "check_payment",
    description:
      "Send the opening request of the x402 protocol — no payment header — and " +
      "report whether the server actually demands payment. `x402_supported` on " +
      "the registry is a flag a registration sets about itself; this is the " +
      "answer to asking. Kawal never settles a payment, so the price is quoted " +
      "in the server's own words and nothing moves.",
    inputSchema: AGENT_INPUT,
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
    description:
      "Report who wrote an agent's ERC-8004 feedback, not how much of it there " +
      "is. A sample of 1,200 BSC records came from 53 addresses, one of which " +
      "wrote 265 of the oldest 600, so a count of records is a count of writes " +
      "rather than of opinions. Returns how many carry a mark, how many " +
      "distinct addresses wrote them, and what share came from the busiest one.",
    inputSchema: AGENT_INPUT,
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
        chainId: { type: "number", description: `Chain id. Defaults to ${BSC_MAINNET}.` },
      },
      required: ["query"],
    },
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
    name: "deep_report",
    description:
      "Everything Kawal holds about one agent in a single answer: the live " +
      "handshake, the full probe history, how the endpoint fails when it " +
      "fails, whether it really charges, and who wrote its feedback. This one " +
      "costs money. Kawal measured that 75 of 200 BSC registrations declare " +
      "x402 support and that none of the reachable ones ever asks to be paid; " +
      "this is the counter-example. Calling it without payment returns the " +
      "terms rather than the report.",
    inputSchema: AGENT_INPUT,
    async run(args) {
      const chainId = chainOf(args);
      const tokenId = tokenOf(args);

      // Settlement is HTTP-layer: a JSON-RPC body has nowhere to carry a
      // receipt, and inventing a place would be a scheme nobody else speaks.
      // So this quotes the price and points at the endpoint that takes it.
      const { payTo, challenge, PRICE_WEI } = await import("./x402.terms.ts");
      const to = payTo();
      if (!to) {
        return { paid: false, forSale: false, reason: "this instance holds no wallet, so it charges for nothing" };
      }
      return {
        paid: false,
        forSale: true,
        priceWei: PRICE_WEI.toString(),
        terms: challenge(to),
        payAt: `/api/report?chainId=${chainId}&tokenId=${tokenId}`,
        how: "Send the amount to the address in the terms, then GET payAt with an X-PAYMENT header carrying the transaction hash.",
      };
    },
  },
];

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
  const observed = observedFor(proof?.endpoint);
  const reputation = await getReputationCached(chainId, tokenId);
  const payment =
    agent.x402_supported === true && proof?.endpoint ? await checkX402Cached(proof.endpoint) : null;

  const assessment = assess(
    agent,
    undefined,
    observed && { ...observed, reachedAnotherWay: proof?.descriptor != null },
    payment ? { demanded: payment.demanded } : undefined,
    reputation,
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
      answeredAsMcp: proof.isMcp,
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
    history: proof?.endpoint ? uptimeFor(proof.endpoint) : null,
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
      "The handshake and the tool list were read; no tool was executed, so this is evidence the agent answers rather than that it works.",
    ],
  };
}

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** JSON-RPC error codes this server uses. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export type RpcResponse = { status: number; body: Json | null };

/**
 * Answers one JSON-RPC message.
 *
 * Split from the route handler so the offline suite can drive the whole
 * protocol without a server: the handshake, an unknown method, a tool that
 * throws, and a notification that must not be answered at all.
 */
export async function handleRpc(message: unknown): Promise<RpcResponse> {
  if (typeof message !== "object" || message === null) {
    return { status: 400, body: rpcError(null, PARSE_ERROR, "expected a JSON-RPC object") };
  }

  const msg = message as Json;
  const id = (msg.id ?? null) as string | number | null;
  const method = typeof msg.method === "string" ? msg.method : null;

  if (!method) return { status: 400, body: rpcError(id, INVALID_REQUEST, "missing method") };

  // A notification carries no id and must get no response body. Answering one
  // makes a well-behaved client wait for a reply to something it never asked
  // a question about.
  const isNotification = msg.id === undefined || msg.id === null;

  if (method === "initialize") {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Kawal reports evidence it gathered itself. verify_agent dials an agent now; " +
          "check_payment asks whether it really charges; read_reputation says who wrote " +
          "its feedback. Nothing here repeats a registry claim without saying so.",
      }),
    };
  }

  if (method.startsWith("notifications/") || isNotification) {
    // 202 with no body: accepted, nothing to say back.
    return { status: 202, body: null };
  }

  if (method === "tools/list") {
    return {
      status: 200,
      body: rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }),
    };
  }

  if (method === "tools/call") {
    const params = (msg.params ?? {}) as Json;
    const name = String(params.name ?? "");
    const tool = BY_NAME.get(name);
    if (!tool) return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `no tool named ${name}`) };

    const args = (params.arguments ?? {}) as Json;
    try {
      const value = await tool.run(args);
      return {
        status: 200,
        body: rpcResult(id, {
          // Text content carrying JSON is what every MCP client here can read.
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
          isError: false,
        }),
      };
    } catch (e) {
      // A failing tool is a tool result, not a transport error: the caller
      // asked a valid question and deserves to hear why it could not be
      // answered rather than getting a protocol fault.
      const detail = e instanceof Error ? e.message : String(e);
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: "text", text: detail.slice(0, 500) }],
          isError: true,
        }),
      };
    }
  }

  return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `unsupported method ${method}`) };
}

function rpcResult(id: string | number | null, result: Json): Json {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export { INTERNAL_ERROR, METHOD_NOT_FOUND, INVALID_REQUEST, PARSE_ERROR };
