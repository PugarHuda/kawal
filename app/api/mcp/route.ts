import { NextResponse } from "next/server";
import { handleRpc, TOOLS, SERVER_NAME, SERVER_VERSION, PROTOCOL_VERSION } from "@/lib/server.mcp";

/**
 * Kawal's own MCP endpoint.
 *
 * The transport only. Every decision about what an answer means lives in
 * `lib/server.mcp.ts`, which is pure enough for the offline suite to drive the
 * whole protocol without starting a server.
 *
 * Deliberately unauthenticated and read-only. Nothing here writes to a chain,
 * spends anything, or touches the ledger — the four tools dial agents the
 * registry already published and report what came back. An MCP endpoint that
 * needed a key would be useless to the agents it exists for, and one that
 * could move money would be reckless without one.
 */

export const dynamic = "force-dynamic";

/** Bigger than any real JSON-RPC call, small enough not to be a lever. */
const MAX_BODY_BYTES = 64_000;

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large" } },
      { status: 413, headers: { "cache-control": "no-store" } },
    );
  }

  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "body was not JSON" } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  // A batch is a JSON-RPC feature MCP does not need and this does not pretend
  // to support: answering the first element of an array and dropping the rest
  // would be worse than saying so.
  if (Array.isArray(message)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batched requests are not supported" } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const { status, body } = await handleRpc(message);

  // A notification gets an empty 202. `NextResponse.json(null)` would send the
  // four bytes "null", which a client is entitled to try to parse as a reply.
  if (body === null) {
    return new NextResponse(null, { status, headers: { "cache-control": "no-store" } });
  }

  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * A description of the endpoint for anything that arrives with a browser.
 *
 * MCP speaks POST, so a GET here is somebody looking rather than a client
 * connecting. Answering 405 with nothing is technically correct and unhelpful;
 * this says what the thing is and how to talk to it.
 */
export async function GET() {
  return NextResponse.json(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocol: "Model Context Protocol",
      protocolVersion: PROTOCOL_VERSION,
      transport: "POST JSON-RPC 2.0 to this URL",
      readOnly: true,
      authentication: "none",
      about:
        "Kawal reports evidence it collected itself: whether an agent's declared endpoint " +
        "answers, whether one claiming x402 ever asks to be paid, and who wrote its feedback. " +
        "No tool accepts a URL — callers name an agent by chain and token id.",
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
