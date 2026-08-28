import { test, expect } from "@playwright/test";

/**
 * Kawal's own MCP endpoint, exercised over HTTP against a production build.
 *
 * The offline suite drives `handleRpc` directly and covers the protocol. What
 * it cannot see is the transport: the route's body handling, the status codes,
 * and the header behaviour. This is the one public surface with no browser in
 * front of it, so a mistake here fails silently for every caller at once.
 *
 * Two eras of client are served on the one URL. The 2025 ones open with
 * `initialize`; the 2026-07-28 ones send no handshake and declare their
 * version on every request in `_meta` and a header. Both are exercised.
 */

const MCP = "/api/mcp";
const MODERN = "2026-07-28";

type Ctx = import("@playwright/test").APIRequestContext;

async function rpc(request: Ctx, method: string, params?: unknown, id: unknown = 1, headers: Record<string, string> = {}) {
  const res = await request.post(MCP, {
    headers: { "content-type": "application/json", ...headers },
    data: { jsonrpc: "2.0", id, method, params },
  });
  return { status: res.status(), text: await res.text(), headers: res.headers() };
}

/**
 * The smallest valid call for every tool. A tool added without an entry here
 * fails the suite, which is the point: every tool must be callable.
 *
 * 43129 is a live BSC agent; 153672 is BORT, an A2A one. The owner is Kawal's
 * own wallet, which may hold no registrations — the tool must still answer.
 */
const MIN_ARGS: Record<string, unknown> = {
  verify_agent: { tokenId: "43129" },
  check_payment: { tokenId: "43129" },
  read_reputation: { tokenId: "43129" },
  find_agents: { query: "watch my lending position", limit: 3 },
  agents_by_owner: { owner: "0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92" },
  compare_agents: { agents: [{ tokenId: "43129" }, { chainId: 56, tokenId: "153672" }] },
  uptime_history: { tokenId: "43129" },
  plan_mandate: { capitalUsdt: 10000, days: 30 },
  deep_report: { tokenId: "43129" },
};

test("the handshake names the protocol and the server, and echoes the id", async ({ request }) => {
  const { status, text } = await rpc(request, "initialize", {}, "init-7");
  expect(status).toBe(200);
  const body = JSON.parse(text);
  expect(body.id).toBe("init-7");
  expect(body.result.serverInfo.name).toBe("kawal");
  expect(body.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // Capabilities are advertised, not implied.
  expect(body.result.capabilities.tools).toBeTruthy();
  expect(body.result.capabilities.resources).toBeTruthy();
  expect(body.result.capabilities.prompts).toBeTruthy();
});

test("a requested revision is echoed when it is spoken, and replaced when it is not", async ({ request }) => {
  for (const asked of ["2025-06-18", "2025-11-25"]) {
    const body = JSON.parse((await rpc(request, "initialize", { protocolVersion: asked })).text);
    expect(body.result.protocolVersion).toBe(asked);
  }
  const body = JSON.parse((await rpc(request, "initialize", { protocolVersion: "1900-01-01" })).text);
  expect(body.error).toBeUndefined();
  expect(body.result.protocolVersion).not.toBe("1900-01-01");
});

test("a modern client needs no handshake and is answered in its own revision", async ({ request }) => {
  const meta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "spec", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };
  const { status, text, headers } = await rpc(request, "tools/list", { _meta: meta }, 3, { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" });
  expect(status).toBe(200);
  expect(headers["mcp-protocol-version"]).toBe(MODERN);
  const result = JSON.parse(text).result;
  expect(result.resultType).toBe("complete");
  expect(result.ttlMs).toBeGreaterThan(0);
  expect(result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("kawal");

  const discover = JSON.parse((await rpc(request, "server/discover", { _meta: meta }, 4, { "mcp-protocol-version": MODERN })).text);
  expect(discover.result.supportedVersions).toContain(MODERN);
  expect(discover.result.supportedVersions).toContain("2025-06-18");
});

test("an unknown revision is refused with the list of known ones", async ({ request }) => {
  const { status, text } = await rpc(request, "tools/list", {}, 5, { "mcp-protocol-version": "1900-01-01" });
  expect(status).toBe(400);
  const body = JSON.parse(text);
  expect(body.error.code).toBe(-32022);
  expect(body.error.data.supported).toContain(MODERN);
  expect(body.error.data.requested).toBe("1900-01-01");
});

test("the mirrored headers must agree with the body", async ({ request }) => {
  const wrongMethod = await rpc(request, "tools/list", {}, 6, { "mcp-method": "tools/call" });
  expect(wrongMethod.status).toBe(400);
  expect(JSON.parse(wrongMethod.text).error.code).toBe(-32020);

  const wrongName = await rpc(request, "tools/call", { name: "plan_mandate", arguments: MIN_ARGS.plan_mandate }, 7, { "mcp-method": "tools/call", "mcp-name": "verify_agent" });
  expect(wrongName.status).toBe(400);
  expect(JSON.parse(wrongName.text).error.code).toBe(-32020);

  const rightName = await rpc(request, "tools/call", { name: "plan_mandate", arguments: MIN_ARGS.plan_mandate }, 8, { "mcp-method": "tools/call", "mcp-name": "plan_mandate" });
  expect(rightName.status).toBe(200);
  expect(JSON.parse(rightName.text).result.isError).toBe(false);

  // The Base64 sentinel the transport uses for names that are not header-safe.
  const encoded = `=?base64?${Buffer.from("plan_mandate", "utf8").toString("base64")}?=`;
  const sentinel = await rpc(request, "tools/call", { name: "plan_mandate", arguments: MIN_ARGS.plan_mandate }, 9, { "mcp-name": encoded });
  expect(sentinel.status).toBe(200);

  const versions = await rpc(request, "tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } }, 10, { "mcp-protocol-version": "2025-06-18" });
  expect(versions.status).toBe(400);
  expect(JSON.parse(versions.text).error.code).toBe(-32020);
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

test("tools list themselves, annotated, and none of them accepts a location", async ({ request }) => {
  const { text } = await rpc(request, "tools/list");
  const tools = JSON.parse(text).result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> }; annotations: Record<string, unknown> }>;
  expect(tools.length).toBeGreaterThan(0);

  for (const t of tools) {
    // The endpoint is public, unauthenticated, and fetches on the caller's
    // behalf. A tool taking a URL would make it an open proxy.
    for (const key of Object.keys(t.inputSchema.properties ?? {})) {
      expect(key, `${t.name}.${key}`).not.toMatch(/url|uri|endpoint|host|address/i);
    }
    expect(typeof t.annotations.readOnlyHint, `${t.name} says whether it reads`).toBe("boolean");
    expect(typeof t.annotations.openWorldHint, `${t.name} says whether it calls out`).toBe("boolean");
    expect(MIN_ARGS, `${t.name} has a minimal call in this suite`).toHaveProperty(t.name);
  }
  // The paid tool is the one that may change state, and says so.
  expect(tools.find((t) => t.name === "deep_report")!.annotations.readOnlyHint).toBe(false);
  expect(tools.find((t) => t.name === "plan_mandate")!.annotations.openWorldHint).toBe(false);
});

for (const [name, args] of Object.entries(MIN_ARGS)) {
  test(`${name} answers a minimal call with structured content`, async ({ request }) => {
    const { status, text } = await rpc(request, "tools/call", { name, arguments: args });
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.error, `${name} must not be a protocol fault`).toBeUndefined();
    const result = body.result;
    // A network-bound tool may report an unreachable agent; that is an
    // answer, not an error. What it may not do is fail as a tool.
    expect(result.isError, result.content?.[0]?.text).toBeFalsy();
    expect(result.structuredContent).toBeTruthy();
    expect(typeof result.structuredContent).toBe("object");
    expect(result.content[0].type).toBe("text");
  });
}

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
  expect(typeof verified.probe.answered).toBe("boolean");
  expect(["mcp", "a2a"]).toContain(verified.probe.protocol);
  expect(Array.isArray(verified.signals)).toBe(true);
});

test("the comparison answers the form's questions of each agent", async ({ request }) => {
  const { text } = await rpc(request, "tools/call", { name: "compare_agents", arguments: MIN_ARGS.compare_agents });
  const rows = JSON.parse(text).result.structuredContent.agents as Array<Record<string, unknown>>;
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    for (const key of ["canYouHireIt", "answersRightNow", "keepsAnswering", "whatItCanDo", "declaredPrice", "domainProven", "trackRecord", "flaggedRisks", "registered"]) {
      expect(row, key).toHaveProperty(key);
    }
  }
  const four = await rpc(request, "tools/call", { name: "compare_agents", arguments: { agents: [{ tokenId: "1" }, { tokenId: "2" }, { tokenId: "3" }, { tokenId: "4" }] } });
  expect(JSON.parse(four.text).result.isError).toBe(true);
});

test("the mandate plan is the four seats, bounded, and refuses what the form refuses", async ({ request }) => {
  const { text } = await rpc(request, "tools/call", { name: "plan_mandate", arguments: { capitalUsdt: 10000, days: 30 } });
  const plan = JSON.parse(text).result.structuredContent;
  expect(plan.seats.length).toBe(4);
  expect(plan.committedUsdt).toBeLessThanOrEqual(10000);
  for (const seat of plan.seats) {
    expect(seat.contracts.length).toBeGreaterThan(0);
    expect(seat.spendCap[0].limitUsdt).toBeGreaterThan(0);
  }
  const tooLong = await rpc(request, "tools/call", { name: "plan_mandate", arguments: { capitalUsdt: 100, days: 9999 } });
  expect(JSON.parse(tooLong.text).result.isError).toBe(true);
});

test("the paid tool quotes the terms unpaid and refuses a hash that is not a receipt", async ({ request }) => {
  const unpaid = JSON.parse((await rpc(request, "tools/call", { name: "deep_report", arguments: { tokenId: "43129" } })).text).result;
  expect(unpaid.isError).toBeFalsy();
  expect(unpaid.structuredContent.paid).toBe(false);
  if (unpaid.structuredContent.forSale) {
    expect(unpaid.structuredContent.terms.accepts[0].payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(unpaid.structuredContent.terms.x402Version).toBe(2);
  }

  const malformed = JSON.parse((await rpc(request, "tools/call", { name: "deep_report", arguments: { tokenId: "43129", txHash: "0xnope" } })).text).result;
  expect(malformed.isError).toBe(true);
  expect(malformed.content[0].text).toMatch(/64 hex/);

  // A well-formed hash that paid nobody is refused with the same terms, not
  // a fault: the caller is exactly where they were, and told why.
  const nobody = JSON.parse((await rpc(request, "tools/call", { name: "deep_report", arguments: { tokenId: "43129", txHash: `0x${"ab".repeat(32)}` } })).text).result;
  expect(nobody.isError).toBeFalsy();
  expect(nobody.structuredContent.paid).toBe(false);
  if (nobody.structuredContent.forSale) expect(nobody.structuredContent.rejected).toBeTruthy();
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

test("resources are listed and readable, and are the modules the site is built from", async ({ request }) => {
  const list = JSON.parse((await rpc(request, "resources/list")).text).result;
  const uris = list.resources.map((r: { uri: string }) => r.uri);
  expect(uris).toEqual(expect.arrayContaining(["kawal://taxonomy", "kawal://venues", "kawal://known-defects"]));

  const defects = JSON.parse((await rpc(request, "resources/read", { uri: "kawal://known-defects" })).text).result;
  expect(defects.contents[0].mimeType).toBe("application/json");
  const text = JSON.parse(defects.contents[0].text);
  expect(Array.isArray(text)).toBe(true);
  expect(text.join(" ")).toMatch(/vantage point/);

  const venues = JSON.parse(JSON.parse((await rpc(request, "resources/read", { uri: "kawal://venues" })).text).result.contents[0].text);
  expect(venues.seats.length).toBe(4);
  expect(venues.venues["venus.comptroller"]).toBeTruthy();

  const missing = JSON.parse((await rpc(request, "resources/read", { uri: "kawal://nothing" })).text);
  expect(missing.error.code).toBe(-32602);
});

test("the prompt walks find, verify, compare, plan in order", async ({ request }) => {
  const list = JSON.parse((await rpc(request, "prompts/list")).text).result;
  expect(list.prompts.map((p: { name: string }) => p.name)).toContain("hire_under_cap");

  const got = JSON.parse((await rpc(request, "prompts/get", { name: "hire_under_cap", arguments: { need: "rebalance my PancakeSwap range", capitalUsdt: "500" } })).text).result;
  const text = got.messages[0].content.text as string;
  expect(got.messages[0].role).toBe("user");
  expect(text).toMatch(/rebalance my PancakeSwap range/);
  for (const step of ["find_agents", "verify_agent", "compare_agents", "read_reputation", "plan_mandate"]) {
    expect(text).toContain(step);
  }
  expect(text.indexOf("find_agents")).toBeLessThan(text.indexOf("plan_mandate"));
  expect(text).toMatch(/"capitalUsdt": 500/);

  const bare = JSON.parse((await rpc(request, "prompts/get", { name: "hire_under_cap" })).text);
  expect(bare.error.code).toBe(-32602);
});

test("an unknown method is told apart from a malformed envelope", async ({ request }) => {
  const unknown = await rpc(request, "kawal/nonsense");
  expect(unknown.status).toBe(200);
  expect(JSON.parse(unknown.text).error.code).toBe(-32601);

  // A modern client is owed the HTTP status too, so it can tell an unknown
  // method from a server that does not host MCP at all.
  const modernUnknown = await rpc(request, "kawal/nonsense", {}, 2, { "mcp-protocol-version": MODERN });
  expect(modernUnknown.status).toBe(404);
  expect(JSON.parse(modernUnknown.text).error.code).toBe(-32601);

  const noMethod = await request.post(MCP, { headers: { "content-type": "application/json" }, data: { jsonrpc: "2.0", id: 1 } });
  expect(noMethod.status()).toBe(400);
  expect((await noMethod.json()).error.code).toBe(-32600);

  const notJson = await request.post(MCP, { headers: { "content-type": "application/json" }, data: "{ not json" });
  expect(notJson.status()).toBe(400);
  expect((await notJson.json()).error.code).toBe(-32700);

  const batched = await request.post(MCP, {
    headers: { "content-type": "application/json" },
    data: [{ jsonrpc: "2.0", id: 1, method: "initialize" }],
  });
  // Answering the first element and dropping the rest would be worse than
  // saying batches are not supported.
  expect(batched.status()).toBe(400);
  expect(await batched.text()).toMatch(/batched/i);
});

test("a browser landing on it is told what it is, and so is a directory", async ({ request }) => {
  const res = await request.get(MCP);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.name).toBe("kawal");
  expect(body.readOnly).toBe(true);
  expect(body.tools.length).toBeGreaterThan(0);
  expect(body.authentication.required).toBe(false);

  // The server card at the well-known path is the same document, so it
  // cannot list a tool the endpoint does not serve.
  const card = await request.get("/.well-known/mcp/server-card.json");
  expect(card.status()).toBe(200);
  const served = await card.json();
  expect(served.serverInfo.name).toBe("kawal");
  expect(served.tools.map((t: { name: string }) => t.name)).toEqual(body.tools.map((t: { name: string }) => t.name));
  expect(card.headers()["access-control-allow-origin"]).toBe("*");
});

test("cross-origin clients are let in: no key, no cookie, nothing to protect", async ({ request }) => {
  const posted = await request.post(MCP, { headers: { "content-type": "application/json", origin: "https://example.test" }, data: { jsonrpc: "2.0", id: 1, method: "ping" } });
  expect(posted.headers()["access-control-allow-origin"]).toBe("*");
  expect(posted.headers()["access-control-expose-headers"]).toMatch(/mcp-protocol-version/i);

  const preflight = await request.fetch(MCP, { method: "OPTIONS", headers: { origin: "https://example.test", "access-control-request-method": "POST" } });
  expect([200, 204]).toContain(preflight.status());
  expect(preflight.headers()["access-control-allow-headers"]).toMatch(/mcp-method/i);
});
