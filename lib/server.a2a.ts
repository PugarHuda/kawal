/**
 * Kawal as an A2A agent, so the agents that speak A2A can ask it things.
 *
 * Forty-six of the 114 agents Kawal lists speak A2A and nothing else. Until
 * the prober learned their language they were invisible to Kawal; until this
 * file, Kawal was invisible to them. An MCP endpoint is no use to an agent
 * whose only client is A2A.
 *
 * The card at `/.well-known/agent-card.json` and the JSON-RPC surface here
 * are the same two things Kawal reads off everybody else, which means Kawal's
 * own prober can be pointed at Kawal and gets the same answer it would give
 * for any other registration. Publishing a card without a server behind it
 * would be exactly the "declares an interface" claim this project exists to
 * check, and the offline suite asserts the card parses with Kawal's own reader.
 *
 * Every skill is one of the MCP tools. Same code, second door. Two
 * A2A-specific decisions: `message/send` answers with a `Message` rather than
 * a `Task`, because every skill completes inside the request and there is
 * nothing to track; and `message/stream` narrates that same work as the task
 * events the specification defines, then forgets the task. No task store
 * exists, so `tasks/get` says so with the error the specification names for
 * it rather than pretending to one.
 */

import { hexToBytes, sha256, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { TOOLS, SERVER_VERSION } from "./server.mcp.ts";
import { b64url, cardPayload, utf8 } from "./a2a.ts";

export const A2A_PROTOCOL_VERSION = "0.3.0";

type Json = Record<string, unknown>;

/**
 * Signs a card as A2A 0.3 `signatures` has it: one detached JWS, ES256K,
 * the signing key's JWK in the protected header so a reader needs nothing
 * but the card to check it. The account is the admin key — the one that
 * owns the mandate wallet — so whoever verifies this card learns which
 * on-chain identity stands behind it, not just that some key does.
 *
 * Raw r||s, low-s (viem signs that way), over SHA-256 of
 * `BASE64URL(protected) || '.' || BASE64URL(JCS(card))`, per RFC 7515 with
 * RFC 8812's ES256K. `lib/a2a.ts` verifies the same shape off every other
 * agent's card, and the self-check runs the two against each other.
 */
export async function signAgentCard(card: Json, privateKey: Hex): Promise<Json> {
  const pub = hexToBytes(privateKeyToAccount(privateKey).publicKey);
  const jwk = { kty: "EC", crv: "secp256k1", x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)) };
  const protectedHeader = b64url(utf8(JSON.stringify({ alg: "ES256K", jwk })));
  const payload = cardPayload(card);
  const signature = await sign({ hash: sha256(utf8(`${protectedHeader}.${payload}`)), privateKey, to: "bytes" });
  const unsigned = { ...card };
  delete unsigned.signatures;
  return { ...unsigned, signatures: [{ protected: protectedHeader, signature: b64url(signature.slice(0, 64)) }] };
}

/* --------------------------------------------------- error codes ---
 * From the A2A specification. JSON-RPC's own live in -32700..-32600.
 */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const TASK_NOT_FOUND = -32001;
const UNSUPPORTED_OPERATION = -32004;
const EXTENDED_CARD_NOT_CONFIGURED = -32007;

/** Worked examples for the card, one per skill, in the data-part form. */
const EXAMPLE_ARGS: Record<string, Json> = {
  find_agents: { query: "watch my lending position" },
  agents_by_owner: { owner: "0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92" },
  compare_agents: { agents: [{ tokenId: "43129" }, { tokenId: "153672" }] },
  plan_mandate: { capitalUsdt: 10000, days: 30 },
};

/**
 * The card, for the origin it is served from.
 *
 * `url` is absolute by the specification, so the origin comes from the
 * request rather than from a constant: a card that named `localhost` from a
 * deployed host would point every A2A client at nothing.
 */
export function agentCard(origin: string): Json {
  return {
    name: "Kawal",
    description:
      "Evidence about ERC-8004 agents on BNB Smart Chain, gathered by calling them. " +
      "Kawal dials a declared endpoint and reports whether it answered, asks an agent that " +
      "claims x402 whether it really charges, and reads who wrote its feedback. Nothing here " +
      "repeats a registry claim without saying so. The same skills are served over MCP at /api/mcp. " +
      "message/stream narrates a skill as task events and the task is gone once the stream closes; " +
      "there is no authenticated card, the public one is complete.",
    url: `${origin}/api/a2a`,
    provider: { organization: "Kawal", url: origin },
    version: SERVER_VERSION,
    protocolVersion: A2A_PROTOCOL_VERSION,
    preferredTransport: "JSONRPC",
    // The primary, restated as the specification asks, and the MCP door.
    // `transport` is an open string in the schema; "MCP" is not an A2A
    // transport, but the card is the one document an A2A client reads, and
    // an agent that speaks both should learn about the second door from it.
    additionalInterfaces: [
      { url: `${origin}/api/a2a`, transport: "JSONRPC" },
      { url: `${origin}/api/mcp`, transport: "MCP" },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    supportsAuthenticatedExtendedCard: false,
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    skills: TOOLS.map((t) => ({
      id: t.name,
      name: t.name.replace(/_/g, " "),
      description: t.description,
      tags: ["erc-8004", "bnb-chain", "verification"],
      inputModes: ["application/json", "text/plain"],
      outputModes: ["application/json"],
      examples: [JSON.stringify({ skill: t.name, ...(EXAMPLE_ARGS[t.name] ?? { tokenId: "43129" }) })],
    })),
  };
}

type Part = { kind?: unknown; text?: unknown; data?: unknown };

/**
 * Works out which skill was asked for and with what.
 *
 * A data part naming a skill is the precise form, and what every A2A seller
 * on BSC documents. A bare text part is accepted too, because a person typing
 * "check 43129" into an A2A client should get an answer rather than a schema
 * lecture: a token id in the text means verify it, anything else is a search.
 */
function readRequest(parts: Part[]): { skill: string; args: Json } {
  const data = parts.find((p) => p.kind === "data" && typeof p.data === "object" && p.data !== null);
  if (data) {
    const d = { ...(data.data as Json) };
    const skill = typeof d.skill === "string" ? d.skill : typeof d.tool === "string" ? d.tool : null;
    if (!skill) throw new RpcError(INVALID_PARAMS, "data part must name a skill");
    delete d.skill;
    delete d.tool;
    return { skill, args: d };
  }

  const text = parts
    .filter((p) => p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join(" ")
    .trim();
  if (text === "") throw new RpcError(INVALID_PARAMS, "message carried neither a data part nor text");

  const token = text.match(/\b(\d{3,})\b/);
  if (token) return { skill: "verify_agent", args: { tokenId: token[1] } };
  return { skill: "find_agents", args: { query: text } };
}

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Request_ = { skill: string; args: Json; contextId: string | null };

/** The envelope's message, resolved to a skill; throws RpcError for the caller's mistakes. */
function resolve(params: Json): Request_ {
  const incoming = (typeof params.message === "object" && params.message !== null ? params.message : null) as Json | null;
  if (!incoming || !Array.isArray(incoming.parts)) throw new RpcError(INVALID_PARAMS, "params.message.parts is required");
  const { skill, args } = readRequest(incoming.parts as Part[]);
  if (!TOOLS.some((t) => t.name === skill)) throw new RpcError(INVALID_PARAMS, `no skill named ${skill}`);
  return { skill, args, contextId: typeof incoming.contextId === "string" ? incoming.contextId : null };
}

/** Runs the skill. A refused argument is the caller's; a failure past validation is Kawal's. */
async function perform(r: Request_): Promise<Json> {
  const tool = TOOLS.find((t) => t.name === r.skill)!;
  try {
    return await tool.run(r.args);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const theirs = /must be|must not|must hold|no such|not a decimal/i.test(detail);
    throw new RpcError(theirs ? INVALID_PARAMS : INTERNAL_ERROR, detail.slice(0, 500));
  }
}

/** The answer, as parts: the precise form and the readable one. */
function partsOf(skill: string, result: Json) {
  return [
    { kind: "data", data: { skill, result } },
    { kind: "text", text: JSON.stringify(result) },
  ];
}

function now() {
  return new Date().toISOString();
}

export type A2aResponse = { status: number; body: Json | null };

/**
 * Answers one JSON-RPC message in the A2A dialect.
 *
 * Pure apart from the tools it calls, so the offline suite drives the whole
 * method table: the message path, the task errors, the unsupported
 * operations, and a notification that gets no body.
 */
export async function handleA2a(message: unknown): Promise<A2aResponse> {
  if (typeof message !== "object" || message === null) {
    return { status: 400, body: rpcError(null, PARSE_ERROR, "expected a JSON-RPC object") };
  }
  const msg = message as Json;
  const id = (msg.id ?? null) as string | number | null;
  const method = typeof msg.method === "string" ? msg.method : null;
  if (!method) return { status: 400, body: rpcError(id, INVALID_REQUEST, "missing method") };

  if (msg.id === undefined || msg.id === null) return { status: 202, body: null };

  const params = (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Json;

  switch (method) {
    case "message/send":
      return { status: 200, body: await send(id, params) };

    case "message/stream":
      // The HTTP transport serves this method as SSE via `streamA2a`. Reached
      // directly — the offline suite, or a caller that cannot read a stream —
      // it answers with the stream's end state: the finished task.
      return { status: 200, body: await finishedTask(id, params) };

    case "tasks/get":
    case "tasks/cancel":
    case "tasks/resubscribe":
      // Every skill completes inside the request, so no task outlives one to
      // be fetched. This is also the harmless question Kawal asks everyone
      // else, and it gets the answer it would expect.
      return {
        status: 200,
        body: rpcError(id, TASK_NOT_FOUND, "Kawal completes every skill inside the request and keeps no tasks"),
      };

    case "tasks/pushNotificationConfig/set":
    case "tasks/pushNotificationConfig/get":
    case "tasks/pushNotificationConfig/list":
    case "tasks/pushNotificationConfig/delete":
      return { status: 200, body: rpcError(id, UNSUPPORTED_OPERATION, "push notifications are not offered") };

    case "agent/getAuthenticatedExtendedCard":
      return {
        status: 200,
        body: rpcError(id, EXTENDED_CARD_NOT_CONFIGURED, "there is no authenticated card; the public one is complete"),
      };

    default:
      return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `unsupported method ${method}`) };
  }
}

async function send(id: string | number | null, params: Json): Promise<Json> {
  try {
    const request = resolve(params);
    const result = await perform(request);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        kind: "message",
        role: "agent",
        messageId: crypto.randomUUID(),
        ...(request.contextId ? { contextId: request.contextId } : {}),
        parts: partsOf(request.skill, result),
      },
    };
  } catch (e) {
    return e instanceof RpcError ? rpcError(id, e.code, e.message) : rpcError(id, INTERNAL_ERROR, String(e));
  }
}

async function finishedTask(id: string | number | null, params: Json): Promise<Json> {
  try {
    const request = resolve(params);
    const result = await perform(request);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        kind: "task",
        id: crypto.randomUUID(),
        contextId: request.contextId ?? crypto.randomUUID(),
        status: { state: "completed", timestamp: now() },
        artifacts: [{ artifactId: crypto.randomUUID(), name: request.skill, parts: partsOf(request.skill, result) }],
      },
    };
  } catch (e) {
    return e instanceof RpcError ? rpcError(id, e.code, e.message) : rpcError(id, INTERNAL_ERROR, String(e));
  }
}

/**
 * `message/stream`, as the sequence of events the specification defines.
 *
 * Each yielded value is one complete JSON-RPC response for the route to put
 * on the wire as one SSE `data:` line. The order is the one a client
 * expects: the task as submitted, a working status, the artifact, and a
 * completed status marked `final`. A request that cannot even be resolved to
 * a skill gets a single error response and nothing else, because no task was
 * ever created for it; a skill that fails after that ends the task as failed.
 *
 * The task id is minted for this stream and forgotten with it. `tasks/get`
 * for it answers TaskNotFound, which is the truth: nothing was kept.
 */
export async function* streamA2a(message: unknown): AsyncGenerator<Json> {
  if (typeof message !== "object" || message === null) {
    yield rpcError(null, PARSE_ERROR, "expected a JSON-RPC object");
    return;
  }
  const msg = message as Json;
  const id = (msg.id ?? null) as string | number | null;
  const params = (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Json;

  let request: Request_;
  try {
    request = resolve(params);
  } catch (e) {
    yield e instanceof RpcError ? rpcError(id, e.code, e.message) : rpcError(id, INTERNAL_ERROR, String(e));
    return;
  }

  const taskId = crypto.randomUUID();
  const contextId = request.contextId ?? crypto.randomUUID();
  const event = (result: Json) => ({ jsonrpc: "2.0", id, result });

  yield event({ kind: "task", id: taskId, contextId, status: { state: "submitted", timestamp: now() } });
  yield event({ kind: "status-update", taskId, contextId, status: { state: "working", timestamp: now() }, final: false });

  try {
    const result = await perform(request);
    yield event({
      kind: "artifact-update",
      taskId,
      contextId,
      artifact: { artifactId: crypto.randomUUID(), name: request.skill, parts: partsOf(request.skill, result) },
      append: false,
      lastChunk: true,
    });
    yield event({ kind: "status-update", taskId, contextId, status: { state: "completed", timestamp: now() }, final: true });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    yield event({
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state: "failed",
        timestamp: now(),
        message: { kind: "message", role: "agent", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: detail }] },
      },
      final: true,
    });
  }
}

function rpcError(id: string | number | null, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
