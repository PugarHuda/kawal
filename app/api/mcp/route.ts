import { NextResponse } from "next/server";
import {
  handleRpc,
  TOOLS,
  RESOURCES,
  PROMPTS,
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
} from "@/lib/server.mcp";

/**
 * Kawal's own MCP endpoint.
 *
 * The transport only. Every decision about what an answer means lives in
 * `lib/server.mcp.ts`, which is pure enough for the offline suite to drive the
 * whole protocol without starting a server. What lives here is the part the
 * offline suite cannot see: body limits, the mirrored headers the 2026-07-28
 * revision requires on every POST, and the version header echoed back.
 *
 * Deliberately unauthenticated and read-only, bar one tool. Nothing here
 * writes to a chain, spends anything, or touches the ledger — the tools dial
 * agents the registry already published and report what came back. The paid
 * report settles a receipt the caller already sent, which is the caller's
 * money moving, not Kawal's. An MCP endpoint that needed a key would be
 * useless to the agents it exists for.
 */

export const dynamic = "force-dynamic";

/** Bigger than any real JSON-RPC call, small enough not to be a lever. */
const MAX_BODY_BYTES = 64_000;

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large" } },
      { status: 413, headers: NO_STORE },
    );
  }

  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "body was not JSON" } },
      { status: 400, headers: NO_STORE },
    );
  }

  // A batch is a JSON-RPC feature MCP does not need and this does not pretend
  // to support: answering the first element of an array and dropping the rest
  // would be worse than saying so.
  if (Array.isArray(message)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batched requests are not supported" } },
      { status: 400, headers: NO_STORE },
    );
  }

  // The 2026-07-28 headers, read when present and never required: the
  // clients on BSC today send none of them, and Kawal's own prober is one.
  // An `Mcp-Session-Id` from an older client is ignored, as that revision
  // asks; nothing here ever had a session to look up.
  const { status, body, version } = await handleRpc(message, {
    mcpMethod: request.headers.get("mcp-method"),
    mcpName: request.headers.get("mcp-name"),
    protocolVersion: request.headers.get("mcp-protocol-version"),
  });
  const headers = { ...NO_STORE, "mcp-protocol-version": version };

  // A notification gets an empty 202. `NextResponse.json(null)` would send the
  // four bytes "null", which a client is entitled to try to parse as a reply.
  if (body === null) return new NextResponse(null, { status, headers });
  return NextResponse.json(body, { status, headers });
}

/**
 * A description of the endpoint for anything that arrives with a browser.
 *
 * MCP speaks POST, so a GET here is somebody looking rather than a client
 * connecting. Answering 405 with nothing is technically correct and unhelpful;
 * this says what the thing is and how to talk to it.
 *
 * It is also the server card: `/.well-known/mcp/server-card.json` rewrites
 * here, so the document a directory scans is built from the same tool list
 * the endpoint serves and cannot drift from it.
 */
export async function GET() {
  return NextResponse.json(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      protocol: "Model Context Protocol",
      protocolVersion: PROTOCOL_VERSION,
      protocolVersions: SUPPORTED_VERSIONS,
      transport: "POST JSON-RPC 2.0 to this URL (streamable HTTP)",
      readOnly: true,
      authentication: { required: false, schemes: [] },
      about:
        "Kawal reports evidence it collected itself: whether an agent's declared endpoint " +
        "answers, whether one claiming x402 ever asks to be paid, and who wrote its feedback. " +
        "No tool accepts a URL — callers name an agent by chain and token id, or an owner by wallet.",
      tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      resources: RESOURCES.map((r) => ({ uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: "application/json" })),
      prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })),
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

/** Preflight for browser-based MCP clients; the CORS headers come from next.config.ts. */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
