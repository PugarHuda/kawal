import { test, expect } from "@playwright/test";

/**
 * The evidence page has one job a marketplace page normally does not: report a
 * result against itself. Two of the three tasks went to the manual path, and
 * the value of publishing that survives only as long as nobody quietly turns
 * it into a win. These tests hold the page to its own numbers.
 */

test("the headline counts wins from the data, not from a sentence", async ({ page }) => {
  await page.goto("/advantage");

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();

  // Whatever today's run said, the headline must be a count out of the tasks
  // actually rendered — not a number written into the markup.
  const text = (await heading.textContent()) ?? "";
  const match = text.match(/Hiring won (\d+) of these (\d+) tasks/);
  expect(match, `headline did not read as a count: ${text}`).not.toBeNull();

  const [, wins, total] = match!;
  const marked = await page.getByText("won", { exact: true }).count();
  expect(Number(total)).toBe(await page.locator("table").count());
  expect(Number(wins)).toBeLessThanOrEqual(Number(total));
  // Every task marks exactly one winner, so the markers and the tasks agree.
  expect(marked).toBe(Number(total));
});

test("a losing task states the loss rather than softening it", async ({ page }) => {
  await page.goto("/advantage");

  // The verdicts are computed from timings, so the wording is fixed even
  // though the ratios move between runs.
  await expect(page.getByText(/Doing it yourself was [\d.]+x faster/).first()).toBeVisible();
  await expect(
    page.getByText("Kawal sells access to agents, so the number above is the inconvenient one.", {
      exact: false,
    }),
  ).toBeVisible();
});

test("every path row carries a measurement, not a claim", async ({ page }) => {
  await page.goto("/advantage");

  const firstTable = page.locator("table").first();
  await expect(firstTable.getByText("Hired")).toBeVisible();
  await expect(firstTable.getByText("By hand")).toBeVisible();
  // Medians are rendered with their spread so a single sample cannot pose as
  // a measurement.
  await expect(firstTable.getByText(/^\d+-\d+$/).first()).toBeVisible();
});

test("the evidence is reachable from the front page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Read the evidence" }).click();
  await expect(page).toHaveURL(/\/advantage$/);
});
