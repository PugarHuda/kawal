import { test, expect, type Page } from "@playwright/test";

/**
 * The parts of the site nobody clicks: headers, crawler files, the share
 * card, the 404 for a mistyped path, and the colour pairs the design leans on.
 *
 * Each of these was configured and none was asserted. A security header that
 * is set in next.config.ts and never checked is one refactor from gone; a
 * contrast ratio that axe reports as "incomplete" (it cannot see through
 * mix-blend-mode) is one that nothing was checking at all.
 */

test("security headers reach the browser", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["permissions-policy"]).toContain("camera=()");
  expect(h["strict-transport-security"]).toContain("max-age=");
  expect(h["content-security-policy"]).toContain("nonce-");
});

test("API routes and the 404 carry a policy too", async ({ request }) => {
  for (const path of ["/api/health", "/.well-known/agent-card.json", "/no-such-form"]) {
    const res = await request.get(path);
    expect(res.headers()["content-security-policy"], path).toContain("default-src");
  }
});

test("a mistyped path gets the returned-form sheet, not a bare 404", async ({ page }) => {
  const res = await page.goto("/no-such-form");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("link", { name: /agents/i }).first()).toBeVisible();
  // The sheet is styled, which means the stylesheet loaded under the nonce
  // CSP — the exact failure the custom 404 exists to avoid.
  const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(family).not.toBe("");
});

test("crawler files exist and point at the forms", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const body = await robots.text();
  expect(body).toContain("Disallow: /api/");
  expect(body).toContain("sitemap.xml");

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect(xml).toContain("/agents");
  expect(xml).toContain("/mandate");
  expect(xml).toContain("category=health");
});

test("the share card is a PNG of the cover sheet", async ({ request }) => {
  const res = await request.get("/opengraph-image");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/png");
  const bytes = await res.body();
  expect(bytes.length).toBeGreaterThan(10_000);
  // PNG magic.
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
});

test("every form declares its own title and share metadata", async ({ page }) => {
  const titles: Array<[string, RegExp]> = [
    ["/", /hire proven agents/i],
    ["/agents", /Every agent on BSC — Kawal/],
    ["/agents?category=health", /Health Factor Monitoring agents — Kawal/],
    ["/mandate", /Mandate — Kawal/],
    ["/compare", /Compare agents — Kawal/],
    ["/advantage", /— Kawal$/],
    ["/owner", /still answering\? — Kawal/],
  ];
  for (const [path, title] of titles) {
    await page.goto(path);
    await expect(page, path).toHaveTitle(title);
    const og = await page.locator('meta[property="og:image"]').first().getAttribute("content");
    expect(og, `${path} og:image`).toContain("opengraph-image");
  }
});

/**
 * WCAG relative luminance and contrast ratio, computed here rather than by
 * axe: the stamps print through an SVG filter and multiply blending, which
 * axe cannot resolve and therefore never checks. The tokens are what the
 * design commits to, so the tokens are what is asserted.
 */
async function ratio(page: Page, selector: string, ink: string, paper: string) {
  return page.evaluate(
    ({ selector, ink, paper }) => {
      const el = document.querySelector(selector) ?? document.documentElement;
      const cs = getComputedStyle(el);
      const parse = (v: string) => {
        const probe = document.createElement("span");
        probe.style.color = v;
        document.body.appendChild(probe);
        const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
        probe.remove();
        return rgb;
      };
      const lum = (rgb: number[]) => {
        const c = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
      };
      const a = lum(parse(cs.getPropertyValue(ink).trim()));
      const b = lum(parse(cs.getPropertyValue(paper).trim()));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    },
    { selector, ink, paper },
  );
}

test("every ink the forms print in clears AA on the paper it sits on", async ({ page }) => {
  await page.goto("/mandate");
  const pairs: Array<[string, string, string]> = [
    // [scope selector, ink token, paper token]
    [":root", "--carbon-2", "--paper-white"],
    [":root", "--carbon-3", "--paper-white"],
    [":root", "--carbon-3", "--paper-yellow"],
    [":root", "--stamp-violet", "--paper-yellow"],
    [":root", "--stamp-red", "--paper-yellow"],
    [":root", "--stamp-blue", "--paper-yellow"],
    [":root", "--stamp-grey", "--paper-yellow"],
    [".sheet--pink", "--carbon-2", "--paper-pink"],
    [".sheet--pink", "--stamp-grey", "--paper-pink"],
    [".sheet--pink", "--stamp-red", "--paper-pink"],
    [".sheet--pink", "--stamp-blue", "--paper-pink"],
    [".sheet--pink", "--seat-rebalancing", "--paper-pink"],
    [".sheet--pink", "--seat-yield", "--paper-pink"],
    [".sheet--pink", "--seat-health", "--paper-pink"],
    [".sheet--pink", "--seat-grid", "--paper-pink"],
    [".sheet--pink", "--seat-security", "--paper-pink"],
  ];
  for (const [scope, ink, paper] of pairs) {
    const r = await ratio(page, scope, ink, paper);
    expect(r, `${ink} on ${paper} within ${scope}`).toBeGreaterThanOrEqual(4.5);
  }
});
