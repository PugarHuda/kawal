import { test, expect } from "@playwright/test";

/**
 * The custody half: the planner, its input limits, and the lock on the one
 * action that destroys something.
 *
 * Nothing here revokes a real session. The live seats on this wallet are
 * mainnet KeyStore registrations and revocation is monotonic — a test that
 * spent one to prove a point could never be run twice.
 */

const TOKEN = "playwright-operator-token";

test("planner splits capital across four seats", async ({ page }) => {
  await page.goto("/mandate?capital=50000&days=14");

  await expect(page.getByRole("heading", { name: /Four seats, four sessions/ })).toBeVisible();

  // 35 / 30 / 20 / 15 of 50,000. The figure shares its paragraph with the
  // unit span, so match the whole line rather than the bare number.
  for (const amount of ["17,500", "15,000", "10,000", "7,500"]) {
    await expect(
      page.locator("p.tnum", { hasText: `${amount} USDT / day` }).first(),
    ).toBeVisible();
  }

  await expect(page.getByText(/Risk officer/).first()).toBeVisible();
  await expect(page.getByText(/priority 100/)).toBeVisible();
});

test("preemption narrows the allocator without touching its allowlist", async ({ page }) => {
  await page.goto("/mandate?capital=10000&days=30");
  await expect(page.getByRole("heading", { name: "Preemption" })).toBeVisible();
  await expect(page.getByText(/allowlist is untouched/)).toBeVisible();
});

/**
 * A `max` attribute is a hint to a browser, not a constraint on a URL. Each
 * of these used to reach code that assumed a sane number; the duration one
 * reached `new Date().toISOString()` and threw a bare RangeError that the
 * page then reported as an ordinary policy refusal.
 */
test("absurd capital is clamped rather than crashing", async ({ page }) => {
  const res = await page.goto("/mandate?capital=1e308&days=30");
  expect(res?.status()).toBe(200);
  await expect(page.getByText("1,000,000,000,000").first()).toBeVisible();
  await expect(page.getByText("Unexpected failure")).toHaveCount(0);
});

test("absurd duration is clamped rather than crashing", async ({ page }) => {
  const res = await page.goto("/mandate?days=99999999");
  expect(res?.status()).toBe(200);
  await expect(page.getByText("Unexpected failure")).toHaveCount(0);
  await expect(page.locator("input[name='days']")).toHaveValue("365");
});

test("garbage parameters fall back to defaults", async ({ page }) => {
  await page.goto("/mandate?capital=-5&days=abc");
  await expect(page.locator("input[name='capital']")).toHaveValue("10000");
  await expect(page.locator("input[name='days']")).toHaveValue("30");
});

/**
 * Bagian C reads the AgenticCommerce kernel by job id. The numbers move
 * with the market, so the assertions are about shape and honesty: every
 * cell holds a number, the newest job carries a status the kernel defines,
 * and the panel for this wallet's jobs says "none" with the next id rather
 * than showing a job that does not exist.
 */
test("the ERC-8183 market is read off the kernel, and the empty job panel is honest", async ({ page }) => {
  await page.goto("/mandate");
  const market = page.locator("section").filter({ hasText: "ERC-8183 market" });
  await expect(market).toBeVisible();
  await expect(market.getByText(/next job id \d+ · read \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)).toBeVisible();

  for (const cap of ["Jobs in window", "Funded", "Completed", "$U budgeted", "Providers"]) {
    const cell = market.locator(".cell", { hasText: cap });
    await expect(cell).toBeVisible();
    expect((await cell.locator("dd").textContent())?.trim()).toMatch(/^[\d,]+(\.\d+)?$/);
  }

  // The newest job: an id, a kernel status, a truncated provider, a budget.
  const newest = market.locator("ol li").first();
  await expect(newest.locator(".serial")).toHaveText(/^#\d+$/);
  await expect(newest.getByText(/^(OPEN|FUNDED|SUBMITTED|COMPLETED|REJECTED|EXPIRED)$/)).toBeVisible();
  await expect(newest.getByText(/provider 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/)).toBeVisible();
  await expect(market.getByRole("link", { name: /kernel 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4} on bscscan/ })).toHaveAttribute(
    "href",
    /bscscan\.com\/address\/0xEa4DAa3100A767e86FDed867729ae7446476EBA6/i,
  );

  // This wallet has funded no job. The panel says so, with the next id,
  // and prints no job row of its own.
  const panel = market.locator("div", { hasText: "jobs this wallet funded" }).last();
  const text = (await panel.textContent()) ?? "";
  if (/No mandate wallet on this instance/.test(text)) return;
  expect(text).toMatch(/None\. Wallet 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4} is the client on none of the newest \d+ jobs/);
  expect(text).toMatch(/next job the kernel will number is #\d+/);
});

/**
 * Every seat that may call a lending venue prints what that venue pays and
 * charges today, with the block it was read at. A percentage with no
 * read-at line would be a number with no provenance.
 */
test("lending seats print today's venue rates with the block they were read at", async ({ page }) => {
  await page.goto("/mandate?capital=10000&days=30");
  // Scoped to the seats: the legend at the foot of the form carries the same
  // caption as its key entry, and counting that as a seat would make this
  // pass for the wrong reason.
  const lines = page.locator(".manifest-row dt", { hasText: "Today’s rates" });
  // Risk officer and Allocator both lend; the market maker and trader do not.
  await expect(lines).toHaveCount(2);
  await expect(page.locator('section[aria-label="Legend"] dt', { hasText: "Today’s rates" })).toHaveCount(1);

  const allocator = page.locator(".manifest-row", { hasText: "Allocator" });
  await expect(allocator.getByText(/Venus vUSDT: supply \d+\.\d{2}% · borrow \d+\.\d{2}% APR/)).toBeVisible();
  await expect(allocator.getByText(/Aave V3 USDT: supply \d+\.\d{2}% · borrow \d+\.\d{2}% APR/)).toBeVisible();
  await expect(
    allocator.getByText(/read at block [\d,]+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · [\d,]+ blocks\/day/),
  ).toBeVisible();

  const trader = page.locator(".manifest-row", { hasText: "Execution trader" });
  await expect(trader.getByText("Today’s rates")).toHaveCount(0);
});

/**
 * The hire stub is drawn on every seat and is pressable on none of them
 * here: no agent is named for the seat on a bare /mandate, and the wallet
 * holds no $U. The reason is printed, and it is one of the real ones.
 */
test("every seat carries a hire stub that says exactly why it cannot be pressed", async ({ page }) => {
  await page.goto("/mandate?capital=10000&days=30");
  await expect(page.getByRole("button", { name: "Hire on ERC-8183" })).toHaveCount(0);
  const stubs = page.locator('[aria-disabled="true"]', { hasText: "Hire on ERC-8183" });
  await expect(stubs).toHaveCount(4);
  await expect(page.getByText(/budget this plan implies/).first()).toBeVisible();
  const reason = page.getByText(/^Not available: /).first();
  await expect(reason).toBeVisible();
  expect(await reason.textContent()).toMatch(
    /no mandate wallet on this instance|\$U could not be read|no agent is named for this seat|short [\d.]+ \$U until funded/,
  );
});

test("the control room shows what the wallet holds beside the caps", async ({ page }) => {
  await page.goto("/mandate");
  const granted = page.getByRole("heading", { name: "Granted on-chain" });
  test.skip((await granted.count()) === 0, "no on-chain sessions on this machine");

  await expect(page.getByText(/wallet holds/)).toBeVisible();
  await expect(page.getByText(/caps below total/)).toBeVisible();
});

test("revoking is locked until the operator proves who they are", async ({ page }) => {
  await page.goto("/mandate");
  const granted = page.getByRole("heading", { name: "Granted on-chain" });
  test.skip((await granted.count()) === 0, "no on-chain sessions on this machine");

  await expect(page.getByRole("button", { name: "Revoke this seat" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unlock to revoke" })).toBeVisible();
});

test("a wrong operator token does not unlock anything", async ({ page }) => {
  await page.goto("/mandate");
  const granted = page.getByRole("heading", { name: "Granted on-chain" });
  test.skip((await granted.count()) === 0, "no on-chain sessions on this machine");

  await page.getByLabel("Operator token").fill("not-the-token");
  await page.getByRole("button", { name: "Unlock to revoke" }).click();

  await expect(page.getByRole("button", { name: "Revoke this seat" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unlock to revoke" })).toBeVisible();
});

test("the right token unlocks revoking, and locking hides it again", async ({ page }) => {
  await page.goto("/mandate");
  const granted = page.getByRole("heading", { name: "Granted on-chain" });
  test.skip((await granted.count()) === 0, "no on-chain sessions on this machine");

  await page.getByLabel("Operator token").fill(TOKEN);
  await page.getByRole("button", { name: "Unlock to revoke" }).click();

  await expect(page.getByText("Unlocked as operator")).toBeVisible();
  expect(await page.getByRole("button", { name: "Revoke this seat" }).count()).toBeGreaterThan(0);

  // The cookie must be out of reach of any script on the page.
  expect(await page.evaluate(() => document.cookie)).not.toContain("kawal_operator");

  await page.getByRole("button", { name: "lock again" }).click();
  await expect(page.getByRole("button", { name: "Revoke this seat" })).toHaveCount(0);
});

/**
 * The attack the UI gate does not stop: a scripted POST straight at the
 * server action. Next refuses one with no Origin header, but any non-browser
 * client sets Origin freely, so the check inside the action is what actually
 * holds.
 *
 * Uses a public key that is not in the ledger, so an authorised call finds
 * nothing to revoke and a leak would still destroy nothing.
 */
test("the revoke action refuses an unauthorised POST", async ({ page, request, baseURL }) => {
  await page.goto("/mandate");
  const granted = page.getByRole("heading", { name: "Granted on-chain" });
  test.skip((await granted.count()) === 0, "no on-chain sessions on this machine");

  await page.getByLabel("Operator token").fill(TOKEN);
  await page.getByRole("button", { name: "Unlock to revoke" }).click();
  await expect(page.getByText("Unlocked as operator")).toBeVisible();

  const actionId = await page.evaluate(async () => {
    // The action id only travels in the request React makes, so provoke one
    // and read it back off the wire.
    return new Promise<string>((resolve) => {
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const id = new Headers(init?.headers).get("next-action");
        if (id) resolve(id);
        window.fetch = original;
        return original(input, init);
      };
      const form = [...document.querySelectorAll("form")].find((f) =>
        f.querySelector('input[name="publicKey"]'),
      );
      (form?.querySelector('input[name="publicKey"]') as HTMLInputElement).value =
        "0x04deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      (form?.querySelector("button") as HTMLButtonElement).click();
    });
  });

  expect(actionId).toMatch(/^[0-9a-f]{20,}$/);

  const body = {
    _1_publicKey: "0x04deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    "0": '["$K1"]',
  };

  // No operator cookie: must be refused.
  const denied = await request.post(`${baseURL}/mandate`, {
    headers: { "next-action": actionId, accept: "text/x-component", origin: baseURL! },
    multipart: body,
  });
  expect(denied.status()).toBe(500);

  // Same request with the cookie: must be accepted, which is what makes the
  // refusal above mean something rather than being a malformed request.
  const allowed = await request.post(`${baseURL}/mandate`, {
    headers: {
      "next-action": actionId,
      accept: "text/x-component",
      origin: baseURL!,
      cookie: `kawal_operator=${TOKEN}`,
    },
    multipart: body,
  });
  expect(allowed.status()).toBe(200);
});
