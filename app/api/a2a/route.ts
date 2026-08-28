import { NextResponse } from "next/server";
import { handleA2a, streamA2a, agentCard } from "@/lib/server.a2a";
import { originOf } from "@/lib/origin";

/**
 * Kawal's A2A JSON-RPC endpoint. The card at /.well-known/agent-card.json
 * names this URL.
 *
 * Transport only; every decision lives in `lib/server.a2a.ts`, which the
 * offline suite drives without a server. Read-only and unauthenticated for
 * the same reasons the MCP endpoint is: nothing here writes, spends or touches
 * the ledger, and an A2A endpoint that needed a key would be useless to the
 * agents it exists for.
 *
 * `message/stream` is the one method that does not answer with a JSON body:
 * it is Server-Sent Events, one JSON-RPC response per `data:` line, as the
 * specification has it, and the stream closes after the event marked final.
 */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64_000;
const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
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

  if (Array.isArray(message)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batched requests are not supported" } },
      { status: 400, headers: NO_STORE },
    );
  }

  const asked = message as { method?: unknown; id?: unknown } | null;
  if (asked?.method === "message/stream" && asked.id !== undefined && asked.id !== null) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const event of streamA2a(message)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      // `x-accel-buffering: no` asks a proxy in front to pass events through
      // as they are written rather than holding the whole stream.
      headers: { ...NO_STORE, "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" },
    });
  }

  const { status, body } = await handleA2a(message);
  if (body === null) return new NextResponse(null, { status, headers: NO_STORE });
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * A GET is somebody looking, not a client connecting. One BSC agent answers
 * its own /a2a GET with a worked example; this does the same, and points at
 * the card.
 */
export async function GET(request: Request) {
  const origin = originOf(request);
  const card = agentCard(origin);
  return NextResponse.json(
    {
      endpoint: "A2A JSON-RPC 0.3, POST only. message/stream answers as text/event-stream.",
      agentCard: `${origin}/.well-known/agent-card.json`,
      mcp: `${origin}/api/mcp`,
      example: {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            role: "user",
            messageId: "example",
            parts: [{ kind: "data", data: { skill: "verify_agent", tokenId: "43129" } }],
          },
        },
      },
      skills: (card.skills as Array<{ id: string }>).map((s) => s.id),
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

/** Preflight for browser-based A2A clients; the CORS headers come from next.config.ts. */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
