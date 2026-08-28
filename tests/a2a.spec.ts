import { test, expect } from "@playwright/test";

/**
 * A2A, both directions.
 *
 * Reading: 46 of the 114 agents Kawal lists speak A2A and nothing else, and
 * until the prober learned it they were invisible. Two of them are visited
 * here, in the two shapes the registry holds — a card at the well-known path,
 * and a bare JSON-RPC URL that answers GET with prose.
 *
 * Serving: Kawal publishes its own card and JSON-RPC surface. The card is
 * fetched from the well-known path a client would try first, and the same
 * request Kawal sends every other agent is sent to Kawal.
 *
 * Live agents move, so the reading tests assert the page's own consistency —
 * an A2A headline beside A2A evidence — rather than any particular number.
 */

/** BORT: a spec-shaped card at /.well-known/agent-card.json. */
const CARD_AGENT = "/agents/56/153672";
/** Brain on BNB: the declared endpoint is the JSON-RPC URL itself. */
const BARE_AGENT = "/agents/56/304494";

test("an A2A agent with a well-known card is verified as A2A, not filed as silent", async ({ page }) => {
  await page.goto(CARD_AGENT);
  const probe = page.locator("section").filter({ hasText: "We just called it" });
  await expect(probe).toBeVisible();

  const headline = ((await probe.locator("p span").first().textContent()) ?? "").trim();
  // Whatever the server did today, the protocol in the headline must be the
  // one that was actually spoken. "Answers MCP" here would be a lie.
  expect(headline).not.toMatch(/MCP/);
  if (/^Answers/.test(headline)) {
    expect(headline).toBe("Answers A2A");
    await expect(probe.getByText("Skills offered")).toBeVisible();
    await expect(probe.getByText("JSON-RPC", { exact: true })).toBeVisible();
    // The honesty note is protocol-specific: no message was sent.
    await expect(probe.getByText(/sent no message/)).toBeVisible();
  }
});

test("an A2A agent declared by its bare JSON-RPC URL is still reached", async ({ page }) => {
  await page.goto(BARE_AGENT);
  const probe = page.locator("section").filter({ hasText: "We just called it" });
  await expect(probe).toBeVisible();
  const headline = ((await probe.locator("p span").first().textContent()) ?? "").trim();
  expect(headline).not.toMatch(/MCP/);
  // No card, so no skills row — but the JSON-RPC row says what answered.
  await expect(probe.getByText("JSON-RPC", { exact: true })).toBeVisible();
});

test("Kawal's own card is at the well-known path and names a live endpoint", async ({ request, baseURL }) => {
  const res = await request.get("/.well-known/agent-card.json");
  expect(res.status()).toBe(200);
  const card = await res.json();

  expect(card.name).toBe("Kawal");
  expect(card.protocolVersion).toBe("0.3.0");
  expect(card.preferredTransport).toBe("JSONRPC");
  expect(card.url).toBe(`${baseURL}/api/a2a`);
  expect(card.skills.length).toBeGreaterThan(0);

  // The same harmless question Kawal asks everyone else, asked of Kawal at
  // the URL the card names. A card over a silent server would be exactly the
  // claim this project refuses to make about anyone.
  const rpc = await request.post(card.url, {
    headers: { "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: "kawal", method: "tasks/get", params: { id: "kawal-liveness-probe" } },
  });
  expect(rpc.status()).toBe(200);
  const body = await rpc.json();
  expect(body.jsonrpc).toBe("2.0");
  expect(body.error.code).toBe(-32001);
});

test("a message naming a skill gets an answer with evidence in it", async ({ request }) => {
  const res = await request.post("/api/a2a", {
    headers: { "content-type": "application/json" },
    data: {
      jsonrpc: "2.0",
      id: 7,
      method: "message/send",
      params: {
        message: {
          role: "user",
          messageId: "m1",
          contextId: "ctx-1",
          parts: [{ kind: "data", data: { skill: "verify_agent", tokenId: "43129" } }],
        },
      },
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.error).toBeUndefined();

  const message = body.result;
  expect(message.kind).toBe("message");
  expect(message.role).toBe("agent");
  expect(message.contextId).toBe("ctx-1");
  const data = message.parts.find((p: { kind: string }) => p.kind === "data").data;
  expect(data.skill).toBe("verify_agent");
  expect(data.result.agent.tokenId).toBe("43129");
  expect(typeof data.result.probe.answered).toBe("boolean");
});

test("plain text with a token id in it is understood", async ({ request }) => {
  const res = await request.post("/api/a2a", {
    headers: { "content-type": "application/json" },
    data: {
      jsonrpc: "2.0",
      id: 8,
      method: "message/send",
      params: { message: { role: "user", messageId: "m2", parts: [{ kind: "text", text: "is 43129 still up?" }] } },
    },
  });
  const body = await res.json();
  expect(body.error).toBeUndefined();
  const data = body.result.parts.find((p: { kind: string }) => p.kind === "data").data;
  expect(data.skill).toBe("verify_agent");
  expect(data.result.agent.tokenId).toBe("43129");
});

test("the A2A skills and the MCP tools are the same list", async ({ request }) => {
  const card = await (await request.get("/.well-known/agent-card.json")).json();
  const mcp = await request.post("/api/mcp", {
    headers: { "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  const tools = (await mcp.json()).result.tools.map((t: { name: string }) => t.name).sort();
  const skills = card.skills.map((s: { id: string }) => s.id).sort();
  expect(skills).toEqual(tools);
});

test("a browser landing on the A2A endpoint is told what it is", async ({ request }) => {
  const res = await request.get("/api/a2a");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.agentCard).toMatch(/\/\.well-known\/agent-card\.json$/);
  expect(body.example.method).toBe("message/send");
});
