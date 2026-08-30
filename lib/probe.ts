/**
 * Our own liveness proof for a declared agent endpoint.
 *
 * 8004scan publishes a cached health report, which is useful and is shown
 * alongside this. But it is a reading taken at some earlier moment, and it
 * grades a service "healthy" from its own vantage point. When someone is
 * about to hand an agent a spend cap, the honest thing is to knock on the
 * door now, from here, and say what answered.
 *
 * The bar is deliberately higher than "the URL responds". A registration that
 * points its MCP endpoint at an image file returns HTTP 200 all day. It has
 * to speak the protocol.
 */

import { McpClient, NONEXISTENT_TOOL, errorsCleanly } from "./mcp.ts";
import { probeA2a as fetchA2a, a2aAnswered, rpcOutcomeLabel, type RpcOutcome, type CardSignatureVerdict } from "./a2a.ts";
import { guardedFetch, readCapped, BlockedUrlError, MAX_RESPONSE_BYTES } from "./ssrf.ts";
import { memo } from "./memo.ts";
import { recordProbe } from "./uptime.ts";

/**
 * One thing an agent will actually do for you, and what it says that costs.
 *
 * The price is read out of the tool's own description because that is where
 * agents put it: Sentinels Audit labels its two tools "Free." and "Paid (0.2
 * BNB on BSC)". Nothing in 8004scan carries a price anywhere, and price is the
 * first question anyone deciding whether to hire actually has.
 *
 * Reported as *declared*, never as verified. The agent is the one making the
 * claim; Kawal is only refusing to hide it.
 */
export type ProbedTool = {
  name: string;
  description: string | null;
  /** A price the tool states in its own description, verbatim. */
  declaredPrice: { amount: string; token: string } | null;
  /** The tool says it is free. */
  declaredFree: boolean;
};

/**
 * A published way to reach an agent that is not an HTTP request.
 *
 * `install` is copied verbatim from what the agent published. Kawal never
 * runs it and never suggests Kawal ran it — it is quoted so a visitor can.
 */
export type ServiceDescriptor = {
  kind: "service-descriptor" | "source-repository";
  /** How the agent says it is spoken to: "stdio", "http", whatever it wrote. */
  transport: string | null;
  install: string | null;
};

export type EndpointProof = {
  endpoint: string;
  /** Which protocol this endpoint was probed as. The registry declared it. */
  protocol: "mcp" | "a2a" | "oasf";
  /** Something answered at this URL. */
  reachable: boolean;
  /**
   * It answered in the protocol it declared.
   *
   * This is the bar for hiring and the thing the uptime history counts. It
   * used to be `isMcp` alone, which made every A2A agent — 46 of the 114
   * listed — permanently unverifiable, not because they were silent but
   * because Kawal never learned their language.
   */
  answered: boolean;
  /** It answered as an MCP server specifically. */
  isMcp: boolean;
  /**
   * What the A2A JSON-RPC side did, when this was an A2A probe. `signature`
   * is whether the card's own JWS checked out: "unsigned" for every BSC card
   * read so far, "valid"/"invalid" once one carries `signatures`, and
   * "unsupported" for an algorithm Kawal cannot check. Optional because the
   * probes recorded before it existed have no such field.
   */
  a2a: { rpcUrl: string | null; rpc: RpcOutcome; rpcStatus: number; note: string; signature?: CardSignatureVerdict | null } | null;
  serverName: string | null;
  protocolVersion: string | null;
  toolCount: number | null;
  /** What it offers, capped so one agent cannot flood a page. */
  tools: ProbedTool[];
  /**
   * Set when the URL answers, but as something other than a hosted server.
   *
   * ERC-8004 lets a registration point at a *service descriptor* instead of a
   * live endpoint — real software, published with an install command, spoken
   * to over stdio rather than HTTP. Kawal used to POST JSON-RPC at those, get
   * a 405, and file them under "does not answer".
   *
   * That is the Fraast case inverted. There the registry over-claimed and the
   * probe caught it; here the probe under-claimed and buried a working agent.
   * Both are the product lying, and this one is worse, because the whole
   * pitch is that a listing carries its evidence.
   */
  descriptor: ServiceDescriptor | null;
  /** Round trip for the initialize call, in milliseconds. */
  latencyMs: number;
  error: string | null;
  checkedAt: string;
  /**
   * MCP only. Whether the server refused a call to a tool that cannot exist
   * with a JSON-RPC error or an `isError` result, rather than a 500 or a
   * hang. Says nothing about whether the real tools work — Kawal still never
   * runs one — but a server that falls over on an unknown name will fall over
   * on a caller's typo, and that is worth knowing before granting it a seat.
   * Null when not asked.
   */
  errorsCleanly?: boolean | null;
  /** A2A only. `agent/getAuthenticatedExtendedCard` answered as JSON-RPC. */
  extendedCard?: boolean | null;
  /** A2A only. Read off the card's capabilities block; null when it has none. */
  streaming?: boolean | null;
  pushNotifications?: boolean | null;
};

/** Tools listed on a page. Enough to judge an agent, short of a directory. */
const MAX_TOOLS_SHOWN = 24;

const PRICE = /\b(\d+(?:\.\d+)?)\s*(BNB|USDT|USDC|USD1|ETH|CAKE|WBNB)\b/i;
const FREE = /\bfree\b/i;

export function readTool(raw: unknown): ProbedTool | null {
  const t = raw as { name?: unknown; description?: unknown };
  if (typeof t?.name !== "string" || !t.name) return null;

  const description = typeof t.description === "string" ? t.description : null;
  const priced = description?.match(PRICE);

  return {
    name: t.name,
    description,
    declaredPrice:
      priced?.[1] !== undefined && priced[2] !== undefined
        ? { amount: priced[1], token: priced[2].toUpperCase() }
        : null,
    // "Free." at the head of a description is a claim; "free" buried in prose
    // about a free-tier upstream is not, so only trust it when nothing is
    // priced alongside it.
    declaredFree: Boolean(description && FREE.test(description) && !priced),
  };
}

/**
 * How long a proof is reused.
 *
 * Short enough that "live, not cached" stays honest — a minute-old reading of
 * an endpoint is still a reading of it, where an hour-old one is a memory.
 * Long enough that the agent page cannot be turned into an amplifier: without
 * this, every view of /agents/56/X fired a fresh outbound request at a
 * third-party host, so anyone looping that URL was driving traffic from our
 * server rather than theirs.
 */
const PROOF_TTL_MS = 60_000;

export function probeMcp(
  endpoint: string,
  opts: { timeoutMs?: number } = {},
): Promise<EndpointProof> {
  // Recorded inside the memo, so a burst of page views writes one row rather
  // than one per visitor. What is kept is what we actually asked, not how
  // often somebody looked.
  return memo(`probe:${endpoint}`, PROOF_TTL_MS, async () => {
    const proof = await probeMcpUncached(endpoint, opts);
    // Uptime answers "does this server stay up". A service descriptor is not
    // a server, so every future check would add another guaranteed miss and
    // the page would publish a 0% availability record for software that is
    // running fine on somebody's machine. Not measuring it is the honest
    // answer; measuring the wrong thing accurately is still wrong.
    if (!proof.descriptor) await recordProbe(proof);
    return proof;
  });
}

/** Code-forge hosts whose `/owner/repo` path is a published source location. */
const FORGES = new Set(["github.com", "www.github.com", "gitlab.com", "codeberg.org"]);

/**
 * Works out what a URL is, once we know it is not an HTTP MCP server.
 *
 * Two shapes are recognised, both exact rather than guessed. A registration
 * pointing at `github.com/bnb-chain/bnbchain-mcp` — the official BNB Chain MCP
 * server — is a source repository, readable off the URL alone. A registration
 * serving `{"type": ".../eip-8004#service.mcp"}` is a service descriptor, and
 * it carries the tool list the probe could not obtain by handshake.
 *
 * Anything else is left exactly as it was. A URL that answers HTML is still a
 * failed probe, and inventing a third category for it would be the guessing
 * this function exists to avoid.
 */
/**
 * A forge URL read as a source repository. Costs no request: the answer is in
 * the URL. Null when the URL is not one.
 */
function forgeDescriptor(endpoint: string, failed: EndpointProof): EndpointProof | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (!FORGES.has(url.hostname.toLowerCase())) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return null;
  return {
    ...failed,
    serverName: `${owner}/${repo}`,
    descriptor: {
      kind: "source-repository",
      transport: null,
      install: `git clone ${url.origin}/${owner}/${repo}`,
    },
  };
}

async function describeUncallable(
  endpoint: string,
  failed: EndpointProof,
): Promise<EndpointProof> {
  const forge = forgeDescriptor(endpoint, failed);
  if (forge) return forge;

  try {
    const res = await guardedFetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return failed;
    if (!(res.headers.get("content-type") ?? "").includes("json")) return failed;

    const body = JSON.parse(await readCapped(res, MAX_RESPONSE_BYTES)) as {
      type?: unknown;
      name?: unknown;
      version?: unknown;
      transport?: unknown;
      tools?: unknown;
      install?: Record<string, unknown>;
    };

    // The ERC-8004 service type is the whole claim. Without it this is just a
    // URL that happens to serve JSON.
    if (typeof body.type !== "string" || !body.type.includes("8004")) return failed;

    const listed = Array.isArray(body.tools) ? body.tools : [];
    const install = body.install ?? {};
    const command = ["npx", "claudeCode", "command"]
      .map((k) => install[k])
      .find((v): v is string => typeof v === "string");

    return {
      ...failed,
      serverName: typeof body.name === "string" ? body.name : null,
      protocolVersion: typeof body.version === "string" ? body.version : null,
      toolCount: listed.length,
      tools: listed
        .slice(0, MAX_TOOLS_SHOWN)
        .map(readTool)
        .filter((t): t is ProbedTool => t !== null),
      descriptor: {
        kind: "service-descriptor",
        transport: typeof body.transport === "string" ? body.transport : null,
        install: command ?? null,
      },
    };
  } catch {
    // A descriptor lookup is a bonus pass over an already-failed probe. If it
    // fails too, the original failure is still the honest answer.
    return failed;
  }
}

/**
 * Handshakes with an MCP endpoint and counts its tools.
 *
 * Never throws: a probe that crashes the page it informs is worse than a
 * probe that reports a failure.
 */
async function probeMcpUncached(
  endpoint: string,
  opts: { timeoutMs?: number } = {},
): Promise<EndpointProof> {
  const checkedAt = new Date().toISOString();
  const base: EndpointProof = {
    endpoint,
    protocol: "mcp",
    reachable: false,
    answered: false,
    isMcp: false,
    a2a: null,
    serverName: null,
    protocolVersion: null,
    toolCount: null,
    tools: [],
    descriptor: null,
    latencyMs: 0,
    error: null,
    checkedAt,
  };

  // Caught early because it is the single most common broken registration:
  // an endpoint field holding an image or a document rather than a server.
  if (!/^https?:\/\//i.test(endpoint)) {
    return { ...base, error: "not an http(s) URL" };
  }
  if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|txt|md)(\?|$)/i.test(endpoint)) {
    return { ...base, error: "endpoint points at a file, not a server" };
  }

  const client = new McpClient(endpoint, { timeoutMs: opts.timeoutMs ?? 20_000 });

  const init = await client.initialize();
  if (!init.ok) {
    const failed: EndpointProof = {
      ...base,
      latencyMs: Math.round(init.ms),
      reachable: init.status > 0,
      error: init.error ?? null,
    };
    // One GET, only after the handshake has already failed. Nothing that
    // answers JSON-RPC ever reaches this, so a live server pays nothing.
    return init.status > 0 ? await describeUncallable(endpoint, failed) : failed;
  }

  const info = init.result as
    | { protocolVersion?: string; serverInfo?: { name?: string; version?: string } }
    | undefined;

  const proof: EndpointProof = {
    ...base,
    reachable: true,
    answered: true,
    isMcp: true,
    serverName: info?.serverInfo?.name ?? null,
    protocolVersion: info?.protocolVersion ?? null,
    latencyMs: Math.round(init.ms),
  };

  // Tool count is what turns "a server is up" into "here is what you can ask
  // it to do", so it is worth the second round trip. A server that greets us
  // and then refuses to list tools is still live, just less useful.
  const tools = await client.listTools();
  if (tools.ok) {
    const list = (tools.result as { tools?: unknown[] } | undefined)?.tools;
    if (Array.isArray(list)) {
      proof.toolCount = list.length;
      proof.tools = list
        .slice(0, MAX_TOOLS_SHOWN)
        .map(readTool)
        .filter((t): t is ProbedTool => t !== null);
    }
  }

  // The one `tools/call` with no effect. Nothing named this exists, so
  // nothing runs; what comes back is how the server says no, which is the
  // closest Kawal can get to exercising a stranger's server without
  // exercising it.
  proof.errorsCleanly = errorsCleanly(await client.callTool(NONEXISTENT_TOOL, {}));

  return proof;
}

/**
 * What an OASF endpoint served, once it is known to be JSON.
 *
 * Read off the live BSC registrations rather than the AGNTCY specification:
 * of 331 agents declaring OASF, most point at the specification's own GitHub
 * repository, one serves a record with `oasf_version` and `name`, and one
 * serves its A2A agent card. What every real one has in common is a string
 * `name` for the agent it describes, so that is the bar; a version is read
 * from whichever field carries it and skills from whichever shape they take.
 *
 * Exported so the offline suite can drive it with the shapes read live.
 */
export function readOasfRecord(
  body: unknown,
): { name: string; version: string | null; skills: Array<{ name: string; description: string | null }> } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || b.name.trim() === "") return null;

  const version = ["oasf_version", "schema_version", "version"]
    .map((k) => b[k])
    .find((v): v is string => typeof v === "string") ?? null;

  const skills = (Array.isArray(b.skills) ? b.skills : [])
    .map((raw): { name: string; description: string | null } | null => {
      if (typeof raw === "string") return raw ? { name: raw, description: null } : null;
      if (typeof raw !== "object" || raw === null) return null;
      const r = raw as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name : typeof r.id === "string" ? r.id : null;
      return name ? { name, description: typeof r.description === "string" ? r.description : null } : null;
    })
    .filter((x): x is { name: string; description: string | null } => x !== null);

  return { name: b.name, version, skills };
}

/** A record is a short document; anything approaching a megabyte is not one. */
const OASF_BYTES = 256_000;

/**
 * Dials an OASF endpoint: a guarded GET that must answer with a record.
 *
 * OASF has no handshake — the endpoint *is* the document — so the only bar
 * available is "served JSON describing an agent", which is lower than an MCP
 * initialize and said so in the tier: an OASF-only agent can be hireable
 * only once this has actually answered, never on the declaration alone.
 */
export function probeOasf(endpoint: string, opts: { timeoutMs?: number } = {}): Promise<EndpointProof> {
  return memo(`probe:${endpoint}`, PROOF_TTL_MS, async () => {
    const proof = await probeOasfUncached(endpoint, opts);
    // Same rule as MCP: a repository is not a server, and measuring its
    // uptime would publish a 0% record for software that is running fine.
    if (!proof.descriptor) await recordProbe(proof);
    return proof;
  });
}

async function probeOasfUncached(endpoint: string, opts: { timeoutMs?: number } = {}): Promise<EndpointProof> {
  const base: EndpointProof = {
    endpoint,
    protocol: "oasf",
    reachable: false,
    answered: false,
    isMcp: false,
    a2a: null,
    serverName: null,
    protocolVersion: null,
    toolCount: null,
    tools: [],
    descriptor: null,
    latencyMs: 0,
    error: null,
    checkedAt: new Date().toISOString(),
  };
  if (!/^https?:\/\//i.test(endpoint)) return { ...base, error: "not an http(s) URL" };

  // Most OASF declarations on BSC point at github.com/agntcy/oasf — the
  // specification, not the agent. A repository answers HTML (or JSON, asked
  // nicely), and calling that an agent answering would be the prober
  // over-claiming. It is a published route, recorded as one.
  const forge = forgeDescriptor(endpoint, base);
  if (forge) return forge;

  const started = performance.now();
  try {
    const res = await guardedFetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const latencyMs = Math.round(performance.now() - started);
    const text = await readCapped(res, OASF_BYTES);
    if (!res.ok) {
      return { ...base, reachable: true, latencyMs, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ...base, reachable: true, latencyMs, error: "answered, but not with JSON" };
    }
    const record = readOasfRecord(body);
    if (!record) {
      return { ...base, reachable: true, latencyMs, error: "answered JSON, but not a record naming an agent" };
    }

    return {
      ...base,
      reachable: true,
      answered: true,
      serverName: record.name,
      protocolVersion: record.version,
      toolCount: record.skills.length,
      tools: record.skills
        .slice(0, MAX_TOOLS_SHOWN)
        .map((sk) => readTool({ name: sk.name, description: sk.description ?? undefined }))
        .filter((t): t is ProbedTool => t !== null),
      latencyMs,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      latencyMs: Math.round(performance.now() - started),
      // A blocked URL is a refusal, not a transport failure, and the page
      // renders the two differently.
      error: e instanceof BlockedUrlError ? `blocked: ${message}` : message,
    };
  }
}

/** The endpoint shape 8004scan publishes under an agent's `services`. */
export type DeclaredService = {
  endpoint?: string;
  version?: string;
  tools?: string[];
};

/** Pulls a declared endpoint out of an agent's services, by protocol key. */
function endpointOf(
  services: Record<string, DeclaredService> | null | undefined,
  key: "mcp" | "a2a" | "oasf",
): string | null {
  const svc = services?.[key];
  return typeof svc?.endpoint === "string" ? svc.endpoint : null;
}

/**
 * Probes an A2A endpoint and renders the result in the same shape as an MCP
 * proof, so every page and every check downstream reads one thing.
 *
 * Skills become the tool list: same fields, same price extraction, same
 * table. The difference a reader needs — that these are A2A skills reached
 * over JSON-RPC rather than MCP tools — is carried in `protocol` and `a2a`,
 * not hidden by the shared shape.
 */
export function probeA2aEndpoint(
  endpoint: string,
  opts: { timeoutMs?: number } = {},
): Promise<EndpointProof> {
  return memo(`probe:${endpoint}`, PROOF_TTL_MS, async () => {
    const checkedAt = new Date().toISOString();
    const p = await fetchA2a(endpoint, opts);
    const answered = a2aAnswered(p);

    const proof: EndpointProof = {
      endpoint,
      protocol: "a2a",
      reachable: p.card !== null || p.rpc === "answered" || p.rpc === "gated" || p.rpc === "not-json-rpc",
      answered,
      isMcp: false,
      a2a: {
        rpcUrl: p.rpcUrl,
        rpc: p.rpc,
        rpcStatus: p.rpcStatus,
        note: rpcOutcomeLabel(p.rpc),
        signature: p.signature ?? null,
      },
      serverName: p.card?.name ?? null,
      protocolVersion: p.card?.protocolVersion ?? null,
      extendedCard: p.extendedCard,
      streaming: p.card?.streaming ?? null,
      pushNotifications: p.card?.pushNotifications ?? null,
      toolCount: p.card ? p.card.skills.length : null,
      tools: (p.card?.skills ?? [])
        .slice(0, MAX_TOOLS_SHOWN)
        .map((s) => readTool({ name: s.name, description: s.description ?? undefined }))
        .filter((t): t is ProbedTool => t !== null),
      descriptor: null,
      latencyMs: p.latencyMs,
      error: p.error,
      checkedAt,
    };

    await recordProbe(proof);
    return proof;
  });
}

/**
 * Proof for an agent, or null when it declares nothing to call.
 *
 * The null is load-bearing and different from a failed probe: "no endpoint
 * declared" means we never knocked, where a failed proof means we knocked and
 * nobody answered. Callers render those differently, so collapsing them into
 * one shape would let a page claim it checked something it never touched.
 */
export function proveAgent(
  agent: { services: Record<string, DeclaredService> | null },
  opts: { timeoutMs?: number } = {},
): Promise<EndpointProof | null> {
  // MCP first when both are declared: its handshake returns more (a server
  // name, a protocol revision, a tool list with descriptions) and the four
  // agents on BSC that declare both serve the same software behind each.
  const mcp = endpointOf(agent.services, "mcp");
  if (mcp) return probeMcp(mcp, opts);
  const a2a = endpointOf(agent.services, "a2a");
  if (a2a) return probeA2aEndpoint(a2a, opts);
  // Last, because it proves least: a document served, not a server spoken to.
  const oasf = endpointOf(agent.services, "oasf");
  if (oasf) return probeOasf(oasf, opts);
  return Promise.resolve(null);
}
