import { test, expect } from "@playwright/test";

/**
 * Kawal's own ERC-8004 registration document, and the sweep it must not run
 * for strangers.
 *
 * The document is what the Identity Registry's URI resolves to and what
 * 8004scan turns into the `services` block every listing is built from. The
 * rule it is held to is the rule this project holds everyone to: nothing
 * declared that Kawal's prober would not verify. So the test reads the
 * document and then dials what it declares, from the same origin.
 */

test("the registration document declares only what answers", async ({ request, baseURL }) => {
  const res = await request.get("/.well-known/agent-registration.json");
  expect(res.status()).toBe(200);
  const doc = await res.json();

  expect(doc.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
  expect(doc.name).toBe("Kawal");
  expect(doc.supportedTrust).toContain("reputation");

  const byName = Object.fromEntries(doc.services.map((s: { name: string; endpoint: string }) => [s.name, s.endpoint]));
  expect(byName.mcp).toBe(`${baseURL}/api/mcp`);
  expect(byName.a2a).toBe(`${baseURL}/.well-known/agent-card.json`);
  expect(byName.web).toBe(baseURL);

  // Dial what it declares. The MCP endpoint must complete the handshake, in
  // the revision the document names for it…
  const mcp = await request.post(byName.mcp, {
    headers: { "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  const handshake = (await mcp.json()).result;
  expect(handshake.serverInfo.name).toBe("kawal");
  const mcpService = doc.services.find((s: { name: string }) => s.name === "mcp");
  expect(handshake.protocolVersion).toBe(mcpService.version);
  // …and list exactly the tools the document counts.
  const listed = await request.post(byName.mcp, {
    headers: { "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  });
  const tools = (await listed.json()).result.tools as Array<{ name: string }>;
  expect(mcpService.description).toContain(`${tools.length} tools`);
  for (const t of tools) expect(mcpService.description).toContain(t.name);

  // …and the A2A card must name a JSON-RPC endpoint that answers.
  const card = await (await request.get(byName.a2a)).json();
  const rpc = await request.post(card.url, {
    headers: { "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } },
  });
  expect((await rpc.json()).jsonrpc).toBe("2.0");

  // x402Support is a claim Kawal measured to be false on 75 of 75 reachable
  // registrations. Here it must be exactly as true as the challenge is.
  const report = await request.get("/api/report?tokenId=43129");
  expect(doc.x402Support).toBe(report.status() === 402);
  expect(doc.active).toBe(doc.x402Support);
});

test("the sweep refuses to run without its secret", async ({ request }) => {
  // This instance has no CRON_SECRET, and an endpoint that runs because a
  // variable is missing is the wrong default.
  const res = await request.get("/api/cron/sweep");
  expect(res.status()).toBe(503);
  expect((await res.json()).error).toMatch(/CRON_SECRET/);
});
