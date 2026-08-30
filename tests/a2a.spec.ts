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
 * request Kawal sends every other agent is sent to Kawal. Every skill is
 * sent through `message/send`, and `message/stream` is read as the SSE the
 * card promises.
 *
 * Live agents move, so the reading tests assert the page's own consistency —
 * an A2A headline beside A2A evidence — rather than any particular number.
 */

/** BORT: a spec-shaped card at /.well-known/agent-card.json. */
const CARD_AGENT = "/agents/56/153672";
/** Brain on BNB: the declared endpoint is the JSON-RPC URL itself. */
const BARE_AGENT = "/agents/56/304494";

const A2A = "/api/a2a";
type Ctx = import("@playwright/test").APIRequestContext;

/** The same minimal calls the MCP suite makes, in the data-part form. */
const MIN_ARGS: Record<string, Record<string, unknown>> = {
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

function envelope(method: string, params: unknown, id: unknown = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

function withSkill(skill: string, args: Record<string, unknown>, contextId?: string) {
  return { message: { role: "user", messageId: `m-${skill}`, ...(contextId ? { contextId } : {}), parts: [{ kind: "data", data: { skill, ...args } }] } };
}

async function post(request: Ctx, body: unknown) {
  return request.post(A2A, { headers: { "content-type": "application/json" }, data: body });
}

/** Splits an SSE body into the JSON each `data:` line carried. */
function events(sse: string): Array<Record<string, unknown>> {
  return sse
    .split(/\n\n/)
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

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
  // The card promises streaming and names the second door.
  expect(card.capabilities.streaming).toBe(true);
  expect(card.supportsAuthenticatedExtendedCard).toBe(false);
  expect(card.additionalInterfaces).toContainEqual({ url: `${baseURL}/api/mcp`, transport: "MCP" });
  expect(card.additionalInterfaces).toContainEqual({ url: `${baseURL}/api/a2a`, transport: "JSONRPC" });

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

  // The card says there is no authenticated one; the method agrees.
  const extended = await (await post(request, envelope("agent/getAuthenticatedExtendedCard", {}))).json();
  expect(extended.error.code).toBe(-32007);
});

/**
 * RFC 8785 JCS, written a second time here on purpose: the card's signature
 * is only worth something if a reader who never saw Kawal's code can
 * reproduce the bytes it signed. Keys in UTF-16 code-unit order, numbers
 * and strings as JSON.stringify has them.
 */
function jcs(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
}

/**
 * Kawal signs its card with the admin account. The signature is checked
 * here with node:crypto alone — the JWK out of the protected header, the
 * payload rebuilt with the JCS above — so the check shares nothing with the
 * code that signed. An instance without the admin key serves the card
 * unsigned, and says so by the field's absence.
 */
test("Kawal's card is signed ES256K, and the signature verifies with the JWK it carries", async ({ request }) => {
  const card = await (await request.get("/.well-known/agent-card.json")).json();
  test.skip(!Array.isArray(card.signatures), "this instance holds no admin key, so its card is unsigned");

  expect(card.signatures).toHaveLength(1);
  const { protected: prot, signature } = card.signatures[0];
  const header = JSON.parse(Buffer.from(prot, "base64url").toString("utf8"));
  expect(header.alg).toBe("ES256K");
  expect(header.jwk).toMatchObject({ kty: "EC", crv: "secp256k1" });
  expect(Buffer.from(header.jwk.x, "base64url")).toHaveLength(32);
  expect(Buffer.from(header.jwk.y, "base64url")).toHaveLength(32);
  const sig = Buffer.from(signature, "base64url");
  expect(sig).toHaveLength(64);

  const unsigned = { ...card };
  delete unsigned.signatures;
  const input = Buffer.from(`${prot}.${Buffer.from(jcs(unsigned), "utf8").toString("base64url")}`, "ascii");
  const { createPublicKey, verify } = await import("node:crypto");
  const key = createPublicKey({ key: header.jwk, format: "jwk" });
  expect(verify("sha256", input, { key, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);

  // One byte of the card changed and the same signature no longer holds.
  const tampered = Buffer.from(`${prot}.${Buffer.from(jcs({ ...unsigned, name: "Not Kawal" }), "utf8").toString("base64url")}`, "ascii");
  expect(verify("sha256", tampered, { key, dsaEncoding: "ieee-p1363" }, sig)).toBe(false);

  // Signed or not, it is still the same card Kawal's own reader accepts.
  expect(card.name).toBe("Kawal");
  expect(unsigned.skills.length).toBeGreaterThan(0);
});

test("a message naming a skill gets an answer with evidence in it", async ({ request }) => {
  const res = await post(request, envelope("message/send", withSkill("verify_agent", { tokenId: "43129" }, "ctx-1"), 7));
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

for (const [skill, args] of Object.entries(MIN_ARGS)) {
  test(`${skill} answers over message/send`, async ({ request }) => {
    const res = await post(request, envelope("message/send", withSkill(skill, args)));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    expect(body.result.kind).toBe("message");
    const data = body.result.parts.find((p: { kind: string }) => p.kind === "data").data;
    expect(data.skill).toBe(skill);
    expect(typeof data.result).toBe("object");
    // The text part carries the same answer for a client that reads prose.
    expect(JSON.parse(body.result.parts.find((p: { kind: string }) => p.kind === "text").text)).toEqual(data.result);
  });
}

test("every skill in the card has a minimal call in this suite", async ({ request }) => {
  const card = await (await request.get("/.well-known/agent-card.json")).json();
  for (const s of card.skills as Array<{ id: string; examples: string[] }>) {
    expect(MIN_ARGS, s.id).toHaveProperty(s.id);
    // The worked example on the card must itself be a valid data part.
    expect(JSON.parse(s.examples[0]!).skill).toBe(s.id);
  }
});

test("message/stream narrates the task as events and ends on a final state", async ({ request }) => {
  const res = await post(request, envelope("message/stream", withSkill("plan_mandate", { capitalUsdt: 250, days: 7 }, "ctx-stream"), "s1"));
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^text\/event-stream/);

  const seen = events(await res.text());
  expect(seen.length).toBeGreaterThanOrEqual(4);
  for (const e of seen) {
    expect(e.jsonrpc).toBe("2.0");
    expect(e.id).toBe("s1");
    expect(e.error).toBeUndefined();
  }
  const results = seen.map((e) => e.result as Record<string, unknown>);
  const [first, , third] = results;
  expect(first!.kind).toBe("task");
  expect((first!.status as { state: string }).state).toBe("submitted");
  expect(first!.contextId).toBe("ctx-stream");

  const taskId = first!.id;
  const kinds = results.map((r) => r.kind);
  expect(kinds).toEqual(["task", "status-update", "artifact-update", "status-update"]);
  for (const r of results.slice(1)) expect(r.taskId).toBe(taskId);

  const artifact = third!.artifact as { artifactId: string; name: string; parts: Array<{ kind: string; data?: { skill: string; result: { seats: unknown[] } } }> };
  expect(artifact.name).toBe("plan_mandate");
  expect(third!.lastChunk).toBe(true);
  expect(artifact.parts.find((p) => p.kind === "data")!.data!.result.seats.length).toBe(4);

  const last = results[results.length - 1]!;
  expect((last.status as { state: string }).state).toBe("completed");
  expect(last.final).toBe(true);
  // Every event before the last says it is not the last.
  for (const r of results.slice(1, -1)) if (r.kind === "status-update") expect(r.final).toBe(false);

  // The task was narrated, not kept: asking for it afterwards is TaskNotFound.
  const after = await (await post(request, envelope("tasks/get", { id: taskId }))).json();
  expect(after.error.code).toBe(-32001);
});

test("a skill that fails mid-stream ends the task as failed, with the reason", async ({ request }) => {
  const res = await post(request, envelope("message/stream", withSkill("verify_agent", { tokenId: "../etc" }), "s2"));
  const results = events(await res.text()).map((e) => e.result as Record<string, unknown>);
  const last = results[results.length - 1]!;
  expect(last.kind).toBe("status-update");
  expect(last.final).toBe(true);
  const status = last.status as { state: string; message: { parts: Array<{ text: string }> } };
  expect(status.state).toBe("failed");
  expect(status.message.parts[0]!.text).toMatch(/decimal token id/);
});

test("a stream that cannot resolve a skill is one error event, not a task", async ({ request }) => {
  const res = await post(request, envelope("message/stream", { message: { role: "user", messageId: "m", parts: [{ kind: "data", data: { skill: "drop_tables" } }] } }, "s3"));
  const seen = events(await res.text());
  expect(seen.length).toBe(1);
  expect((seen[0]!.error as { code: number }).code).toBe(-32602);
});

test("plain text with a token id in it is understood", async ({ request }) => {
  const res = await post(request, envelope("message/send", { message: { role: "user", messageId: "m2", parts: [{ kind: "text", text: "is 43129 still up?" }] } }, 8));
  const body = await res.json();
  expect(body.error).toBeUndefined();
  const data = body.result.parts.find((p: { kind: string }) => p.kind === "data").data;
  expect(data.skill).toBe("verify_agent");
  expect(data.result.agent.tokenId).toBe("43129");
});

test("the caller's mistakes are named with the code the specification gives them", async ({ request }) => {
  const unknownMethod = await (await post(request, envelope("nonsense/method", {}))).json();
  expect(unknownMethod.error.code).toBe(-32601);

  const noMethod = await post(request, { jsonrpc: "2.0", id: 1 });
  expect(noMethod.status()).toBe(400);
  expect((await noMethod.json()).error.code).toBe(-32600);

  const notJson = await request.post(A2A, { headers: { "content-type": "application/json" }, data: "{ not json" });
  expect(notJson.status()).toBe(400);
  expect((await notJson.json()).error.code).toBe(-32700);

  const noParts = await (await post(request, envelope("message/send", { message: { role: "user" } }))).json();
  expect(noParts.error.code).toBe(-32602);

  const unknownSkill = await (await post(request, envelope("message/send", withSkill("drop_tables", {})))).json();
  expect(unknownSkill.error.code).toBe(-32602);
  expect(unknownSkill.error.message).toMatch(/drop_tables/);

  const badArgument = await (await post(request, envelope("message/send", withSkill("verify_agent", { tokenId: "../etc" })))).json();
  expect(badArgument.error.code).toBe(-32602);

  // A notification gets nothing back, not even "null".
  const note = await post(request, { jsonrpc: "2.0", method: "message/send", params: {} });
  expect(note.status()).toBe(202);
  expect(await note.text()).toBe("");
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
  const res = await request.get(A2A);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.agentCard).toMatch(/\/\.well-known\/agent-card\.json$/);
  expect(body.example.method).toBe("message/send");
  expect(res.headers()["access-control-allow-origin"]).toBe("*");
});
