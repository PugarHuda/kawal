# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: someone holding capital on BNB Smart Chain who is deciding whether to
hire an on-chain agent and hand it a spend cap. They arrive with a job in mind
(keep a lending position out of liquidation, find where yield is, rebalance a
portfolio, run a grid) and a healthy distrust of a registry that lists 288,000
agents of which a few dozen actually answer. They read fast, compare, and want
to see the evidence before the button. Confirmed with the owner.

Secondary, confirmed as real but not primary: hackathon judges reading the
site in three to five minutes; owners of registered agents checking whether
their endpoint still answers (`/owner`); and other agents reaching Kawal over
MCP or A2A, for whom the web pages are secondary to the API.

## Product Purpose

Kawal is an agent marketplace for BNB Smart Chain that refuses to take the
ERC-8004 registry's word. It dials every declared endpoint itself (MCP
handshake, or A2A card plus a harmless JSON-RPC question), asks agents that
claim x402 whether they really charge, reads who wrote an agent's feedback
rather than how much of it there is, keeps every probe as a history, and lets
a visitor put an agent to work under limits it cannot cross — spend cap,
contract allowlist, expiry, revocable — registered on-chain through Altana
session keys.

Success is a visitor making a genuinely informed hiring decision without
hitting a dead end, and an agent being bounded rather than merely granted.

## Positioning

Every other surface for this registry repeats what a registration says about
itself. Kawal's claim is that it verified: "I called this endpoint 91 times
since the 26th and it answered 89" is a sentence only Kawal can write, and
it writes it back into the registry as ERC-8004 feedback with the method and
the method's defects stated. It is also, by its own measurement, the one
registration on BSC that passes all three of its own checks (answers MCP and
A2A, issues a real x402 challenge).

## Operating Context

- The roster comes live from 8004scan; probes are live calls to strangers'
  servers, made server-side, memoised for a minute, rate-limited per caller.
- Hiring happens through Altana session keys on BSC mainnet; four seats
  (Risk officer, Allocator, Market maker, Execution trader) map to the four
  job categories the hackathon rubric requires.
- Money is real and small: the wallet holds fractions of a BNB, and every
  on-chain action is dry-run by default.
- Deployed at https://kawal-three.vercel.app with a shared libSQL database;
  a daily scheduled sweep probes the roster.

## Capabilities and Constraints

- Pages: home, agent listing by category, agent detail with live probe,
  compare (up to three), mandate control room, owner lookup, evidence
  (advantage report). APIs: /api/mcp, /api/a2a, /api/report (paid, 402),
  /api/health, /.well-known/agent-card.json, /.well-known/agent-registration.json.
- Renders text strangers wrote (agent names and descriptions from
  registrations anyone can mint); a nonce CSP and strict headers bound that.
- Every page renders dynamically so the CSP nonce is per request; nothing may
  need `unsafe-inline` scripts. Inline `style` attributes are allowed
  (`style-src-attr 'unsafe-inline'`) and used for seat colours.
- No client-side fetching to third parties: the registry, the chain and every
  agent endpoint are called server-side.
- Terminology to preserve: seat, mandate, spend cap, allowlist, tier
  (Hireable / Reachable / Does not answer / Registered only), probe, feedback
  record (never "rating"), "answers" (not "works").
- 145 Playwright tests run against production builds across Chromium,
  Firefox, WebKit, a phone viewport and a dead-registry instance; every page
  passes an axe audit with no serious violations and a CSP-violation check.
  New UI must keep both green.
- Undecided: the brand voice. The current voice (calm, evidentiary, states its
  own limits, British spelling, no hype) is not binding; the owner has said it
  may be redefined together with a new visual world. Factual copy — numbers,
  probe outcomes, tier labels, on-chain proofs — is not to be softened or
  replaced.

## Brand Commitments

The name Kawal (Indonesian: to escort, to guard) is fixed. No logo exists;
the wordmark is set in the body typeface. No colour, typeface or aesthetic is
binding: the owner has chosen a full redesign in which the incumbent look is
evidence and anti-reference, not a constraint.

## Evidence on Hand

- Live figures: 288,072 agents on BSC, 8.5% declaring an interface chain-wide
  and 38.8% among the newest 600; 62.8% of the newest 600 are template copies
  across 464 owners; 1,200 sampled feedback records from 53 addresses.
- Kawal's own history: 1,068 probes across 36 endpoints since 2026-08-26.
- Eleven ERC-8004 reputation records written by Kawal on BSC mainnet, e.g.
  https://bscscan.com/tx/0x5a4af5b6338411667abd4d9e7b32c214f7563ba130571023f358829809dee269
- On-chain mandate proofs: session grant, an allowed transaction, a refused
  one, a revocation clicked in the browser, a preemption — hashes in README.md.
- The Agent Advantage Report (`ADVANTAGE.md`, `/advantage`): three real tasks,
  hired versus by hand, with hiring winning one of three — published as such.
- Absent, and not to be fabricated: testimonials, customers, logos of
  partners, pricing beyond the single 0.0001 BNB report, any uptime figure
  Kawal did not measure.

## Product Principles

1. Evidence before assertion: every claim on a page names what Kawal did to
   earn it, and the limit of what that proves.
2. Nothing repeated from the registry without saying it is the registry's.
3. Bounded, not merely granted: the product's value is the limit, so limits
   are shown as first-class objects, not settings.
4. Publish the inconvenient result: losses, refusals, and failures are content.
5. Agents are users too: anything a page shows should be reachable over MCP
   or A2A in the same shape.

## Accessibility & Inclusion

Axe audit with zero serious violations on every page is a hard gate in the
suite; primary navigation targets are at least 24px (WCAG 2.2); the primary
journey must be completable on a 393px phone without horizontal scroll.
