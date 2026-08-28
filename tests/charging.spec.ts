import { test, expect } from "@playwright/test";

/**
 * The endpoint that charges, and the one that tells owners their agent broke.
 *
 * Kawal measured that 75 of 200 BSC registrations declare x402 support and
 * that no reachable claimant ever issues a challenge. `/api/report` is the
 * counter-example, so the thing worth testing is not that it returns 402 —
 * anything can return 402 — but that the challenge is well formed, that money
 * it did not receive is refused, and that a paid request with a broken
 * argument is rejected before a receipt is banked.
 */

const REPORT = "/api/report?tokenId=43129";

test("asking without paying returns terms, in both carriers", async ({ request }) => {
  const res = await request.get(REPORT);
  expect(res.status()).toBe(402);

  const body = await res.json();
  expect(body.x402Version).toBe(2);
  expect(body.accepts.length).toBeGreaterThan(0);
  expect(body.accepts[0].network).toBe("eip155:56");
  expect(BigInt(body.accepts[0].amount)).toBeGreaterThan(0n);
  expect(body.accepts[0].payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);

  // A proxy can act on the header without reading a body, which is why q402
  // sends both and why Kawal's own reader tries the header first.
  const header = res.headers()["payment-required"];
  expect(header, "the header carrier is missing").toBeTruthy();
  const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
  expect(decoded.accepts[0].payTo).toBe(body.accepts[0].payTo);
  expect(res.headers()["www-authenticate"]).toMatch(/^Payment /);
});

test("the terms name the timeout the server enforces", async ({ request }) => {
  const res = await request.get(REPORT);
  expect(res.status()).toBe(402);
  const body = await res.json();
  // `maxTimeoutSeconds` is not decoration: settle() refuses a transfer mined
  // longer ago than this, measured from the block's own timestamp. The
  // refusal itself needs a real stale transfer to this wallet to exercise
  // and there is no way to mint one for a test, so the test holds the
  // advertised figure to the one the header names.
  expect(body.accepts[0].maxTimeoutSeconds).toBe(900);
  expect(res.headers()["www-authenticate"]).toContain('timeout="900"');
  // The native rail is always first; anything after it is a signed rail on
  // the B402 v2 wire, and every one of those must say which.
  expect(body.accepts[0].scheme).toBe("native-transfer");
  for (const extra of body.accepts.slice(1)) {
    expect(extra.scheme).toBe("exact");
    expect(extra.network).toBe("eip155:56");
    expect(["eip3009", "permit2-exact"]).toContain(extra.extra.assetTransferMethod);
  }
});

test("the v2 request carrier is read as well as the v1 one", async ({ request }) => {
  const res = await request.get(REPORT, { headers: { "payment-signature": "please-let-me-in" } });
  expect(res.status()).toBe(402);
  expect((await res.json()).rejected).toMatch(/transaction hash/);
  // The refusal still carries the terms, so a client that only reads the
  // header is not left with a bare status.
  expect(res.headers()["payment-required"]).toBeTruthy();
});

test("a signed envelope is recognised as one and refused on its merits, not as a bad hash", async ({ request }) => {
  // A B402 v2 envelope, correctly shaped, signed by nobody. On an instance
  // with no settler it is refused because the rail is not for sale here; on
  // one with a settler it is refused by the SDK's verification. Either way
  // it is 402, the reason is a sentence, and nothing is banked.
  const zero = "0x" + "00".repeat(20);
  const envelope = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: "exact",
      network: "eip155:56",
      payload: {
        signature: "0x" + "00".repeat(65),
        authorization: { from: zero, to: zero, value: "1", validAfter: "0", validBefore: "1", nonce: "0x" + "00".repeat(32) },
      },
    }),
  ).toString("base64");
  const res = await request.get(REPORT, { headers: { "payment-signature": envelope } });
  expect(res.status()).toBe(402);
  const body = await res.json();
  expect(typeof body.rejected).toBe("string");
  expect(body.rejected).not.toMatch(/transaction hash/);
});

test("an agent can be named as chainId:tokenId", async ({ request }) => {
  const res = await request.get("/api/report?agent=56:43129");
  expect(res.status()).toBe(402);
  expect((await res.json()).accepts[0].payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);

  const bad = await request.get("/api/report?agent=nope", { headers: { "payment-signature": "0x" + "ab".repeat(32) } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toMatch(/chainId:tokenId/);
});

test("a payment header that is not a transaction hash is refused", async ({ request }) => {
  const res = await request.get(REPORT, { headers: { "x-payment": "please-let-me-in" } });
  expect(res.status()).toBe(402);
  expect((await res.json()).rejected).toMatch(/transaction hash/);
});

test("someone else's transaction does not buy a report", async ({ request }) => {
  // A real, mined BSC transaction — Kawal's own revocation from the README —
  // which paid a contract rather than this wallet. The failure being guarded
  // is a caller who offers any transaction that exists, not one who typos.
  const notOurs = "0x229e41f27369f8ab8c7d9619c1a0118a6d3d126ec8c93ccfd99f8fee15b6f6ec";
  const res = await request.get(REPORT, { headers: { "x-payment": notOurs } });
  expect(res.status()).toBe(402);
  expect((await res.json()).rejected).toMatch(/did not pay/);
});

test("a paid request with a broken argument fails before the receipt is banked", async ({ request }) => {
  const res = await request.get("/api/report?tokenId=not-a-token", {
    headers: { "x-payment": "0x" + "ab".repeat(32) },
  });
  // 400, not 402: the argument is what is wrong, and the caller must not be
  // told to pay again for a request that could never have been served.
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/decimal token id/);
});

test("the paid tool is advertised over MCP with its price", async ({ request }) => {
  const res = await request.post("/api/mcp", {
    headers: { "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "deep_report", arguments: { tokenId: "43129" } } },
  });
  expect(res.status()).toBe(200);
  const out = JSON.parse(await res.text()).result.structuredContent;

  // Unpaid, it quotes rather than serves — and says where to pay.
  expect(out.paid).toBe(false);
  expect(out.forSale).toBe(true);
  expect(BigInt(out.priceWei)).toBeGreaterThan(0n);
  expect(out.payAt).toContain("/api/report");
});

test("an owner sees what Kawal observed about their agents", async ({ page }) => {
  // HeyAnon, who own several agents Kawal has probe history on.
  await page.goto("/owner?address=0xda977767452c5dd021624511f14df67b6c9c2c1b");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/still answering/i);
  await expect(page.locator("article").first()).toBeVisible();
  // The point of the page is the observation, not the registration.
  await expect(page.getByText(/calls? answered since/).first()).toBeVisible();
});

test("a malformed address is corrected rather than queried", async ({ page }) => {
  await page.goto("/owner?address=hello");
  await expect(page.getByText(/not a wallet address/i)).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
});
