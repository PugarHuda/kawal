import type { Page } from "@playwright/test";

/**
 * Wait for the network to go quiet, but never fail because it didn't.
 *
 * Every page here renders from live third-party endpoints, so under the full
 * suite's parallel fan-out `networkidle` can stay out of reach for the whole
 * 90 s budget. When that happened the test failed at the wait, reporting a
 * timeout on line 68 instead of anything about what it actually asserts — and
 * the CSP test does not care when the last request lands, only that no request
 * was refused.
 *
 * So the wait gets its own short budget and then gives up quietly. Whatever
 * the test asserts next is still asserted, and Playwright's expects retry, so
 * content that arrives late is still caught. A page that genuinely never
 * loads now fails on the missing content, which says where to look.
 */
export async function settle(page: Page, ms = 15_000) {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}
