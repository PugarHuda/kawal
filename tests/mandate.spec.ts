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
