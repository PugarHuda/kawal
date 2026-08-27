import { test, expect } from "@playwright/test";

/**
 * Kawal's own MCP endpoint, exercised over HTTP against a production build.
 *
 * The offline suite drives `handleRpc` directly and covers the protocol. What
 * it cannot see is the transport: the route's body handling, the status codes,
 * and the header behaviour. This is the one public surface with no browser in
 * front of it, so a mistake here fails silently for every caller at once.
 */

const MCP = "/api/mcp";

async function rpc(request: import("@playwright/test").APIRequestContext, method: string, params?: unknown, id: unknown = 1) {
  const res = await request.post(MCP, {
    headers: { "content-type": "application/json" },
    data: { jsonrpc: "2.0", id, method, params },
  });
  return { status: res.status(), text: await res.text() };
}

test("the handshake names the protocol and the server", async ({ request }) => {
  const { status, text } = await rpc(request, "initialize");
  expect(status).toBe(200);
  const body = JSON.parse(text);
  expect(body.result.serverInfo.name).toBe("kawal");
  expect(body.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("a notification is accepted with no body to parse", async ({ request }) => {
  const res = await request.post(MCP, {
    headers: { "content-type": "application/json" },
    data: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  expect(res.status()).toBe(202);
  // Not the four bytes "null": a client is entitled to try to parse a body.
  expect(await res.text()).toBe("");
});

test("tools list themselves and none of them accepts a location", async ({ request }) => {
  const { text } = await rpc(request, "tools/list");
  const tools = JSON.parse(text).result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
  expect(tools.length).toBeGreaterThan(0);

  // The endpoint is public, unauthenticated, and fetches on the caller's
  // behalf. A tool taking a URL would make it an open proxy.
  for (const t of tools) {
    for (const key of Object.keys(t.inputSchema.properties ?? {})) {
      expect(key, `${t.name}.${key}`).not.toMatch(/url|uri|endpoint|host|address/i);
    }
  }
});

test("a real agent comes back with evidence, not with registry claims", async ({ request }) => {
  const { status, text } = await rpc(request, "tools/call", {
    name: "verify_agent",
    arguments: { tokenId: "43129" },
  });
  expect(status).toBe(200);
  const result = JSON.parse(text).result;
  expect(result.isError).toBeFalsy();

  const verified = result.structuredContent;
  expect(verified.agent.tokenId).toBe("43129");
  expect(verified.tier).toBeTruthy();
  // The part that is Kawal's rather than the registry's: a live handshake and
  // the history behind it.
  expect(verified.probe).toBeTruthy();
  expect(typeof verified.probe.answeredAsMcp).toBe("boolean");
  expect(Array.isArray(verified.signals)).toBe(true);
});

test("a bad argument is a tool result, not a transport fault", async ({ request }) => {
  const { status, text } = await rpc(request, "tools/call", {
    name: "verify_agent",
    arguments: { tokenId: "../../etc/passwd" },
  });
  // The caller asked a valid question and is owed the reason, not a 500.
  expect(status).toBe(200);
  const result = JSON.parse(text).result;
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/decimal token id/);
});

test("malformed and oversized requests are refused cleanly", async ({ request }) => {
  const notJson = await request.post(MCP, {
    headers: { "content-type": "application/json" },
    data: "{ not json",
  });
  expect(notJson.status()).toBe(400);

  const batched = await request.post(MCP, {
    headers: { "content-type": "application/json" },
    data: [{ jsonrpc: "2.0", id: 1, method: "initialize" }],
  });
  // Answering the first element and dropping the rest would be worse than
  // saying batches are not supported.
  expect(batched.status()).toBe(400);
  expect(await batched.text()).toMatch(/batched/i);
});

test("a browser landing on it is told what it is", async ({ request }) => {
  const res = await request.get(MCP);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.name).toBe("kawal");
  expect(body.readOnly).toBe(true);
  expect(body.tools.length).toBeGreaterThan(0);
});
