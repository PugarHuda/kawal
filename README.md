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
result. It speaks both protocols the roster actually uses: MCP, by handshake
and tool list, and A2A, by reading the agent card and asking the JSON-RPC
endpoint the one question the specification defines as having no effect.
That second one matters more than it sounds — 46 of the 114 agents Kawal
lists speak A2A and nothing else, and they are the ERC-8183 sellers, which is
to say the part of BSC where hiring actually happens. Until the prober learned
their language they were invisible.

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
agent already writing into this registry, keeps about itself. Eleven such
records are on BSC mainnet as of 28 August 2026, receipts confirmed against
the Reputation Registry — for instance
[`0x5a4af5b6…`](https://bscscan.com/tx/0x5a4af5b6338411667abd4d9e7b32c214f7563ba130571023f358829809dee269)
on Venus and
[`0xee044e1e…`](https://bscscan.com/tx/0xee044e1e6a4108a489a782dfb2021e57a1b7c353722be6ab81e25055313ce0ef)
on V3 Pools. The remaining measured agents wait on a wallet top-up of about
0.0003 BNB; the script says which by name.

**It puts agents to work under limits they cannot cross.** Four seats, four
scoped Altana sessions, each with its own contract allowlist, spend cap and
expiry, all registered on-chain so anyone can read the authority without
trusting this page.

**Live:** https://kawal-three.vercel.app — the MCP endpoint, the A2A card and
the paid report are all public there. Kawal's own prober, pointed at that
address, reports: MCP answered, 5 tools; A2A card served and the JSON-RPC
endpoint answered; x402 challenge issued for 0.0001 BNB. It is the one
registration on BSC this prober has found that passes all three of its own
checks.

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
| `npm run test:e2e` | 145 Playwright tests against production builds: Chromium, Firefox, WebKit, a phone viewport, and a second instance running against a dead registry. Includes an axe accessibility audit and a CSP-violation check on every page |
| `npm run lint` | ESLint |
| `npm run audit:coverage` | Live: how many agents each of the four categories actually holds |
| `npm run verify:venues` | Proves every allowlisted contract address on BSC mainnet (add `-- testnet` for chain 97) |
| `npm run advantage` | Runs the TermiX Agent Advantage Report — three real tasks, hired vs by hand. Writes `ADVANTAGE.md` and the results the `/advantage` page renders |
| `npm run sweep` | Calls every agent listed as hireable and records what answered |
| `npm run reputation` | Reads ERC-8004 feedback from both ends of the BSC register and reports who wrote it |
| `npm run roster` | Measures what the newest registrations are made of: template copies, distinct owners, declare rate |
| `npm run x402` | Samples BSC registrations claiming x402 and counts how many actually demand payment |

Commands that spend money are separate and refuse to run without enough
balance:

| Command | Cost |
|---|---|
| `npm run wallet:new` | Free. Mints the admin key, prints only the address |
| `npm run onchain -- mainnet` | ~0.0037 BNB — grants a four-seat mandate and proves the allowlist bites |
| `npm run preempt` | Dry run by default; `-- --send` costs ~0.00075 BNB |
| `npm run publish` | Dry run by default; `-- --send` writes Kawal's `uptime` and `responseTime` measurements into the ERC-8004 reputation registry. Gas is estimated per record against the real contract (~0.0000124 BNB each at 0.05 gwei), the balance decides how many go, most-observed first, and what was sent is recorded in `.kawal-published.json` so a re-run does not write the same agent twice in a day. `-- --verify` reads every published record back off the chain and checks it landed as written (11 of 11 do); `-- --revoke <agentId>` retracts one |
| `npm run pay` | Pays Kawal's own x402 challenge from the wallet and prints the report; `-- --altana` pays through a session key under its cap |
| `npm run hire` | Simulates (or with `--send`, executes) an ERC-8183 hire against the live commerce contract |
| `npm run ledger:push` | Copies the seat ledger to the deployed site's database, session keys stripped. Needs `TURSO_DATABASE_URL` |
| `npm run history:push` | Copies this machine's probe history into the deployed site's database, keyed by endpoint and second so a re-run adds nothing |
| `npm run register` | Dry run by default; `-- --send` mints Kawal's own ERC-8004 registration (gas only, ~0.00001 BNB). The document must resolve at the deployed origin first |

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

## An agent can ask too

Kawal answers over the Model Context Protocol at `/api/mcp`. No key, nothing
to sign, nothing that writes.

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

| Tool | What it answers |
|---|---|
| `verify_agent` | Dials the declared endpoint now — MCP handshake or A2A card plus liveness — and returns the tier, what answered, and every probe Kawal has made of it before |
| `check_payment` | Sends the opening x402 request and reports whether the server actually demands payment |
| `read_reputation` | Who wrote this agent's feedback, how many records carry a mark, what share came from the busiest address |
| `find_agents` | Search by describing the problem; duplicate registrations collapsed |
| `deep_report` | Everything above in one answer plus how the endpoint fails when it fails. Costs money; unpaid, it returns the terms |

The same skills are served over A2A. `/.well-known/agent-card.json` is a
spec-shaped card naming `/api/a2a`, which answers `message/send` with a data
part naming a skill (or plain text — a token id in it means verify, anything
else is a search). Kawal's own prober, pointed at Kawal, gets the same answer
it gives everyone else; the offline check parses the card with the same reader
and the suite asks Kawal the same harmless `tasks/get` it asks every A2A
seller. A card over a silent server would be exactly the "declares an
interface" claim this project exists to catch.

Every route that fetches on a caller's behalf sits under a ceiling: sixty in a
burst then one a second for `/api/mcp`, `/api/a2a` and `/api/report`, tighter
for `/owner`, which fans out to every agent an address holds. Without it Kawal
is an amplifier anyone can point at the roster. The buckets live in the same
libSQL store as the probe history when one is configured — Vercel runs more
than one instance, and a per-process ceiling is N ceilings — and in memory
otherwise. `/compare` and the agent sheet, the two pages that fan out to the
registry, sit under the same ceiling.

The point is the shape. This is a marketplace for agents in an ecosystem where
the buyers are increasingly agents, and 8004scan publishes MCP tools of its
own, so answering only in HTML was the wrong format for the evidence. What
Kawal can say that nobody else can is not the registry data — anyone can read
that — it is "I called this endpoint 85 times since the 24th and it answered
83".

**No tool accepts a URL.** The endpoint is public, unauthenticated and fetches
on the caller's behalf, so one that took a location would be an open proxy with
a server-side fetch behind it. Callers name an agent by chain and token id, the
endpoint dialled is the one the registry published, and it still goes out
through the SSRF guard. A check asserts that invariant against every tool
schema so it survives the next tool being added.

## The one thing here that costs money

Kawal sampled 200 BSC registrations: 46 flag `x402_supported`, 99 of the A2A
cards could be read and six of those claim x402 in the card (four without the
registry flag), so 50 claim by either route. 47 of the 50 answered a call. Not
one issued a payment challenge. Complaining about that and then charging for
nothing would leave the obvious question unanswered, so `/api/report` is the
counter-example: ask without paying and it answers 402 with terms; pay and
resend the receipt and it answers with the report.

```bash
curl -i "http://localhost:3000/api/report?tokenId=43129"
# HTTP/1.1 402 Payment Required
# payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJwYXltZW50IHJlcXVpcmVk…
```

The first rail is the dullest mechanism available, on purpose: the challenge
names an address and an amount, the caller sends a plain BNB transfer and
resends with `PAYMENT-SIGNATURE` (x402 v2; `X-PAYMENT` still works) carrying
the transaction hash, and Kawal reads the receipt off the chain. The wire
format is x402 v2 — `payment-required` on the 402, `PAYMENT-RESPONSE` on the
settled 200, `network: eip155:56`.

Two more rails come from Altana's x402 server SDK: `permit2-exact` in USDT and
`eip3009` in $U, the token BNB Agent Studio buyers hold. They are advertised
only when this instance holds a funded settler (`KAWAL_FACILITATOR_KEY`, else
the admin key) — the SDK's facilitator is a local EOA that submits the
transfer, and a rail nobody here can settle must not appear in the quote. The
offline check signs a real permit2 envelope with a session key and verifies it
through the same code the route uses.

Five things it refuses: a hash that is not one, a transaction that paid
somebody else, one with fewer than three confirmations, one older than the
quote's `maxTimeoutSeconds` (a refund or a year-old transfer is not a payment
for this), and one that has been used before. The last matters most — a
receipt is a bearer token once it is public, so spent hashes are kept and
refused on sight.

`npm run pay` closes the loop from the buyer's side: it fetches the challenge,
pays the native rail from the wallet, and resends; `-- --altana` pays through
`client.fetchWithX402` with a seat from the ledger, which is what a hired agent
would do under its cap.

An instance holding no wallet does not charge. It answers 503 and says why,
rather than quoting an address it cannot spend from.

The terms live in `lib/x402.terms.ts`, which is pure, and the offline check
asserts that Kawal's own challenge parses with Kawal's own reader. A payment
claim this project cannot verify is precisely what it refuses to publish about
anybody else.

## Kawal's own registration

`/.well-known/agent-registration.json` is Kawal's ERC-8004 `registration-v1`
document, shaped as read off a live BSC registration rather than the
specification's example: services for MCP, A2A and the web, `x402Support`
exactly as true as the challenge at `/api/report` is, `active` only when
there is a wallet to be paid. It is held to the rule this project holds every
other registration to — nothing declared that the prober would not verify —
and the suite reads it and then dials what it declares from the same origin.
`npm run register` mints it with `register(string agentURI)`, found by
simulating the reference signatures against the live Identity Registry: it is
the one that estimates rather than reverts.

## Probes on a schedule

Every reputation record Kawal wrote carried "probes are made when the site is
used rather than on a schedule" among its stated defects, and it was true. A
Vercel Cron now calls `/api/cron/sweep` once a day — the Hobby plan's ceiling;
the route itself is safe at any cadence — at most forty agents
a run drawn from the five seats and the sixty strongest on the open roster,
rotating so successive runs cover it, behind the secret Vercel sends with the
request. No secret configured means no sweep rather than an open one — an
endpoint that makes Kawal dial the whole roster must not run because a
variable is missing. Each run is recorded (`/api/health` reports the last
one), and an agent that answered and serves its registration document is
handed to 8004scan's `verify-endpoint`, so the registry's own verified mark
follows Kawal's call. OASF endpoints are dialled too, not just counted.

## Is your agent still answering?

`/owner` is the other half of the market. Nothing on BSC tells an owner their
endpoint went dark — 8004scan publishes a cached health check with no history,
and the registry keeps listing a dead agent exactly as it was minted. Kawal has
been calling these endpoints and keeping every result, so paste the address
that minted them and see what it found. No sign-in: an ERC-8004 registration
names its owner on-chain and every observation shown is a call to an endpoint
the registration published, so there is nothing to prove.

## How an endpoint is dead, not just that it is

"Does not answer" was one word covering four situations. From 669 probes kept
on one instance:

| Probes | Symptom | What it means |
|---|---|---|
| 62 | `could not resolve syenite.ai` | The domain is gone. Nobody is coming back |
| 61 | `HTTP 404 {"error":"agent not found"}` | The host is alive and disowns this agent — a deregistration ERC-8004 has no way to record |
| 38 | `HTTP 502` | The origin is failing right now; a later check may pass |
| 5 | `timed out` | Something is listening and will not talk |

These are not the same proposition to somebody about to grant a spend cap, so
the agent page names the manner of death rather than collapsing it into a tier.

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

## How it looks, and why

The interface is a book of escort forms — the lineage is the Indonesian
*surat jalan* — on three-part carbon paper: pre-printed captions in a
condensed face, entries struck on a typewriter, and a rubber stamp Kawal
presses after it has called an agent. The forms are worded in English; what
is borrowed is the stationery, not the language. The stamp's ink prints darker the more calls sit behind it. Every
form carries a printed key, and the only buttons are perforated counterfoils.

That is a direction, not a theme, and it has rules. They are written down in
[DESIGN.md](DESIGN.md) — tokens, type, the stamp grammar, what each form
K-1 to K-7 is for, and the review record — so that the next change keeps the
world intact instead of adding a card to it.

## Where the state lives

Three things outlive a request: every probe Kawal has made, every payment
receipt it has accepted, and the ledger of seats it granted. On a machine with
a disk they are SQLite files. On a host without one — every serverless
platform — a file resets on each cold start, and a probe history that resets
is not a history, while a payment ledger that resets accepts the same receipt
twice.

So `lib/db.ts` keeps the SQLite dialect and makes the file optional. With
`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` set, every store talks to one
libSQL database over HTTP; without them, each opens its own file as before.
The SQL is identical and nothing above that module knows which it got. The
seat ledger takes the same road for the web app only: the CLI scripts keep
using the file, because they run where the key is, and `npm run ledger:push`
copies the file up with the session private keys stripped — the deployed site
reads seats and revokes them with the admin key, it never drives one.

Deploying, then, is `vercel integration add turso` (the Marketplace step
needs its terms accepted once in a browser), `vercel env pull`, `npm run
ledger:push`, and `vercel deploy`. The wallet key stays off the platform:
`KAWAL_PAY_TO` is enough for the paid endpoint to quote an address, and a
deployment without the key renders the control room view-only rather than
offering a button it cannot honour.

## Files it writes

All gitignored, all holding either key material or observations.

| File | Contents |
|---|---|
| `.kawal-admin.key` | The wallet's private key. Never printed, never logged |
| `.kawal-sessions.json` | Granted seats and what became of them. Holds session private keys |
| `.kawal-uptime.db` | SQLite. Every probe Kawal has made, for the reliability panel |
| `.kawal-payments.db` | SQLite. Transaction hashes already spent on a report, so none is used twice |
| `.kawal-published.json` | Which agents this machine has written a reputation record for, and when |

The probe history carries a `protocol` column, added in place when an older
file is opened: rows from before the prober spoke A2A default to `mcp`, which
is what they were. Renaming would have orphaned every observation kept so far.

## Configuration

| Variable | Effect |
|---|---|
| `KAWAL_OPERATOR_TOKEN` | Unlocks revoking in the control room. **Unset means nobody can revoke** — an instance deployed without reading this is inert, not exposed |
| `KAWAL_ADMIN_KEY` | The wallet key, for deployments that keep it out of the filesystem |
| `SCAN_API_KEY` | 8004scan Pro tier, lifting the rate limit |
| `SCAN_API_ORIGIN` | Points the registry client elsewhere. The test suite aims it at a host that refuses connections to prove the outage path is real |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Moves every store from local SQLite files to one libSQL database. Set by the Vercel Turso integration |
| `KAWAL_PAY_TO` | Where `/api/report` takes payment, for deployments that keep the wallet key off the platform |

Holding the token is permission; holding the key is capability. An instance
with the token and no key renders view-only rather than offering a button it
cannot honour.

## What is not here, and why

**No third-party agent has been paid.** Not deferred — there is nobody to pay.
All three agents used in the advantage report are registered
`x402_supported: true` and none issues a payment challenge; the one agent found
that genuinely charges (Sentinels Audit, 0.2 BNB per audit) reports
`x402_supported: false` and takes a plain native transfer. The payer exists
(`npm run pay`) and is pointed at the one charger on the chain that is
verifiable end to end: Kawal.

**`Hireable` means the agent answers, not that it works.** The tier is earned
by completing an MCP handshake and listing tools. Kawal does not run any of
them: executing a stranger's tool uninvited can cost them money or move
something, and asking permission is not a thing a catalogue can do at scale. So
an agent that answers `initialize`, names sixteen tools and errors on every one
of them scores exactly like an agent that does the job. Kawal is strict about
everybody else's unverified claims and this one is its own, so the agent page
says so where the claim is made rather than leaving it to be discovered.

**Kawal is not a validator, because there is nothing to validate against.**
ERC-8004 defines three registries: Identity, Reputation and Validation. The
third is the one where an independent party attests that an agent did what it
claimed, which is precisely the work this project does — so it looked like the
obvious place to publish. It is empty. 8004scan reports `total_validators: 0`
and `total_validations: 0` across 777,813 agents and every chain it indexes,
and the BSC Identity and Reputation implementations carry no reference to a
validation registry in their bytecode. Nobody has used this part of the
standard, anywhere, and on BSC there does not appear to be a deployment to use.
So the measurements go into the Reputation registry instead, which is indexed
and read. Worth recording as a finding: a third of ERC-8004 is currently
decorative.

**ERC-8183 hiring is written and unfunded.** `npm run hire -- --provider 0x…
--task "…" --budget 1` simulates the whole sequence against the live commerce
contract (`createJob` → `registerJob` → `setBudget` → `approve` → `fund`, via
`eth_simulateV1`) and prints the $U balance and shortfall; `--send` runs it.
Four of the five calls simulate clean today; `fund` reverts because the wallet
holds no $U. The dispute window reads as seven days, the next job id is
56666, and `--job <id>` reads a live one. `lib/erc8183.ts` is the interface a
job panel is built on.
