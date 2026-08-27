import { test, expect } from "@playwright/test";

/**
 * The panel that stops Kawal repeating the registry's word about reputation.
 *
 * These run against live records, which move. So nothing here asserts a
 * number: it asserts that the panel's own figures agree with the sentence
 * printed above them. A page that says "one address wrote most of this" while
 * reporting eight distinct writers is the failure worth catching, and that
 * check survives the underlying data changing.
 *
 * Two agents, deliberately, because the two states are rendered by different
 * branches and only one of them is the flattering one:
 *   56:31041 — dozens of records across several addresses
 *   56:30849 — a handful, all from one
 */

const SPREAD = "/agents/56/31041";
const CAPTURED = "/agents/56/30849";

/** Reads the labelled figures out of the panel's definition list. */
async function panel(page: import("@playwright/test").Page) {
  const section = page.locator("section").filter({ hasText: "We read the feedback" });
  await expect(section).toBeVisible();

  const read = async (label: string) => {
    const row = section.locator("div").filter({ hasText: new RegExp(`^${label}`, "i") }).first();
    return ((await row.textContent()) ?? "").replace(/\s+/g, " ").trim();
  };

  return {
    section,
    headline: ((await section.locator("p span").first().textContent()) ?? "").trim(),
    writers: await read("Distinct writers"),
    marks: await read("Carrying a mark"),
  };
}

test("feedback spread across addresses is not called a single source", async ({ page }) => {
  await page.goto(SPREAD);
  const p = await panel(page);

  const writers = Number(p.writers.replace(/\D+/g, ""));
  expect(writers, `could not read a writer count from "${p.writers}"`).toBeGreaterThan(0);

  // The branch under test: several writers must not render the captured
  // wording, and one writer must not render the reassuring wording.
  if (writers > 1) {
    expect(p.headline).not.toMatch(/almost one source/i);
  } else {
    expect(p.headline).toMatch(/almost one source/i);
  }
});

test("feedback from a single address says so plainly", async ({ page }) => {
  await page.goto(CAPTURED);
  const p = await panel(page);

  const writers = Number(p.writers.replace(/\D+/g, ""));
  if (writers === 1) {
    await expect(p.section).toContainText(/almost one source/i);
    // And the reader is given the address rather than a verdict about it.
    await expect(p.section.locator('a[href*="bscscan.com/address/"]')).toBeVisible();
  }
});

test("the registry's own score field is reported beside the marks", async ({ page }) => {
  await page.goto(SPREAD);
  const section = page.locator("section").filter({ hasText: "We read the feedback" });

  // The two are different fields and the gap between them is the finding: a
  // mark the writer set, versus the normalised score an average is taken over.
  // Collapsing them back into one row would lose it.
  await expect(section.getByText("Carrying a mark")).toBeVisible();
  await expect(section.getByText(/score field/i)).toBeVisible();
});

test("the track-record signal follows the records, not the count", async ({ page }) => {
  await page.goto(CAPTURED);

  const signal = page.locator("div").filter({ hasText: /^Has a track record/ }).first();
  await expect(signal).toBeVisible();

  // Whatever it decides, it must show its working — a bare count is exactly
  // what this replaced.
  await expect(signal).toContainText(/marked|address|no mark|not read/i);
});
