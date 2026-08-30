import { test, expect } from "@playwright/test";

/**
 * The discovery half of the product: land, filter, understand, open an agent.
 *
 * These run against live 8004scan data on purpose. A suite that mocks the
 * registry would pass forever while the real category pages went empty, and
 * "does this marketplace have anything to sell" is precisely the question
 * worth failing on.
 */

test("home shows live chain figures, not placeholders", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /cannot be hired/i })).toBeVisible();

  // The roster figure is formatted with separators and moves every day, so
  // assert the shape rather than a value.
  const roster = page.locator("p.tnum").first();
  await expect(roster).toHaveText(/^[\d,]{6,}$/);

  await expect(page.getByText(/agents expose MCP, A2A or OASF/i)).toBeVisible();
});

test("every seat on the home page leads to its category", async ({ page }) => {
  await page.goto("/");
  for (const [label, slug] of [
    ["Rebalancing", "rebalancing"],
    ["Grid Trading", "grid"],
    ["Yield Optimisation", "yield"],
    ["Health Factor Monitoring", "health"],
  ] as const) {
    await expect(page.locator(`a[href="/agents?category=${slug}"]`).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
  }
});

/**
 * The rubric weights all four categories equally, and the failure mode is
 * silent: a category that retrieves nothing hireable still renders a page
 * full of rows. This asserts the thing that actually matters.
 */
for (const category of ["rebalancing", "grid", "yield", "health"] as const) {
  test(`${category} lists at least one agent that can actually be hired`, async ({ page }) => {
    await page.goto(`/agents?category=${category}`);

    const rows = page.locator("article");
    await expect(rows.first()).toBeVisible();

    const hireable = page.getByText("Hireable", { exact: true });
    expect(await hireable.count()).toBeGreaterThan(0);

    await expect(page.getByText(/registrations retrieved/)).toBeVisible();
  });
}

test("collapsed padding: no minted series repeats in one listing", async ({ page }) => {
  await page.goto("/agents?category=yield");

  const names = await page.locator("article h3").allInnerTexts();
  expect(names.length).toBeGreaterThan(0);

  // "BORT Yield Weaver #10877" and "#10997" are one series. Stripping the
  // edition number is exactly what collapseDuplicates does, so after it runs
  // no two rows may share a stripped name.
  const stripped = names.map((n) => n.toLowerCase().replace(/[#\d]+/g, "").replace(/\s+/g, " ").trim());
  expect(new Set(stripped).size).toBe(stripped.length);
});

test("agent detail proves the endpoint itself, live", async ({ page }) => {
  // Venus powered by HeyAnon — a registration whose MCP endpoint is a real
  // server, so the probe has something true to report.
  await page.goto("/agents/56/43129");

  await expect(page).toHaveTitle(/Venus powered by HeyAnon/);
  await expect(page.getByRole("heading", { name: "We just called it" })).toBeVisible();
  await expect(page.getByText("Answers MCP")).toBeVisible();
  await expect(page.getByText(/never from the registry/)).toBeVisible();

  // Latency has to be a real measurement, not a constant.
  await expect(page.locator("text=/^\\d+ ms$/").first()).toBeVisible();
});

test("search finds agents by term", async ({ page }) => {
  await page.goto("/agents?q=venus");

  // Level 1 specifically: agent names in the results are headings too, and a
  // loose match here resolved to three of them.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/venus/i);
  await expect(page.getByText(/match this term chain-wide/)).toBeVisible();
  expect(await page.locator("article").count()).toBeGreaterThan(0);
});

test("a term that matches nothing does not invent a hireable agent", async ({ page }) => {
  // This asserted zero rows while the search box did substring matching on
  // names. It now goes through the hybrid vector endpoint, which always
  // returns its nearest neighbours — "zzzznotarealagentzzzz" reaches `zzj
  // agent` on a trigram, and the registry really does contain one. The
  // similarity_threshold parameter is documented and ignored by the server,
  // so this cannot be tightened upstream.
  //
  // What actually matters was never the row count: it is that a weak match is
  // not dressed up as a strong one. A loose hit may be listed; it must not
  // arrive carrying the badge that means Kawal called it and it answered.
  await page.goto("/agents?q=zzzznotarealagentzzzz");
  await expect(page.locator("body")).not.toContainText("Application error");
  // Scoped to the rows. The legend at the foot of every form names the same
  // stamp in order to explain it, and counting that as a badge on a listing
  // would fail this for the one reason it is not about.
  await expect(page.locator("article").getByText("Hireable")).toHaveCount(0);
  await expect(page.locator('section[aria-label="Legend"]').getByText("Hireable")).toHaveCount(1);
});

test("a problem described in plain words finds an agent that does it", async ({ page }) => {
  // The reason the search box was moved onto the vector endpoint. Someone with
  // no Agent Studio experience describes a problem, not a product name, and
  // none of these results shares a word with the query.
  await page.goto("/agents?q=watch+my+lending+position+for+liquidation");
  await expect(page.locator("body")).not.toContainText("Application error");
  expect(await page.locator("article").count()).toBeGreaterThan(0);
});

test("an agent that does not exist answers 404, not a 200 with a 404 page", async ({ page }) => {
  // Regression guard. A route-level loading.tsx used to flush the response
  // shell before notFound() ran, so this served the right page under the
  // wrong status — correct for a human, a lie to every crawler and uptime
  // check reading it.
  const res = await page.goto("/agents/56/999999999");
  expect(res?.status()).toBe(404);
});

test("a nonsense chain id answers 404", async ({ page }) => {
  const res = await page.goto("/agents/999/1");
  expect(res?.status()).toBe(404);
});
