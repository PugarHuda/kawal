/**
 * A minimal MCP client, and the reason Kawal can say "hireable" honestly.
 *
 * Up to now every claim about an agent came from 8004scan's index: it says a
 * registration declares MCP, so we called it callable. Three registrations
 * broke that assumption in a single afternoon —
 *
 *   Fraast      declares MCP and points at a .jpg
 *   AgentLISA   declares MCP and answers 502
 *   Sentinels   declares MCP and is a real server
 *
 * Only one of those can be hired, and nothing in the index distinguishes
 * them. So we speak the protocol ourselves.
 *
 * Deliberately hand-rolled rather than pulled from a package: all we need is
 * JSON-RPC over HTTP with two response encodings, and an SDK would drag a
 * transport stack in for `initialize` and `tools/list`.
 *
 * Every URL reaching this client came out of a registration a stranger paid a
 * few cents to mint, so all traffic goes through `guardedFetch` — see
 * lib/ssrf.ts for what that refuses and why.
 */

import { guardedFetch, readCapped, BlockedUrlError, MAX_RESPONSE_BYTES } from "./ssrf.ts";

export type McpResult = {
  ok: boolean;
  /** Round-trip time for this call alone, in milliseconds. */
  ms: number;
  status: number;
  /** JSON-RPC `result`, when the call succeeded. */
  result?: unknown;
  /** JSON-RPC `error`, or a transport failure rendered as one. */
  error?: string;
};

const PROTOCOL_VERSION = "2025-06-18";

/**
 * MCP over HTTP allows either a plain JSON body or an SSE stream, and servers
 * in the wild pick either. HeyAnon answers JSON with a 201; others stream.
 * Parsing only one of the two would misreport a live server as broken.
 */
function parseBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty response");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);

  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload && payload !== "[DONE]") return JSON.parse(payload);
  }
  throw new Error("no JSON payload in SSE stream");
}

export class McpClient {
  readonly url: string;
  private sessionId: string | null = null;
  private id = 0;
  private timeoutMs: number;
  private maxBytes: number;

  /**
   * `maxBytes` defaults tight because the common caller is the liveness probe,
   * which only needs a handshake off a URL a stranger controls. Deliberate
   * tool calls raise it: Aster's `getSupportedMarkets` legitimately returns
   * 1.6 MB of market filters, and the borrowed 1 MB default silently turned a
   * working agent into a failed one in the advantage report.
   */
  constructor(url: string, opts: { timeoutMs?: number; maxBytes?: number } = {}) {
    this.url = url;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  }

  private async rpc(method: string, params: unknown = {}): Promise<McpResult> {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

      const res = await guardedFetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: controller.signal,
      });

      const session = res.headers.get("mcp-session-id");
      if (session) this.sessionId = session;

      const text = await readCapped(res, this.maxBytes);
      const ms = performance.now() - started;

      if (!res.ok) {
        return { ok: false, ms, status: res.status, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
      }

      const body = parseBody(text) as { result?: unknown; error?: { message?: string } };
      if (body.error) {
        return { ok: false, ms, status: res.status, error: body.error.message ?? "JSON-RPC error" };
      }
      return { ok: true, ms, status: res.status, result: body.result };
    } catch (e) {
      const ms = performance.now() - started;
      const message = e instanceof Error ? e.message : String(e);
      // A blocked URL is a refusal, not a transport failure, and the caller
      // renders the two differently.
      if (e instanceof BlockedUrlError) {
        return { ok: false, ms, status: 0, error: `blocked: ${message}` };
      }
      return {
        ok: false,
        ms,
        status: 0,
        error: controller.signal.aborted ? `timed out after ${this.timeoutMs}ms` : message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  initialize() {
    return this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "kawal", version: "0.1" },
    });
  }

  listTools() {
    return this.rpc("tools/list");
  }

  callTool(name: string, args: Record<string, unknown>) {
    return this.rpc("tools/call", { name, arguments: args });
  }
}

/** Pulls the text an MCP tool returned, whichever shape the server used. */
export function toolText(result: unknown): string {
  const r = result as
    | { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }
    | undefined;
  if (r?.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
  const first = r?.content?.find((c) => c.type === "text");
  return first?.text ?? JSON.stringify(result);
}
