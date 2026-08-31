import { test, expect } from "@playwright/test";

/**
 * Agents that are real, callable software but not HTTP servers.
 *
 * ERC-8004 lets a registration point at a *service descriptor* instead of a
 * live endpoint: the agent is installed and spoken to over stdio, and the URL
 * serves a JSON document describing it. Kawal POSTed JSON-RPC at those, got a
 * 405, and filed them under "No answer".
 *
 * That is not a rounding error. The Q402 fleet by Quack AI accounts for
 * roughly half the MCP registrations on BSC and publishes 46 tools this way,
 * and the official BNB Chain MCP server is registered pointing at its own
 * source repository. Both were being ranked below registrations that declare
 * no interface at all.
 *
 * The bar is not that Kawal now calls them hireable — it still cannot enforce
 * a spend cap on a call it does not carry, and says so. The bar is that the
 * page states what the thing actually is.
 */

test("a service descriptor is reported as software to install, not a dead endpoint", async ({ page }) => {
  await page.goto("/agents/56/124748");

  const probe = page.locator("section", { has: page.getByText("We just called it") });
  await expect(probe.getByText("Runs locally, not hosted")).toBeVisible();
  await expect(probe.getByText("No answer")).toHaveCount(0);

  // The tools the handshake could not reach are recovered from the descriptor,
  // which is the whole point: 46 real capabilities were invisible before.
  await expect(probe.getByText("Transport")).toBeVisible();
  await expect(probe.getByText("stdio", { exact: true })).toBeVisible();
  await expect(probe.getByText("npx -y @quackai/q402-mcp@latest")).toBeVisible();

  // Quoted so a visitor can run it. Kawal must never imply it ran it.
  await expect(probe.getByText(/it is spoken to over stdio after you install it/)).toBeVisible();
  await expect(probe.getByText(/A spend cap cannot be enforced/)).toBeVisible();

  // An availability percentage about something that was never a server is a
  // category error, so it must not appear beside this verdict.
  await expect(probe.getByText(/checks answered since/)).toHaveCount(0);
});

test("a registration pointing at source is reported as source", async ({ page }) => {
  await page.goto("/agents/56/22669");

  const probe = page.locator("section", { has: page.getByText("We just called it") });
  await expect(probe.getByText("Published as source")).toBeVisible();
  await expect(probe.getByText("git clone https://github.com/bnb-chain/bnbchain-mcp")).toBeVisible();

  // No request was sent to a code forge, and the footer must not claim one.
  await expect(probe.getByText(/no request was sent to a repository host/)).toBeVisible();
  await expect(probe.getByText(/Kawal called this endpoint/)).toHaveCount(0);
});

test("a genuinely hosted server is unaffected by descriptor detection", async ({ page }) => {
  // The regression that would matter most: a working agent losing its verdict
  // because a second lookup was bolted onto the probe path.
  await page.goto("/agents/56/43129");

  const probe = page.locator("section", { has: page.getByText("We just called it") });
  // What must never happen is this endpoint being filed as software rather
  // than as a server. Whether it answered on this particular call is HeyAnon's
  // business and changes between runs — it did not, twice, under the suite's
  // fan-out — but it is a hosted endpoint either way, and the two descriptor
  // verdicts are wrong for it in every one of those states.
  await expect(probe.getByText("Runs locally, not hosted")).toHaveCount(0);
  await expect(probe.getByText("Published as source")).toHaveCount(0);
  await expect(probe.getByText("Transport")).toHaveCount(0);
  await expect(probe.getByText("Install")).toHaveCount(0);
});

test("an x402 claim is reported as asked-and-refused, not as a green tick", async ({ page }) => {
  // Aster declares x402_supported. Nothing on BSC that answers actually
  // charges — `npm run x402` re-measures — so this is the state every
  // claiming agent is in, and the page has to stop repeating the flag as
  // evidence.
  await page.goto("/agents/56/85400");

  const terms = page.locator("section", { has: page.getByText("We asked it to charge us") });
  await expect(terms.getByText("Claims x402, asked for nothing")).toBeVisible();
  await expect(terms.getByText(/Kawal sent the opening request of the protocol/)).toBeVisible();

  // Room is left for a payment route this request cannot see. The claim is
  // unverified, which is not the same as false.
  await expect(terms.getByText(/It may still charge by a route this request cannot see/)).toBeVisible();
  await expect(terms.getByText(/Kawal never\s+settles a payment/)).toBeVisible();

  // The page must not contradict itself: the signal above cannot show the
  // claim as satisfied while the section below reports nothing was asked.
  const verdict = page.locator("section", { has: page.getByText("Can you hire it") });
  await expect(verdict.getByText("Declared, but asked for nothing when called")).toBeVisible();
  await expect(verdict.getByText("x402 supported")).toHaveCount(0);
});

test("an agent that makes no payment claim is not asked for one", async ({ page }) => {
  // Cost discipline as much as correctness: the request only goes out for
  // agents that claim to charge.
  await page.goto("/agents/56/22669");
  await expect(page.getByText("We asked it to charge us")).toHaveCount(0);
});
