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
 * Every skill is one of the MCP tools. Same code, second door. The one
 * A2A-specific decision is that answers come back as a `Message` rather than
 * a `Task`: every skill completes inside the request, so there is no task to
 * track, and `tasks/get` says so with the error the specification names for
 * it rather than pretending to a task store it does not have.
 */

import { TOOLS, SERVER_VERSION } from "./server.mcp.ts";

export const A2A_PROTOCOL_VERSION = "0.3.0";

type Json = Record<string, unknown>;

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
      "repeats a registry claim without saying so. The same skills are served over MCP at /api/mcp.",
    url: `${origin}/api/a2a`,
    provider: { organization: "Kawal", url: origin },
    version: SERVER_VERSION,
    protocolVersion: A2A_PROTOCOL_VERSION,
    preferredTransport: "JSONRPC",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    skills: TOOLS.map((t) => ({
      id: t.name,
      name: t.name.replace(/_/g, " "),
      description: t.description,
      tags: ["erc-8004", "bnb-chain", "verification"],
      inputModes: ["application/json", "text/plain"],
      outputModes: ["application/json"],
      examples: [
        JSON.stringify({ skill: t.name, ...(t.name === "find_agents" ? { query: "watch my lending position" } : { tokenId: "43129" }) }),
      ],
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

  switch (method) {
    case "message/send":
      return { status: 200, body: await send(id, (msg.params ?? {}) as Json) };

    case "message/stream":
      return {
        status: 200,
        body: rpcError(id, UNSUPPORTED_OPERATION, "Kawal answers in one message; streaming is not offered"),
      };

    case "tasks/get":
    case "tasks/cancel":
    case "tasks/resubscribe":
      // Every skill completes inside the request, so no task ever exists to
      // be fetched. This is also the harmless question Kawal asks everyone
      // else, and it gets the answer it would expect.
      return {
        status: 200,
        body: rpcError(id, TASK_NOT_FOUND, "Kawal completes every skill synchronously and keeps no tasks"),
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
  const incoming = (typeof params.message === "object" && params.message !== null ? params.message : null) as Json | null;
  if (!incoming || !Array.isArray(incoming.parts)) {
    return rpcError(id, INVALID_PARAMS, "params.message.parts is required");
  }

  let request: { skill: string; args: Json };
  try {
    request = readRequest(incoming.parts as Part[]);
  } catch (e) {
    return e instanceof RpcError ? rpcError(id, e.code, e.message) : rpcError(id, INTERNAL_ERROR, String(e));
  }

  const tool = TOOLS.find((t) => t.name === request.skill);
  if (!tool) return rpcError(id, INVALID_PARAMS, `no skill named ${request.skill}`);

  try {
    const result = await tool.run(request.args);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        kind: "message",
        role: "agent",
        messageId: crypto.randomUUID(),
        ...(typeof incoming.contextId === "string" ? { contextId: incoming.contextId } : {}),
        parts: [
          { kind: "data", data: { skill: request.skill, result } },
          { kind: "text", text: JSON.stringify(result) },
        ],
      },
    };
  } catch (e) {
    // A refused argument is the caller's to fix and is reported as such; a
    // failure past validation is Kawal's and is reported as that.
    const detail = e instanceof Error ? e.message : String(e);
    const theirs = /must be|must not|no such|not a decimal/i.test(detail);
    return rpcError(id, theirs ? INVALID_PARAMS : INTERNAL_ERROR, detail.slice(0, 500));
  }
}

function rpcError(id: string | number | null, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
