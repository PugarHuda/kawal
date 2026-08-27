import { test, expect } from "@playwright/test";

/**
 * Kawal on a phone.
 *
 * The rubric asks that someone can find an agent and hire it "without hitting
 * a dead end", and a page that scrolls sideways is a dead end for anyone
 * holding the device most people browse on.
 *
 * The rule asserted throughout: wide content may scroll inside its own
 * container, but the document must not. A comparison table with eight rows
 * and four columns is legitimately wide; the body it sits in is not.
 */

const PAGES = [
  ["home", "/"],
  ["listing", "/agents?category=health"],
  ["agent", "/agents/56/43129"],
  ["compare", "/compare?ids=56:43129,56:45381,56:258641"],
  ["mandate", "/mandate"],
] as const;

for (const [label, path] of PAGES) {
  test(`${label} does not scroll sideways on a phone`, async ({ page }) => {
    await page.goto(path);

    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
      // Name whatever is actually sticking out, so a failure says where to
      // look instead of just that something is wrong.
      culprits: [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 40)}`),
    }));

    expect(
      overflow.doc,
      `document is ${overflow.doc}px wide in a ${overflow.view}px viewport; overflowing: ${overflow.culprits.join(", ")}`,
    ).toBeLessThanOrEqual(overflow.view + 1);
  });
}

test("the comparison table scrolls inside its own box", async ({ page }) => {
  await page.goto("/compare?ids=56:43129,56:45381,56:258641");

  // Four columns cannot fit a phone, and squeezing them would make the
  // numbers unreadable. The table is allowed to be wider than the screen so
  // long as it carries its own scroll.
  const box = page.locator("div.overflow-x-auto").first();
  await expect(box).toBeVisible();

  const scrollable = await box.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrollable, "the wide table must scroll within its container").toBe(true);
});

test("the primary journey is reachable with a thumb", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Browse agents" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "Health Factor Monitoring" }).first().click();
  await expect(page.getByText(/registrations retrieved/)).toBeVisible();

  // Every tap target on the way in has to be big enough to hit. 24px is the
  // WCAG 2.2 minimum for a target with no spacing exemption.
  const chips = page.locator("nav a");
  for (let i = 0; i < (await chips.count()); i++) {
    const box = await chips.nth(i).boundingBox();
    expect(box!.height, `chip ${i} is ${box!.height}px tall`).toBeGreaterThanOrEqual(24);
  }
});
