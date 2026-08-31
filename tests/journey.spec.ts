import { test, expect, type Page } from "@playwright/test";
import { settle } from "./settle.ts";

/**
 * The whole journey by keyboard, and the sections that read the registry's
 * own opinions beside Kawal's.
 *
 * The rubric's first criterion is that someone gets from "I have a job" to
 * "this agent, under this cap" without a dead end. The resilience suite
 * proves one link can be reached by Tab; this walks the entire road that
 * way — cover sheet, manifest, two ticks, the comparison, the hire stub, the
 * mandate — because a journey is only keyboard-operable if every step is,
 * and the step that breaks is never the one somebody checked.
 *
 * The other tests here cover the registry-sourced sections added to the
 * forms: trending, the v5 score parts, the wallet ledger. Each one is
 * allowed to be absent — the registry may not have scored an agent, may
 * never have indexed a wallet, may be down — and what is asserted is that
 * absence is silent and presence is complete.
 */

/**
 * Presses Tab until the focused element matches `selector`, or gives up.
 * `back` presses Shift+Tab instead. The bound is generous: the unfiltered
 * manifest is sixty rows, each with a link and a tick box.
 */
async function tabTo(page: Page, selector: string, opts: { back?: boolean; limit?: number } = {}) {
  const limit = opts.limit ?? 160;
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press(opts.back ? "Shift+Tab" : "Tab");
    const hit = await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);
    if (hit) return;
  }
  throw new Error(`nothing matching ${selector} took focus within ${limit} presses`);
}

test("the skip link is the first thing a keyboard reaches, and it lands on the form", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Tab");
  const first = page.locator(":focus");
  await expect(first).toHaveAttribute("href", "#main");
  await expect(first).toHaveText(/skip to the form/i);
  // Off-canvas until it has focus; once it does, it is a counterfoil a
  // sighted keyboard user can see.
  await expect(first).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  // The next Tab must land inside the form, past the header and its tabs:
  // that is what "skip" means.
  await page.keyboard.press("Tab");
  const inMain = await page.evaluate(() => document.activeElement?.closest("#main") !== null);
  expect(inMain, "focus after the skip link did not land inside #main").toBe(true);
});

test("cover sheet to mandate, by Tab, Enter and Space alone", async ({ page }) => {
  await page.goto("/");

  // K-1 → K-2: the primary counterfoil on the sheet, not the header tab
  // that happens to share its destination.
  await tabTo(page, '#main a[href="/agents"]');
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every agent on BSC");

  // The rows arrive once the endpoints have been called; nothing to tick
  // before then.
  const boxes = page.locator('input[name="ids"]');
  await expect(boxes.first()).toBeVisible();
  test.skip((await boxes.count()) < 2, "fewer than two agents on the manifest today");

  // Tick two. Space is the key a tick box takes; Enter would submit the form
  // with one id and land on K-4's empty state, which is its own honest page
  // but not this journey.
  await tabTo(page, 'input[name="ids"]');
  await page.keyboard.press("Space");
  await tabTo(page, 'input[name="ids"]');
  await page.keyboard.press("Space");
  await expect(page.locator('input[name="ids"]:checked')).toHaveCount(2);
  // The counterfoil enables itself by script; wait for hydration to have
  // counted the ticks before going back to it.
  await expect(page.locator('form[action="/compare"] button[type="submit"]').first()).toBeEnabled();

  // Back up to the counterfoil at the head of the manifest.
  await tabTo(page, 'form[action="/compare"] button[type="submit"]:not([disabled])', { back: true, limit: 12 });
  await expect(page.locator(":focus")).toHaveText(/Compare the 2 ticked/);
  await page.keyboard.press("Enter");

  // K-4: two columns, the same questions of each.
  await expect(page).toHaveURL(/\/compare\?ids=56(%3A|:)\d+/);
  await expect(page.locator("thead th")).toHaveCount(3);
  await expect(page.getByRole("rowheader", { name: "Next" })).toBeVisible();
  const firstName = (await page.locator("thead th").nth(1).locator("a").innerText()).trim();

  // The hire stub on the first column, then K-5 with the seat and the agent
  // typed in.
  await tabTo(page, 'a[href^="/mandate?"]');
  await expect(page.locator(":focus")).toHaveText(/Hire under a cap/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/mandate\?(seat=\w+&)?agent=56(%3A|:)\d+$/);

  const filledBy = page.locator("dt", { hasText: "Filled by" }).locator("xpath=following-sibling::dd[1]");
  await expect(filledBy).toBeVisible();
  await expect(filledBy).toContainText(firstName);
});

test("trending on the cover sheet is at most five rows, each stamped, or absent", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /cannot be hired/i })).toBeVisible();

  const section = page.locator('section[aria-label="Moving this week"]');
  // Streamed in after the seats; give it its moment, then read whichever
  // state it settled in.
  await settle(page);
  const present = (await section.count()) > 0;
  if (!present) {
    // The registry did not say what is trending. That leaves no section and
    // no notice — the cover sheet stands on its own entries.
    await expect(page.locator("body")).not.toContainText("Application error");
    return;
  }

  const rows = section.locator("li");
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(5);
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    await expect(row.locator(".stamp")).toHaveCount(1);
    await expect(row.locator(".serial")).toHaveText(String(i + 1).padStart(2, "0"));
    await expect(row.getByText(/trending #\d on 8004scan/)).toBeVisible();
    await expect(row.locator("h3 a")).toHaveAttribute("href", /^\/agents\/\d+\/\d+$/);
  }
  // Attention is named as attention, so nobody reads a view count as a call.
  await expect(section.getByText(/Attention, not evidence/)).toBeVisible();
});

test("the unfiltered manifest carries the same strip above its rows, and no seat page does", async ({ page }) => {
  await page.goto("/agents");
  await settle(page);
  const strip = page.locator('section[aria-label="Moving this week"]');
  if ((await strip.count()) > 0) {
    expect(await strip.locator("li").count()).toBeLessThanOrEqual(5);
    // Rows in the strip are not manifest articles: the article count the
    // catalog suite reads must stay the roster's.
    await expect(strip.locator("article")).toHaveCount(0);
  }

  await page.goto("/agents?category=health");
  await expect(page.getByText(/registrations retrieved/)).toBeVisible();
  await expect(page.locator('section[aria-label="Moving this week"]')).toHaveCount(0);
});

test("a dead registry leaves no trending section and no error", async ({ page }) => {
  // The second server the config starts, aimed at an origin that refuses
  // connections. Its port is the config's OFFLINE_PORT; the registry-down
  // project runs only its own spec, so the outage is reached by address.
  const res = await page.goto("http://127.0.0.1:3211/");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /cannot be hired/i })).toBeVisible();
  await settle(page);
  await expect(page.locator('section[aria-label="Moving this week"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Application error");
  await expect(page.locator("body")).not.toContainText("ECONNREFUSED");
});

test("the v5 score is five weighted parts with a scale under each bar", async ({ page }) => {
  await page.goto("/agents/56/43129");
  const block = page.locator("section").filter({ hasText: "How 8004scan scores it" });
  await expect(block.first()).toBeVisible();

  const v5 = block.filter({ hasText: /total · v5/ });
  test.skip((await v5.count()) === 0, "8004scan has not scored this agent under v5 today");

  // The five parts, in the registry's order, each carrying its weight; the
  // five weights are the registry's and sum to 100.
  const caps = v5.locator("dl dt");
  await expect(caps).toHaveCount(5);
  const labels = ["Engagement", "Service", "Publisher", "Compliance", "Momentum"];
  let weights = 0;
  for (let i = 0; i < 5; i++) {
    // `innerText` carries the caption's uppercase, which is the Surat Jalan
    // house style rather than the label's own spelling.
    const text = await caps.nth(i).innerText();
    expect(text.toLowerCase()).toContain(labels[i]!.toLowerCase());
    const m = text.match(/(\d+) \/ 100 × (\d+)/);
    expect(m, `${text} names a score out of 100 and a weight`).not.toBeNull();
    weights += Number(m![2]);
  }
  expect(weights).toBe(100);
  // A bar with no axis is decoration.
  expect(await v5.getByText("100", { exact: true }).count()).toBe(5);
  await expect(v5.getByText(/scored \d{4}-\d{2}-\d{2}/)).toBeVisible();
});

test("the comparison names the weakest v5 part beside the total", async ({ page }) => {
  await page.goto("/compare?ids=56:43129,56:45381");
  await expect(page.getByRole("rowheader", { name: "Score v5" })).toBeVisible();
  const cells = page.locator("tr:has(th:text-is('Score v5')) td");
  await expect(cells).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    const text = (await cells.nth(i).innerText()).replace(/\s+/g, " ");
    // Either the parts were read and the weakest is named with its weight,
    // or the registry had no breakdown and the cell says so.
    expect(text).toMatch(/^\d+\.\d{2} · (weakest (engagement|service|publisher|compliance|momentum) \d+\/100 × \d+|no v5 breakdown from 8004scan)$/);
  }
});

test("the owner sheet prints the wallet's ledger as the registry's accounting", async ({ page }) => {
  await page.goto("/owner?address=0xda977767452c5dd021624511f14df67b6c9c2c1b");
  await expect(page.getByText(/registrations? on BSC|No registrations under this address/)).toBeVisible();

  await settle(page);
  const strip = page.locator('section[aria-label="The wallet"]');
  test.skip((await strip.count()) === 0, "8004scan has never indexed this wallet");

  await expect(strip.getByText("8004scan’s on-chain accounting")).toBeVisible();
  for (const cap of ["balance", "transactions", "wallet age", "payments received", "revenue", "kind"]) {
    await expect(strip.locator(".cell").filter({ hasText: new RegExp(cap, "i") })).toHaveCount(1);
  }
  // Figures, not placeholders: a count and a number of days.
  await expect(strip.getByText(/^[\d,]+$/).first()).toBeVisible();
  await expect(strip.getByText(/\d+ days/)).toBeVisible();
});

test("an agent wallet's payments are printed beside the wallet, or the row is absent", async ({ page }) => {
  await page.goto("/agents/56/43129");
  const registration = page.locator("section").filter({ hasText: "Registration · the registry" });
  await expect(registration).toBeVisible();
  await settle(page);

  const walletRow = registration.locator(".cell").filter({ has: page.locator("dt", { hasText: /^Agent wallet$/ }) });
  await expect(walletRow).toHaveCount(1);
  const address = (await walletRow.locator("dd").innerText()).trim();

  // The chain is asked which wallet it is whatever the index says, and the
  // answer is a sentence naming the Identity Registry either way.
  const chain = registration.locator(".cell").filter({ hasText: "the chain’s answer" });
  await expect(chain).toHaveCount(1);
  await expect(chain).toContainText(/Identity Registry/);

  const paid = registration.locator(".cell").filter({ hasText: "Payments received" });
  if (address === "not published") {
    // Nothing to look up, nothing invented.
    await expect(paid).toHaveCount(0);
    return;
  }
  if ((await paid.count()) === 0) return; // never indexed by 8004scan
  await expect(paid.getByText(/\d+ payments?/)).toBeVisible();
  await expect(paid.getByText(/on-chain accounting/)).toBeVisible();
  await expect(registration.getByText(/\d+ days · [\d,]+ transactions/)).toBeVisible();
});
