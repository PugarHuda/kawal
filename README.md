<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Kawal

An agent marketplace for BNB Smart Chain, built for the *Build the Era*
hackathon.

BSC carries over 280,000 agents registered under ERC-8004 and adds a few
thousand a day. Under a tenth declare an interface anything could call, and
chain-wide there are roughly 11,700 pieces of feedback across all of them. The
registry is real; the ability to hire from it is not.

Kawal does two things about that.

**It refuses to take the registry's word.** 8004scan never calls an agent, so
"declares MCP" is a claim. Kawal dials the endpoint itself and keeps the
result. A sweep of the 19 agents the registry marks hireable found 6 that
answered, 2 whose declared endpoint is not there at all, and 11 speaking only
A2A or OASF — which this prober does not speak, so it says nothing about them
rather than guessing.

**It refuses to take the registry's word about reputation either.** An agent's
`total_feedbacks` and `average_score` are counts kept without asking who wrote
the records. Reading 1,200 of them from both ends of the BSC register found a
mark on every one — this is a graded register, not an empty one — but only 53
addresses behind the lot, one of which wrote 265 of the oldest 600 under the
tag `get top 1 rank >`. Separately, 8004scan's own `score` field, the one an
average is computed from, is null on 1,192 of the 1,200. Kawal reports who
wrote an agent's records instead of repeating a total. `npm run reputation`
re-measures.

**It writes its own measurements back.** The register is not short of writers,
it is short of writers with a measurement behind them. Kawal has called these
endpoints hundreds of times and kept every result, so `npm run publish` turns
that history into ERC-8004 feedback carrying the method that produced it and
the defects that method is known to have — the same habit GEBO, the uptime
agent already writing into this registry, keeps about itself.

**It puts agents to work under limits they cannot cross.** Four seats, four
scoped Altana sessions, each with its own contract allowlist, spend cap and
expiry, all registered on-chain so anyone can read the authority without
trusting this page.

## Run it

```bash
npm install
npm run dev
```

Nothing below needs a wallet or an API key. The catalog reads live 8004scan
data; the probes call live agents.

| Command | What it does |
|---|---|
| `npm run check` | Offline self-check: taxonomy, tiers, mandate policy, SSRF guard, caching, schemas, pricing, report verdicts, vault |
| `npm run test:e2e` | 107 Playwright tests against production builds: Chromium, Firefox, WebKit, a phone viewport, and a second instance running against a dead registry. Includes an axe accessibility audit and a CSP-violation check on every page |
| `npm run lint` | ESLint |
| `npm run audit:coverage` | Live: how many agents each of the four categories actually holds |
| `npm run verify:venues` | Proves every allowlisted contract address on BSC mainnet (add `-- testnet` for chain 97) |
| `npm run advantage` | Runs the TermiX Agent Advantage Report — three real tasks, hired vs by hand. Writes `ADVANTAGE.md` and the results the `/advantage` page renders |
| `npm run sweep` | Calls every agent listed as hireable and records what answered |
| `npm run reputation` | Reads ERC-8004 feedback from both ends of the BSC register and reports who wrote it |
| `npm run x402` | Samples BSC registrations claiming x402 and counts how many actually demand payment |

Commands that spend money are separate and refuse to run without enough
balance:

| Command | Cost |
|---|---|
| `npm run wallet:new` | Free. Mints the admin key, prints only the address |
| `npm run onchain -- mainnet` | ~0.0037 BNB — grants a four-seat mandate and proves the allowlist bites |
| `npm run preempt` | Dry run by default; `-- --send` costs ~0.00075 BNB |
| `npm run publish` | Dry run by default; `-- --send` writes Kawal's uptime measurements into the ERC-8004 reputation registry, ~0.000025 BNB per record |

## What is proven on-chain

Everything here is BSC mainnet, verified by re-reading the chain rather than
trusting the script that wrote it.

- **Four scoped sessions, registered in the Altana KeyStore.** `getKeys`
  returned five keyIds for the wallet — the admin key plus one per seat — each
  re-derived locally as `keccak256(publicKey)` and matched.
- **A real transaction through a session key.**
  [`0x4b4316ac…f640fd2`](https://bscscan.com/tx/0x4b4316ac5626680519968db05324c3e7ab3127e6b2d14f1521be5b9d8f640fd2)
- **The allowlist refuses.** The same session key sending the *identical*
  `deposit()` call to a contract it was not granted was rejected. That is the
  difference between granting a session and bounding one.
- **Revocation from inside the product.**
  [`0x229e41f2…5b6f6ec`](https://bscscan.com/tx/0x229e41f27369f8ab8c7d9619c1a0118a6d3d126ec8c93ccfd99f8fee15b6f6ec)
  — clicked in a browser, not scripted.
- **Preemption executed, not just drawn.** The risk officer narrowed the
  allocator four-fold:
  [`0x793ecb57…f33d26`](https://bscscan.com/tx/0x793ecb574cd985f5683fbe34bbadfbef76672adfdc29923e597cad8dd4f33d26).
  Altana has no amend-a-session call, so this is revoke-then-regrant, and
  KeyStore revocation is monotonic — `npm run preempt` checks the balance for
  the whole cycle first, because stopping between the two steps leaves the
  seat with no authority and no way back.

Wallet: [`0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92`](https://bscscan.com/address/0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92)

## Security headers

Every response carries `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, `X-Frame-Options` and `Strict-Transport-Security` from
`next.config.ts`, plus a nonce-based Content-Security-Policy from `proxy.ts`.

Kawal renders text strangers wrote — an agent's name and description come from
a registration anyone can mint — so this is what bounds the damage if React's
escaping is ever wrong. The nonce is minted per request, which is why the home
page renders dynamically: a prerendered shell ships without one, and every
script on it is refused. That failure is silent, so a test asserts on it.

## Layout

```
lib/        importable modules — no side effects on import
scripts/    executables; every one of them does something when run
tests/      Playwright specs, run against a production build
```

The split is load-bearing. `scripts/` files run work at import time, so pulling
one into another module fires it: importing the advantage runner to test a pure
function once turned `npm run check` into a network job that rewrote a report.

## Files it writes

All gitignored, all holding either key material or observations.

| File | Contents |
|---|---|
| `.kawal-admin.key` | The wallet's private key. Never printed, never logged |
| `.kawal-sessions.json` | Granted seats and what became of them. Holds session private keys |
| `.kawal-uptime.db` | SQLite. Every probe Kawal has made, for the reliability panel |

## Configuration

| Variable | Effect |
|---|---|
| `KAWAL_OPERATOR_TOKEN` | Unlocks revoking in the control room. **Unset means nobody can revoke** — an instance deployed without reading this is inert, not exposed |
| `KAWAL_ADMIN_KEY` | The wallet key, for deployments that keep it out of the filesystem |
| `SCAN_API_KEY` | 8004scan Pro tier, lifting the rate limit |
| `SCAN_API_ORIGIN` | Points the registry client elsewhere. The test suite aims it at a host that refuses connections to prove the outage path is real |

Holding the token is permission; holding the key is capability. An instance
with the token and no key renders view-only rather than offering a button it
cannot honour.

## What is not here, and why

**x402 payment is not implemented.** Not deferred — there is nothing to pay.
All three agents used in the advantage report are registered
`x402_supported: true` and none issues a payment challenge; the one agent found
that genuinely charges (Sentinels Audit, 0.2 BNB per audit) reports
`x402_supported: false` and takes a plain native transfer. Building a payer
with no charger would be a mock.

**ERC-8183 hiring is not implemented.** It needs escrow funding the wallet does
not currently hold, and the real cost cannot be quoted without reading
`disputeWindow()` from a funded client. The market is live — the `buyback&burn`
agent (#158888) publishes ERC-8183 jobs on BSC — so this is a funding gap, not
a feasibility one.
