/**
 * Speaking A2A, so that 46 of 114 listed agents stop being invisible.
 *
 * Kawal's prober spoke MCP and nothing else. Measured across the catalogue
 * that is 5 MCP-only agents it could verify against 46 A2A-only agents it
 * said nothing about — and the A2A ones are the ERC-8183 sellers, which is to
 * say the part of BSC where hiring actually happens. A marketplace that can
 * verify the minority protocol and shrugs at the majority is verifying the
 * wrong thing.
 *
 * A2A (Agent2Agent, Linux Foundation, v0.3) publishes an *agent card* — a
 * JSON document at `/.well-known/agent-card.json` naming the agent, its
 * skills and the JSON-RPC URL it is spoken to at. Every card read here was
 * fetched live from a BSC registration before this was written; the shapes
 * below are those, not the specification's examples.
 *
 * Two calls, both side-effect free:
 *
 *   GET  the card                 proves the agent describes itself
 *   POST tasks/get {id: nonsense} proves a JSON-RPC server is listening
 *
 * `tasks/get` for an id that does not exist is the one A2A method with no
 * effect: the specification says it answers TaskNotFound. Servers that do
 * not implement it answer MethodNotFound, which is just as good — the point
 * is a JSON-RPC envelope came back. What is never sent is `message/send`,
 * because that starts work on somebody else's server, and Kawal's rule about
 * not running strangers' tools uninvited applies to skills exactly as it does
 * to tools.
 */

import { guardedFetch, readCapped, BlockedUrlError } from "./ssrf.ts";

/** A card is a short document. Anything approaching a megabyte is not one. */
const CARD_BYTES = 256_000;
const RPC_BYTES = 64_000;

export type AgentCardSkill = {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
};

export type AgentCard = {
  name: string;
  description: string | null;
  /** The JSON-RPC endpoint the card says to speak to. */
  url: string | null;
  version: string | null;
  protocolVersion: string | null;
  preferredTransport: string | null;
  /** Declared in the card's capabilities block, when it is. */
  declaresX402: boolean;
  skills: AgentCardSkill[];
  provider: string | null;
};

/**
 * Reads a card out of a parsed body, or null if it is not one.
 *
 * Strict on the two fields that make it a card — a name and a skills array —
 * and lenient on everything else, because the cards in the wild disagree on
 * optional fields and refusing a real agent over a missing `version` would
 * be the prober under-claiming again.
 *
 * Exported so the offline suite can drive it with the shapes read off live
 * registrations.
 */
export function readAgentCard(body: unknown): AgentCard | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || b.name.trim() === "") return null;
  if (!Array.isArray(b.skills)) return null;

  const skills = b.skills
    .map((raw): AgentCardSkill | null => {
      if (typeof raw !== "object" || raw === null) return null;
      const s = raw as Record<string, unknown>;
      const id = typeof s.id === "string" ? s.id : typeof s.name === "string" ? s.name : null;
      if (!id) return null;
      return {
        id,
        name: typeof s.name === "string" ? s.name : id,
        description: typeof s.description === "string" ? s.description : null,
        tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === "string") : [],
      };
    })
    .filter((s): s is AgentCardSkill => s !== null);

  const caps = (typeof b.capabilities === "object" && b.capabilities !== null ? b.capabilities : {}) as Record<string, unknown>;
  const provider = (typeof b.provider === "object" && b.provider !== null ? b.provider : {}) as Record<string, unknown>;

  return {
    name: b.name,
    description: typeof b.description === "string" ? b.description : null,
    url: typeof b.url === "string" && /^https?:\/\//i.test(b.url) ? b.url : null,
    version: typeof b.version === "string" ? b.version : null,
    protocolVersion: typeof b.protocolVersion === "string" ? b.protocolVersion : null,
    preferredTransport: typeof b.preferredTransport === "string" ? b.preferredTransport : null,
    declaresX402: caps.x402 === true,
    skills,
    provider: typeof provider.organization === "string" ? provider.organization : null,
  };
}

/** What the JSON-RPC endpoint did when asked a harmless question. */
export type RpcOutcome =
  /** Answered with a JSON-RPC envelope. A server is listening. */
  | "answered"
  /** 401 or 403: a server is there and wants credentials Kawal does not hold. */
  | "gated"
  /** Answered, but not with JSON-RPC. Something else lives at that URL. */
  | "not-json-rpc"
  /** Connection failed, timed out, or 5xx. */
  | "silent"
  /** There was no URL to try. */
  | "not-tried";

export type A2aProbe = {
  endpoint: string;
  card: AgentCard | null;
  /** Where the harmless call went, if anywhere. */
  rpcUrl: string | null;
  rpc: RpcOutcome;
  /** HTTP status of the JSON-RPC call, 0 when it never connected. */
  rpcStatus: number;
  /** Round trip for the card fetch. */
  latencyMs: number;
  error: string | null;
};

/**
 * The one A2A call with no effect, asked of a URL.
 *
 * Any JSON-RPC envelope counts — an error is as good as a result here, since
 * the question was never meant to be answered, only to be recognised.
 */
async function askHarmlessly(url: string, timeoutMs: number): Promise<{ rpc: RpcOutcome; status: number }> {
  try {
    const res = await guardedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "kawal",
        method: "tasks/get",
        params: { id: "kawal-liveness-probe" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 401 || res.status === 403) return { rpc: "gated", status: res.status };
    if (res.status >= 500) return { rpc: "silent", status: res.status };

    try {
      const body = JSON.parse(await readCapped(res, RPC_BYTES)) as Record<string, unknown>;
      const envelope = body.jsonrpc === "2.0" && ("result" in body || "error" in body);
      return { rpc: envelope ? "answered" : "not-json-rpc", status: res.status };
    } catch {
      return { rpc: "not-json-rpc", status: res.status };
    }
  } catch {
    return { rpc: "silent", status: 0 };
  }
}

/**
 * Probes one A2A endpoint as the registry declared it.
 *
 * The declared endpoint is usually the card, and sometimes the JSON-RPC URL
 * itself — one BSC registration points straight at `/a2a`, which answers GET
 * with prose and POST with JSON-RPC. Both are handled: if what comes back is
 * not a card, the same URL is asked the harmless question directly.
 */
export async function probeA2a(endpoint: string, opts: { timeoutMs?: number } = {}): Promise<A2aProbe> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const base: A2aProbe = {
    endpoint,
    card: null,
    rpcUrl: null,
    rpc: "not-tried",
    rpcStatus: 0,
    latencyMs: 0,
    error: null,
  };

  const started = performance.now();
  let card: AgentCard | null = null;
  let cardStatus = 0;

  try {
    const res = await guardedFetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    cardStatus = res.status;
    if (res.ok) {
      try {
        card = readAgentCard(JSON.parse(await readCapped(res, CARD_BYTES)));
      } catch {
        card = null;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      latencyMs: Math.round(performance.now() - started),
      error: e instanceof BlockedUrlError ? `blocked: ${message}` : message,
    };
  }
  const latencyMs = Math.round(performance.now() - started);

  // The card names the server; failing that, the declared URL is the server.
  const rpcUrl = card?.url ?? endpoint;
  const asked = await askHarmlessly(rpcUrl, timeoutMs);

  let error: string | null = null;
  if (!card && asked.rpc !== "answered") {
    error =
      cardStatus === 0
        ? "no response"
        : cardStatus >= 400
          ? `HTTP ${cardStatus}`
          : "answered, but not with an agent card or a JSON-RPC envelope";
  } else if (card && asked.rpc === "silent") {
    // A card can be a static file on a CDN in front of a dead server. The card
    // alone is a description, not a heartbeat.
    error = `agent card served, but its JSON-RPC endpoint did not answer${asked.status ? ` (HTTP ${asked.status})` : ""}`;
  }

  return {
    endpoint,
    card,
    rpcUrl,
    rpc: asked.rpc,
    rpcStatus: asked.status,
    latencyMs,
    error,
  };
}

/**
 * Whether the probe counts as the agent answering.
 *
 * A card plus a server that either answered or asked for credentials; or, with
 * no card, a server that answered JSON-RPC directly. A card over a silent
 * server is not an answer, and neither is a server that answered something
 * other than JSON-RPC.
 */
export function a2aAnswered(p: A2aProbe): boolean {
  if (p.card) return p.rpc === "answered" || p.rpc === "gated";
  return p.rpc === "answered";
}

/** One line on what the JSON-RPC side did, for a page. */
export function rpcOutcomeLabel(o: RpcOutcome): string {
  switch (o) {
    case "answered":
      return "JSON-RPC endpoint answered";
    case "gated":
      return "JSON-RPC endpoint requires credentials";
    case "not-json-rpc":
      return "URL answered, but not with JSON-RPC";
    case "silent":
      return "JSON-RPC endpoint did not answer";
    case "not-tried":
      return "no JSON-RPC endpoint to try";
  }
}
