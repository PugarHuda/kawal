import { test, expect } from "@playwright/test";

/**
 * What Kawal looks like when 8004scan is not there.
 *
 * Not hypothetical: the registry returned 502 for every search query for
 * several days during this build, and the whole catalog is downstream of it.
 * Every upstream call happens server-side, so a browser cannot intercept one —
 * intercepting a route the page never requests would have tested nothing. This
 * project runs a second server with `SCAN_API_ORIGIN` pointed at a host that
 * refuses connections, so the failure is the real one.
 *
 * The bar is not "it still works" — without a registry there is nothing to
 * list. The bar is that every page says so and stays navigable, because a
 * marketplace that renders a stack trace during an upstream outage loses the
 * visitor permanently rather than for an hour.
 */

test("the home page survives a dead registry", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);

  // The headline is static copy and must still be there.
  await expect(page.getByRole("heading", { name: /cannot be hired/i })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Application error");
  await expect(page.locator("body")).not.toContainText("ECONNREFUSED");
});

test("the listing explains the outage instead of showing an empty page", async ({ page }) => {
  const res = await page.goto("/agents?category=health");
  expect(res?.status()).toBe(200);

  // Zero rows is correct here. Saying nothing about why is not: a visitor
  // cannot tell "this category is empty" from "the registry is down", and
  // those call for completely different reactions.
  await expect(page.getByText(/did not respond|has to be supplied|No agent on BSC/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Application error");
});

test("navigation still works with nothing to navigate to", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("link", { name: "Mandate" }).click();

  // The mandate planner is pure policy — no registry involved — so an outage
  // upstream must not take it down with it.
  await expect(page.getByRole("heading", { name: /Four seats, four sessions/ })).toBeVisible();
  await expect(page.locator("p.tnum", { hasText: "USDT / day" }).first()).toBeVisible();
});

test("an agent page answers 404 rather than 500 when the registry is gone", async ({ page }) => {
  // With no registry the agent cannot be resolved, and "not found" is the
  // honest answer. A 500 would tell a crawler the URL is broken forever.
  const res = await page.goto("/agents/56/43129");
  expect(res?.status()).toBe(404);
});

test("health reports 503 with the failing dependency named", async ({ request }) => {
  const res = await request.get("/api/health");
  // 503 so an uptime monitor sees the outage without parsing a body. Kawal
  // still serves pages in this state — it is just not serving the thing
  // anyone came for.
  expect(res.status()).toBe(503);

  const body = await res.json();
  expect(body.status).toBe("degraded");

  const registry = body.probes.find((p: { name: string }) => p.name === "registry");
  expect(registry.ok).toBe(false);

  // The parts that do not depend on the registry must still report healthy,
  // so an operator can tell one dependency being down from the whole instance
  // being sick.
  const others = body.probes.filter((p: { name: string }) => p.name !== "registry");
  for (const probe of others) expect(probe.ok, `${probe.name}: ${probe.detail}`).toBe(true);
});

test("the comparison page degrades to its instructions", async ({ page }) => {
  const res = await page.goto("/compare?ids=56:43129,56:45381");
  expect(res?.status()).toBe(200);

  // No columns can be built, so it falls back to the empty state that tells a
  // visitor how to use it — a dead end avoided rather than a blank table.
  await expect(page.getByRole("heading", { name: "Compare agents" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Application error");
});

test("the endpoints that fetch on a caller's behalf have a ceiling", async ({ request }) => {
  // `initialize` needs no registry, so every one of these is a real answer
  // right up until the bucket runs dry.
  const statuses: number[] = [];
  for (let i = 0; i < 70; i++) {
    const res = await request.post("/api/mcp", {
      headers: { "content-type": "application/json" },
      data: { jsonrpc: "2.0", id: i, method: "initialize", params: {} },
    });
    statuses.push(res.status());
    if (res.status() === 429) {
      expect(Number(res.headers()["retry-after"])).toBeGreaterThan(0);
      expect((await res.json()).error).toMatch(/rate limited/);
      break;
    }
  }
  // The burst is served, then refused. Sixty is the capacity; seventy tries
  // must hit the wall, and the first tries must not.
  expect(statuses[0]).toBe(200);
  expect(statuses.at(-1)).toBe(429);
  expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(50);
});
