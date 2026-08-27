/**
 * Self-check for the two pieces of logic Kawal cannot get wrong: which
 * category an agent lands in, and whether it can actually be hired.
 *
 * Run: npm run check
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { classify, MIN_CONFIDENCE, CORE_CATEGORIES } from "../lib/taxonomy.ts";
import {
  assess,
  duplicateIndex,
  rank,
  seriesKey,
  stencilKey,
  MIN_OBSERVATIONS_TO_OVERRULE,
} from "../lib/signals.ts";
import { planMandate, preempt, UnsafeMandateError, VENUES, MAX_DURATION_DAYS } from "../lib/mandate.ts";
import { BSC_MAINNET, BSC_TESTNET } from "../lib/chains.ts";
import { readChallenge, networkName } from "../lib/x402.ts";
import type { ScanAgent } from "../lib/scan.ts";
import { assertPublicUrl, BlockedUrlError } from "../lib/ssrf.ts";
import { memo, clearMemo, memoStats } from "../lib/memo.ts";
import { parseAgents, ScanAgentSchema } from "../lib/scan.schema.ts";
import { readTool } from "../lib/probe.ts";
import { verdictFor, type TaskResult } from "../lib/advantage.report.ts";
import { explorerTx, explorerAddress } from "../lib/altana.ts";

function agent(over: Partial<ScanAgent> = {}): ScanAgent {
  return {
    id: "x",
    agent_id: "56:0x8004:1",
    token_id: "1",
    chain_id: 56,
    chain_type: "evm",
    contract_address: "0x8004",
    is_testnet: false,
    owner_address: "0xowner",
    owner_ens: null,
    owner_username: null,
    owner_publisher_tier: null,
    owner_certified_name: null,
    name: "Agent",
    description: "",
    image_url: null,
    is_verified: false,
    star_count: 0,
    supported_protocols: [],
    x402_supported: false,
    total_score: 0,
    rank: null,
    network_rank: null,
    health_score: null,
    total_feedbacks: 0,
    average_score: 0,
    created_at: "2026-08-15T00:00:00Z",
    updated_at: "2026-08-15T00:00:00Z",
    ...over,
  };
}

// --- taxonomy -------------------------------------------------------------

assert.equal(CORE_CATEGORIES.length, 4, "the rubric demands exactly four core categories");

const cases: Array<[string, string, string]> = [
  [
    "Venus Guardian",
    "monitors health factor and repays debt before liquidation",
    "health",
  ],
  [
    "PancakeSwap Range Manager",
    "rebalances concentrated liquidity positions when price drifts out of range",
    "rebalancing",
  ],
  ["GridPilot", "places laddered buy and sell grid orders inside a set band", "grid"],
  [
    "Yield Router",
    "moves stablecoins to the highest apy across Venus and Aave and auto-compounds",
    "yield",
  ],
  ["RugScope", "screens tokens for honeypot and rug pull risk before a trade", "security"],
];

for (const [name, desc, expected] of cases) {
  const got = classify(name, desc);
  assert.equal(got.category, expected, `${name} -> expected ${expected}, got ${got.category}`);
  assert.ok(
    got.confidence >= MIN_CONFIDENCE,
    `${name} classified as ${expected} but only ${got.confidence} confident`,
  );
}

// The real bulk-minted registration currently sitting at the top of BSC by
// recency. It must not be forced into a category.
const spam = classify(
  "Ave.ai Trading Agent",
  "AI-driven multi-chain trading agent with on-chain reputation.",
);
assert.equal(spam.category, null, "a vague description must stay unclassified, not be guessed");

// --- signals --------------------------------------------------------------

assert.equal(assess(agent()).tier, "registered", "no protocol means nothing to call");
assert.equal(
  assess(agent({ supported_protocols: ["a2a"] })).tier,
  "reachable",
  "callable but unpayable is not hireable",
);
assert.equal(
  assess(agent({ supported_protocols: ["a2a"], x402_supported: true })).tier,
  "hireable",
  "an interface plus a payment path is hireable",
);

// 8004scan reports "Web" and "Email" alongside the real protocols. They are a
// homepage and an inbox: a person can use them, an agent cannot. Counting them
// would let a registration with nothing but a landing page read as reachable.
assert.equal(
  assess(agent({ supported_protocols: ["Web"] })).tier,
  "registered",
  "a website is not an interface an agent can call",
);
assert.equal(
  assess(agent({ supported_protocols: ["Web", "Email"], x402_supported: true })).tier,
  "registered",
  "a payment path with nothing to call is still not hireable",
);
assert.equal(
  assess(agent({ supported_protocols: ["MCP", "Web"], x402_supported: true })).tier,
  "hireable",
  "a real protocol alongside Web is still callable",
);
assert.equal(
  assess(agent({ supported_protocols: ["MCP", "Web"] })).signals.find((s) => s.key === "callable")
    ?.detail,
  "MCP",
  "the interface signal must report only what can actually be called",
);

const twins = [
  agent({ token_id: "267968", name: "Ave.ai Trading Agent", description: "same" }),
  agent({ token_id: "267967", name: "Ave.ai Trading Agent", description: "same" }),
  agent({ token_id: "5", name: "Solo", description: "different" }),
];
const dupes = duplicateIndex(twins);
const [firstTwin, , soloAgent] = twins;
assert.ok(firstTwin && soloAgent, "the twin fixture must have three entries");
assert.equal(assess(firstTwin, dupes).duplicates, 2, "identical twins must be detected");
assert.equal(assess(soloAgent, dupes).duplicates, 1, "a distinct agent has no twin");

const distinctSignal = assess(firstTwin, dupes).signals.find((s) => s.key === "distinct");
assert.equal(distinctSignal?.pass, false, "a bulk-minted twin must fail the distinct signal");

// A duplicate must never outrank a distinct hireable agent on reputation alone.
const loudDupe = agent({ name: "D", description: "d", total_score: 40 });
const loudDupe2 = agent({ token_id: "2", name: "D", description: "d", total_score: 40 });
const quietReal = agent({
  token_id: "3",
  name: "Q",
  supported_protocols: ["a2a"],
  x402_supported: true,
  total_score: 5,
});
const idx = duplicateIndex([loudDupe, loudDupe2, quietReal]);
assert.ok(
  rank(quietReal, assess(quietReal, idx)) > rank(loudDupe, assess(loudDupe, idx)),
  "a hireable agent must outrank a bulk-minted one with a higher raw score",
);

// --- observation overrules the registry -------------------------------------
//
// The registry never calls anything, so "declares an interface" is a claim. A
// sweep of the 19 agents currently labelled hireable found two whose declared
// endpoint has never answered across six and seven attempts. Listing those as
// hireable is the exact unearned confidence this module exists to strip out.

const declared = agent({ supported_protocols: ["MCP"], x402_supported: true });
assert.equal(assess(declared).tier, "hireable", "with nothing observed, the claim stands");

const silent = { checks: MIN_OBSERVATIONS_TO_OVERRULE, answered: 0 };
assert.equal(
  assess(declared, undefined, silent).tier,
  "unreachable",
  "an endpoint called repeatedly and never reached is not hireable",
);

// The x402 flag is set by the registration about itself. Once Kawal has asked,
// the signal must report the asking, not the flag.
const paying = agent({ supported_protocols: ["MCP"], x402_supported: true });
const x402Row = (p?: { demanded: boolean }) =>
  assess(paying, undefined, undefined, p).signals.find((s) => s.key === "payable")!;

assert.equal(x402Row().pass, true, "unasked, the declaration stands");
assert.match(x402Row().detail, /not verified here/, "but it must not read as verified");
assert.equal(x402Row({ demanded: false }).pass, false, "asked and refused is a failed signal");
assert.match(x402Row({ demanded: false }).detail, /asked for nothing when called/);
assert.equal(x402Row({ demanded: true }).pass, true, "a real quote passes");
assert.match(x402Row({ demanded: true }).detail, /Quoted a price/);

// Not charging is not the same as not being hireable: an agent whose tools are
// free or settle on-chain is still hireable, and demoting every one of them
// over an unanswered 402 would be a worse error than the one being fixed.
assert.equal(
  assess(paying, undefined, undefined, { demanded: false }).tier,
  "hireable",
  "refusing to charge must not demote an otherwise callable agent",
);

// A published route that is not an HTTP call is an answer, not silence.
// q402 on BSC serves an ERC-8004 service descriptor listing 46 tools and
// refuses POST; Kawal used to call that "does not answer" and rank it below a
// registration with no interface at all.
const described = { ...silent, reachedAnotherWay: true };
assert.equal(
  assess(declared, undefined, described).tier,
  "hireable",
  "an agent that publishes a non-HTTP route has not gone silent",
);
assert.ok(
  rank(declared, assess(declared, undefined, described)) >
    rank(declared, assess(declared, undefined, silent)),
  "a published route must rank above proven silence",
);
assert.match(
  assess(declared, undefined, described).signals.find((s) => s.key === "observed")!.detail,
  /publishes a route Kawal cannot call/,
  "the page has to say why, not just show a tier",
);

// One bad moment is not proof. Below the threshold the claim survives.
assert.equal(
  assess(declared, undefined, { checks: MIN_OBSERVATIONS_TO_OVERRULE - 1, answered: 0 }).tier,
  "hireable",
  "too few observations must not condemn an agent",
);

// A single success is enough to keep it: the endpoint exists.
assert.equal(
  assess(declared, undefined, { checks: 20, answered: 1 }).tier,
  "hireable",
  "an endpoint that has answered at all is reachable",
);

const observedSignal = assess(declared, undefined, silent).signals.find((s) => s.key === "observed");
assert.equal(observedSignal?.pass, false, "the observation signal must fail when nothing answered");
assert.match(observedSignal?.detail ?? "", /0 of 3 calls answered/, "the record must be shown, not summarised away");
assert.match(
  assess(declared).signals.find((s) => s.key === "observed")?.detail ?? "",
  /not called this endpoint yet/,
  "never having checked must read differently from having checked and failed",
);

// A proven-silent agent must rank below one that never claimed anything: the
// second is honest about having nothing, the first is not.
const honest = agent({ token_id: "9", name: "Honest", supported_protocols: [] });
assert.ok(
  rank(honest, assess(honest)) > rank(declared, assess(declared, undefined, silent)),
  "a false claim must cost more than an absent one",
);

// A minted series varies the edition number in the name; a stencilled batch
// varies the name and reuses one description. Both were padding the live Yield
// listing under an exact name+description match.
const series = [
  agent({ token_id: "1", name: "BORT Yield Weaver #10877", description: "Rare-tier. Power 69/100." }),
  agent({ token_id: "2", name: "BORT Yield Weaver #10997", description: "Epic-tier. Power 81/100." }),
];
const [seriesA, seriesB] = series;
assert.ok(seriesA && seriesB, "the series fixture must have two entries");
assert.equal(seriesKey(seriesA), seriesKey(seriesB), "one minted series must share a key");
assert.notEqual(
  seriesKey(seriesA),
  seriesKey(agent({ name: "BORT Risk Matrix #11023" })),
  "different classes in the same collection are different agents",
);

const stencil = [
  agent({ token_id: "3", name: "HubKey223", description: "AI agent for vault" }),
  agent({ token_id: "4", name: "CyberHub38", description: "AI agent for vault" }),
];
const [stencilA, stencilB] = stencil;
assert.ok(stencilA && stencilB, "the stencil fixture must have two entries");
assert.equal(stencilKey(stencilA), stencilKey(stencilB), "one shared description is one stencil");
assert.equal(
  stencilKey(agent({ description: "trading" })),
  null,
  "a description too short to be distinctive must not collapse unrelated agents",
);
assert.notEqual(
  stencilKey(stencilA),
  stencilKey(agent({ description: "Monitors health factor and repays before liquidation" })),
  "genuinely different descriptions must survive",
);

// --- mandate --------------------------------------------------------------

// Every shipped venue must carry a verified address on every chain it claims
// a deployment for. `npm run verify:venues` proves those addresses are the
// contracts they claim to be; this only proves none of them silently went
// missing.
for (const v of Object.values(VENUES)) {
  const chains = Object.keys(v.deployments);
  assert.ok(chains.length > 0, `${v.id} is deployed nowhere`);
  for (const [chainId, d] of Object.entries(v.deployments)) {
    assert.ok(d.address, `${v.id} has no verified address on chain ${chainId}`);
    assert.match(d.address, /^0x[0-9a-fA-F]{40}$/, `${v.id} address on chain ${chainId} is malformed`);
    assert.ok(d.source.length > 0, `${v.id} records no evidence for chain ${chainId}`);
  }
}

// The fail-closed path still has to hold when a venue goes unresolved — that
// is what stops a half-configured deploy handing an agent a wildcard.
const aaveMainnet = VENUES["aave.v3.pool"].deployments[BSC_MAINNET];
assert.ok(aaveMainnet, "the Aave pool must have a mainnet deployment to park");
const parked = aaveMainnet.address;
aaveMainnet.address = null;
assert.throws(
  () => planMandate({ chainId: BSC_MAINNET, capital: 1_000n, durationDays: 30, now: 1_755_000_000 }),
  UnsafeMandateError,
  "an unresolved venue must block the grant, not silently widen it",
);
aaveMainnet.address = parked;

const NOW = 1_755_000_000;
const plans = planMandate({ chainId: BSC_MAINNET, capital: 1_000_000n, durationDays: 30, now: NOW });

assert.equal(plans.length, 4, "a mandate seats all four required categories");
assert.equal(plans[0]?.category, "health", "the risk officer must rank first");

for (const p of plans) {
  assert.ok(
    p.permissions.calls && p.permissions.calls.length > 0,
    `${p.seat} received an empty allowlist, which Altana treats as every target`,
  );
  assert.ok(
    p.permissions.spend !== undefined && (p.permissions.spend[0]?.limit ?? 0n) > 0n,
    `${p.seat} received no spend cap`,
  );
  assert.equal(p.expiry, NOW + 30 * 86_400, `${p.seat} expiry must match the mandate`);
}

const committed = plans.reduce((sum, p) => sum + (p.permissions.spend?.[0]?.limit ?? 0n), 0n);
assert.ok(committed <= 1_000_000n, "seats together must never be able to spend more than the mandate");

assert.throws(
  () =>
    planMandate({ chainId: BSC_MAINNET, capital: 1_000n, durationDays: 1, now: NOW }, [
      { category: "yield", seat: "A", capShare: 0.7, period: "day", venues: ["venus.comptroller"], priority: 1 },
      { category: "grid", seat: "B", capShare: 0.7, period: "day", venues: ["venus.comptroller"], priority: 2 },
    ]),
  UnsafeMandateError,
  "overcommitted seat caps must be rejected",
);

assert.throws(
  () => planMandate({ chainId: BSC_MAINNET, capital: 0n, durationDays: 30, now: NOW }),
  UnsafeMandateError,
  "a zero mandate is not a mandate",
);

// Aave has no BNB-testnet market, so the allocator and the risk officer both
// plan with fewer venues there. Fewer is fine; zero is not, because a seat
// with an empty allowlist is exactly the wildcard this module exists to stop.
const testnetPlans = planMandate({
  chainId: BSC_TESTNET,
  capital: 1_000_000n,
  durationDays: 30,
  now: NOW,
});
assert.equal(testnetPlans.length, 4, "all four seats must be grantable on testnet");
for (const p of testnetPlans) {
  assert.ok(
    p.permissions.calls && p.permissions.calls.length > 0,
    `${p.seat} has no allowlisted venue on testnet`,
  );
}
const mainnetAave = plans.find((p) => p.category === "yield")!.permissions.calls!.length;
const testnetAave = testnetPlans.find((p) => p.category === "yield")!.permissions.calls!.length;
assert.ok(
  testnetAave < mainnetAave,
  "the allocator should lose the venues that do not exist on testnet, not silently keep them",
);

// A duration with no ceiling used to reach `new Date().toISOString()` and
// throw a bare RangeError, which the UI then reported as an ordinary refusal.
// A crash and a policy decision must not look the same to a caller.
for (const bad of [MAX_DURATION_DAYS + 1, 99_999_999, 1.5, 0, -1, NaN, Infinity]) {
  assert.throws(
    () => planMandate({ chainId: BSC_MAINNET, capital: 1_000_000n, durationDays: bad, now: NOW }),
    UnsafeMandateError,
    `durationDays=${bad} must be refused as unsafe, not crash`,
  );
}
assert.doesNotThrow(
  () => planMandate({ chainId: BSC_MAINNET, capital: 1_000_000n, durationDays: MAX_DURATION_DAYS, now: NOW }),
  "the documented maximum must still be grantable",
);
for (const badNow of [0, -1, 1.5, NaN]) {
  assert.throws(
    () => planMandate({ chainId: BSC_MAINNET, capital: 1_000n, durationDays: 30, now: badNow }),
    UnsafeMandateError,
    `now=${badNow} must be refused`,
  );
}

// Preemption: the risk officer may shrink the allocator, never the reverse.
const cut = preempt(plans, "health", "yield", 0.25, "health factor below 1.4");
const before = plans.find((p) => p.category === "yield")?.permissions.spend?.[0]?.limit;
const narrowed = cut.narrowed.spend?.[0]?.limit;
assert.ok(before !== undefined && narrowed !== undefined, "both caps must exist to compare");
assert.ok(narrowed < before, "preemption must actually shrink the cap");
assert.deepEqual(
  cut.narrowed.calls,
  plans.find((p) => p.category === "yield")!.permissions.calls,
  "preemption narrows spend, it does not silently rewrite the allowlist",
);

assert.throws(
  () => preempt(plans, "yield", "health", 0.5, "allocator overreach"),
  UnsafeMandateError,
  "a lower-priority seat must not be able to disarm the risk officer",
);

assert.throws(
  () => preempt(plans, "health", "yield", 1.5, "bad factor"),
  UnsafeMandateError,
  "a preemption that widens a cap is not a preemption",
);

// --- ssrf guard ------------------------------------------------------------
//
// Every endpoint Kawal probes comes from a registration anyone can mint, so
// this guard is the difference between a marketplace and a port scanner
// pointed at whatever network the app runs in. Only IP literals, schemes and
// blocked hostnames are asserted here: those resolve no DNS, so the suite
// stays runnable offline.

const mustBlock = [
  "http://127.0.0.1/",
  "http://0.0.0.0/",
  "http://10.1.2.3/",
  "http://172.16.0.1/",
  "http://192.168.0.1/",
  "http://100.64.0.1/",
  "http://169.254.169.254/",
  "http://198.18.0.1/",
  "http://224.0.0.1/",
  "http://255.255.255.255/",
  "http://[::1]/",
  "http://[::]/",
  "http://[fc00::1]/",
  "http://[fe80::1]/",
  // Both spellings of IPv4-mapped loopback. `new URL()` rewrites the first
  // into the second, and a guard that only knew the dotted form let it past.
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:7f00:1]/",
  "http://[::ffff:169.254.169.254]/",
  "http://localhost/",
  "http://foo.localhost/",
  "http://metadata.google.internal/",
  "file:///etc/passwd",
  "gopher://example.com/",
  "not-a-url",
];

for (const url of mustBlock) {
  await assert.rejects(
    () => assertPublicUrl(url),
    BlockedUrlError,
    `${url} must never be fetched on behalf of a stranger`,
  );
}

// A public IP literal must still be reachable, or the guard has eaten the
// product along with the vulnerability.
await assert.doesNotReject(
  () => assertPublicUrl("http://[2606:4700:4700::1111]/"),
  "a public IPv6 address must remain allowed",
);
await assert.doesNotReject(
  () => assertPublicUrl("https://8.8.8.8/"),
  "a public IPv4 address must remain allowed",
);

// --- singleflight memo ------------------------------------------------------
//
// The Playwright suite failed at full parallelism and passed at four workers,
// because every concurrent category page started its own twelve-call fan-out.
// These assert the two properties that fix it.

clearMemo();

let calls = 0;
const slow = async () => {
  calls++;
  await new Promise((r) => setTimeout(r, 30));
  return calls;
};

// Ten callers arriving together must produce exactly one call.
const together = await Promise.all(Array.from({ length: 10 }, () => memo("k", 5_000, slow)));
assert.equal(calls, 1, "concurrent callers must join one in-flight call, not each start their own");
assert.deepEqual(together, Array(10).fill(1), "every caller gets the same answer");

// A later caller inside the TTL is served from memory.
assert.equal(await memo("k", 5_000, slow), 1, "a fresh entry must not re-run the work");
assert.equal(calls, 1, "the cached path must not call through");

// A different key is different work.
await memo("other", 5_000, slow);
assert.equal(calls, 2, "keys must not collide");

// An expired entry re-runs. The TTL is fixed when the value is stored, not
// by whatever a later caller passes, so this needs its own short-lived key.
await memo("shortlived", 1, slow);
assert.equal(calls, 3, "a new key runs the work");
await new Promise((r) => setTimeout(r, 10));
await memo("shortlived", 1, slow);
assert.equal(calls, 4, "a stale entry must re-run the work");

// A rejection must never be cached: one upstream blip should not blank a
// category page for the whole TTL.
let boom = 0;
const failing = async () => {
  boom++;
  throw new Error("upstream down");
};
await assert.rejects(() => memo("bad", 60_000, failing));
await assert.rejects(() => memo("bad", 60_000, failing));
assert.equal(boom, 2, "a failed call must be retried, not remembered");
assert.equal(memoStats().inflight, 0, "nothing may be left in flight after settling");

clearMemo();

// --- upstream shape validation ---------------------------------------------
//
// Responses used to be cast straight to a hand-written type, so the compiler
// vouched for a foreign server's JSON. A missing `total_score` reached
// `.toFixed(2)` and took the agent page down; `services` was declared an
// array when the API returns an object. Both are shape drift, and both are
// what these assert against.

const wellFormed = {
  id: "a", agent_id: "56:0x8004:1", token_id: "1", chain_id: 56,
  contract_address: "0x8004", name: "Real Agent", created_at: "2026-08-01T00:00:00Z",
};

const parsedOne = ScanAgentSchema.safeParse(wellFormed);
assert.ok(parsedOne.success, "a row carrying only the required fields must parse");
assert.equal(parsedOne.data.total_score, 0, "a missing number must default, not become undefined");
assert.deepEqual(parsedOne.data.supported_protocols, [], "a missing array must default to empty");
assert.equal(parsedOne.data.description, null, "a missing description must be null, not undefined");
// The crash this replaces: `.toFixed` on an absent number.
assert.equal(parsedOne.data.total_score.toFixed(2), "0.00", "defaults must be usable, not just present");

// A row with the wrong type for a required field is dropped, not coerced.
const mixed = parseAgents([
  wellFormed,
  { ...wellFormed, id: "b", chain_id: "fifty-six" },
  { ...wellFormed, id: "c", name: 42 },
  null,
  "not an object",
]);
assert.equal(mixed.agents.length, 1, "only the understandable row survives");
assert.equal(mixed.dropped, 4, "every dropped row must be counted, not silently lost");
assert.equal(parseAgents("not an array").agents.length, 0, "a non-array body must not throw");

// A junk value in an optional field is repaired rather than fatal, because
// one odd registration in 280,000 must not blank a category.
const repaired = ScanAgentSchema.safeParse({ ...wellFormed, star_count: "many", x402_supported: "yes" });
assert.ok(repaired.success, "junk in a defaulted field must not reject the row");
assert.equal(repaired.data.star_count, 0, "junk must fall back to the default");

// --- declared tool pricing --------------------------------------------------
//
// Agents put their price in the tool description and nowhere else: Sentinels
// Audit ships "Free." and "Paid (0.2 BNB on BSC)". 8004scan carries no price
// field at all, so reading this is the only way a buyer sees the number
// before committing. Reported as declared, never as verified.

const paid = readTool({
  name: "sentinels_ai_audit_contract",
  description: "Paid (0.2 BNB on BSC). Run SmartSentinels Sentinels AI smart-contract security audit.",
})!;
assert.deepEqual(paid.declaredPrice, { amount: "0.2", token: "BNB" }, "a stated price must be read");
assert.equal(paid.declaredFree, false, "a priced tool is not free");

const free = readTool({ name: "sentinels_ai_audit_info", description: "Free. Returns pricing." })!;
assert.equal(free.declaredFree, true, "a tool that says free must read as free");
assert.equal(free.declaredPrice, null, "a free tool states no price");

// A description mentioning both must not be sold as free.
const both = readTool({ name: "x", description: "Free tier available, then 5 USDT per call." })!;
assert.equal(both.declaredFree, false, "a price anywhere beats the word free");
assert.deepEqual(both.declaredPrice, { amount: "5", token: "USDT" });

// Silence is silence: most agents state nothing, and inventing "free" for
// them would be the exact unearned confidence this listing exists to strip.
const quiet = readTool({ name: "borrow", description: "Borrow an asset from Venus." })!;
assert.equal(quiet.declaredPrice, null, "no price stated means no price shown");
assert.equal(quiet.declaredFree, false, "no statement is not a claim of free");

assert.equal(readTool({ description: "no name" }), null, "a nameless tool is not a tool");
assert.equal(readTool(null), null, "junk must not throw");

// --- advantage report verdicts ----------------------------------------------
//
// The report is the evidence TermiX scores 30% on, so a sentence in it has to
// be a measurement. `verdictFor` never consulted `ok`, so a call that errored
// arrived with coverage 0 and came out as "the agent returned fewer, hiring
// loses on both axes" — a confident claim about a named agent describing a
// request that never completed. Observed for real when a response cap broke
// the Aster call.

function run(over: Partial<TaskResult["hired"]> = {}): TaskResult["hired"] {
  return {
    path: "hired",
    label: "x",
    ms: 100,
    spread: "100-100",
    ok: true,
    output: "{}",
    costUsd: 0,
    coverage: { count: 10, unit: "markets" },
    ...over,
  };
}
const task = (hired: TaskResult["hired"], manual: TaskResult["manual"]): TaskResult => ({
  id: "t",
  title: "t",
  category: "t",
  question: "t",
  hired,
  manual,
  verdict: "",
});

const failed = verdictFor(
  task(run({ ok: false, output: "blocked: response exceeded 1000000 bytes", coverage: { count: 0, unit: "markets" } }),
       { ...run(), path: "manual", coverage: { count: 567, unit: "markets" } }),
);
assert.match(failed, /^No verdict/, "a failed run must refuse to render a verdict");
assert.match(failed, /response exceeded/, "the failure reason must be carried, not hidden");
assert.doesNotMatch(failed, /Hiring loses|Hiring wins/, "a failure must never read as a measurement");

const manualFailed = verdictFor(task(run(), { ...run(), path: "manual", ok: false, output: "RPC down" }));
assert.match(manualFailed, /^No verdict/, "a failed manual path must also block the verdict");

// A clean run still produces a real comparison.
const wide = verdictFor(
  task(run({ coverage: { count: 14, unit: "vaults" } }),
       { ...run(), path: "manual", ms: 50, coverage: { count: 1, unit: "vaults" } }),
);
assert.match(wide, /Hiring wins/, "a genuine breadth advantage must still be reported");

// --- explorer links tolerate a chain we do not know -------------------------
//
// The ledger is a file a human can edit. A row naming an unfamiliar chain used
// to throw mid-render and take the control room down with it — including the
// revoke button, which is the safety control. Losing the brakes because a row
// looked odd is exactly backwards.

assert.equal(explorerTx(1, "0xabc"), null, "an unknown chain yields no tx link, not a throw");
assert.equal(explorerAddress(1, "0xabc"), null, "an unknown chain yields no address link");
assert.match(
  explorerTx(BSC_MAINNET, "0xabc") ?? "",
  /^https:\/\/bscscan\.com\/tx\/0xabc$/,
  "a known chain still links",
);
assert.match(
  explorerAddress(BSC_TESTNET, "0xdef") ?? "",
  /^https:\/\/testnet\.bscscan\.com\/address\/0xdef$/,
  "testnet links go to the testnet explorer",
);

// --- probe history ----------------------------------------------------------
//
// One reading says an agent answered once; this is what turns that into
// "answered 30 of 30 checks since Tuesday". Nothing in the ecosystem carries
// it, so the arithmetic had better be right.
//
// Runs against a scratch database: a self-check that writes into the real
// history would corrupt the thing it is checking.

// A fresh file every run. Reusing one let observations pile up across runs —
// the third pass counted twelve where it had inserted four, and a check that
// depends on its own leftovers is not a check.
const scratchDb = `${tmpdir()}/kawal-check-uptime.db`;
for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${scratchDb}${suffix}`, { force: true });
process.env.KAWAL_UPTIME_DB = scratchDb;

const { recordProbe, uptimeFor } = await import("../lib/uptime.ts");

const proof = (over: Record<string, unknown> = {}) => ({
  endpoint: "https://example.test/mcp",
  reachable: true,
  isMcp: true,
  serverName: "t",
  protocolVersion: "1",
  toolCount: 1,
  tools: [],
  descriptor: null,
  latencyMs: 100,
  error: null,
  checkedAt: new Date().toISOString(),
  ...over,
});

assert.equal(uptimeFor("https://nothing.test/mcp"), null, "an unobserved endpoint has no record");

for (const ms of [300, 100, 200]) recordProbe(proof({ latencyMs: ms }));
recordProbe(proof({ isMcp: false, latencyMs: 9000, error: "HTTP 502" }));

const up = uptimeFor("https://example.test/mcp")!;
assert.equal(up.checks, 4, "every observation counts");
assert.equal(up.answered, 3, "only the answering ones count as answered");
// The median must ignore the failure: a timeout's latency is the timeout, not
// the agent's speed, and mixing them flatters nothing and misleads everyone.
assert.equal(up.medianMs, 200, "median is taken over answering checks only");
assert.equal(up.worstMs, 300, "the slowest answering check is the tail worth seeing");

const dead = "https://down.test/mcp";
recordProbe(proof({ endpoint: dead, isMcp: false, latencyMs: 5000, error: "HTTP 502" }));
const downtime = uptimeFor(dead)!;
assert.equal(downtime.answered, 0, "an endpoint that never answered reports zero");
assert.equal(downtime.medianMs, null, "no answering checks means no median to quote");

// --- capability, separate from permission ----------------------------------
//
// An instance can hold the operator token and not the wallet key: a read-only
// deployment, or one where the key was never installed. Before this, the
// control room offered the unlock form, accepted the token, showed the revoke
// button, and turned the click into an uncaught throw. Permission without
// capability is a dead end dressed as a control.

const vault = await import("../lib/vault.ts");
const realKeyEnv = process.env.KAWAL_ADMIN_KEY;
delete process.env.KAWAL_ADMIN_KEY;
process.env.KAWAL_ADMIN_KEY_FILE = `${tmpdir()}/kawal-check-absent.key`;
rmSync(process.env.KAWAL_ADMIN_KEY_FILE, { force: true });

assert.equal(vault.hasAdminKey(), false, "a missing key file means no capability");
assert.throws(
  () => vault.adminKey(),
  vault.MissingAdminKeyError,
  "asking for an absent key must raise a typed error, not a bare one",
);

// The environment variable is the deployment path and must win over the file.
process.env.KAWAL_ADMIN_KEY = "0xdeadbeef";
assert.equal(vault.hasAdminKey(), true, "an env-provided key is a key");
assert.equal(vault.adminKey(), "0xdeadbeef", "the environment takes precedence over the file");

delete process.env.KAWAL_ADMIN_KEY;
delete process.env.KAWAL_ADMIN_KEY_FILE;
if (realKeyEnv) process.env.KAWAL_ADMIN_KEY = realKeyEnv;

// --- the ledger survives two writers and a crash --------------------------
//
// Two processes write this file: the control room's revoke action and the
// preempt script. Both did read-modify-write with no lock, and a demonstration
// left one seat where two were added. The scenario that matters: an operator
// clicks Revoke while `preempt --send` is running. The revoke lands on-chain
// and cannot be undone, but the ledger loses the record — so the page goes on
// showing a dead seat as live and the next click spends gas on a key that is
// already gone.

const ledgerScratch = `${tmpdir()}/kawal-check-ledger.json`;
for (const suffix of ["", ".lock", ".tmp"]) rmSync(`${ledgerScratch}${suffix}`, { force: true });
process.env.KAWAL_SESSION_FILE = ledgerScratch;

const ledgerVault = await import("../lib/vault.ts");
ledgerVault.writeLedger([]);

const seatFixture = (publicKey: string) =>
  ({ ...agent(), publicKey, seat: publicKey }) as unknown as Parameters<
    typeof ledgerVault.writeLedger
  >[0][number];

// Interleaved read-modify-write: each writer holds a snapshot across a pause.
// Without the lock the second overwrites the first.
const writeUnderLock = (tag: string) =>
  ledgerVault.withLedgerLock((seats) => {
    const snapshot = [...seats];
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    snapshot.push(seatFixture(tag));
    ledgerVault.writeLedger(snapshot);
  });

await Promise.all([
  Promise.resolve().then(() => writeUnderLock("first")),
  Promise.resolve().then(() => writeUnderLock("second")),
]);

assert.equal(ledgerVault.readLedger().length, 2, "both writers' changes must survive");

// The write must be all-or-nothing. A truncated ledger loses session private
// keys that exist nowhere else, leaving sessions live on-chain with nothing
// able to drive or revoke them.
assert.ok(
  !existsSync(`${ledgerScratch}.tmp`),
  "the temporary file must be renamed away, never left beside the real one",
);
assert.equal(
  JSON.parse(readFileSync(ledgerScratch, "utf8")).length,
  2,
  "the file on disk must parse — a half-written ledger is an unreadable one",
);

// A lock left by a process that died must age out, or one crash blocks every
// future write forever.
writeFileSync(`${ledgerScratch}.lock`, "");
const longAgo = new Date(Date.now() - 120_000);
utimesSync(`${ledgerScratch}.lock`, longAgo, longAgo);
assert.doesNotThrow(
  () => ledgerVault.withLedgerLock(() => undefined),
  "a stale lock must be broken, not obeyed forever",
);

for (const suffix of ["", ".lock", ".tmp"]) rmSync(`${ledgerScratch}${suffix}`, { force: true });
delete process.env.KAWAL_SESSION_FILE;


/* ---------------------------------------------------------------- x402 ---
 * The challenge parser, against fixtures rather than against whatever the
 * internet is serving today.
 *
 * This is the module that turns somebody else's JSON into a price shown to a
 * visitor, so the failures worth checking are the quiet ones: a 402 with no
 * payable option, an amount that arrived as a number, a body that is almost a
 * challenge. Reading a price wrong is worse than reading none.
 */

// The real thing, captured from q402.quackai.ai — the only live x402
// challenge reachable from an ERC-8004 registration at the time of writing.
const REAL = {
  x402Version: 2,
  error: "payment required: pay 0.02 USDC on Base via x402, then resend with a PAYMENT-SIGNATURE header",
  resource: { serviceName: "Quack AI" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "20000",
      payTo: "0x9bbbb98e11e7be968bf4a02701c6e29fffd51d6b",
      maxTimeoutSeconds: 300,
    },
  ],
};

const read = readChallenge(REAL);
assert.ok(read, "a real challenge must parse");
assert.equal(read.x402Version, 2);
assert.equal(read.serviceName, "Quack AI");
assert.equal(read.accepts.length, 1);
assert.equal(read.accepts[0]?.amount, "20000", "atomic units are kept as written");
assert.equal(read.accepts[0]?.payTo, "0x9bbbb98e11e7be968bf4a02701c6e29fffd51d6b");
assert.match(read.quote ?? "", /0\.02 USDC on Base/, "the server's own sentence is quoted");

// A 402 that names no way to pay is a refusal, not a price. Rendering it as
// terms would show a visitor an empty payment table and imply a cost.
assert.equal(readChallenge({ x402Version: 2, accepts: [] }), null);
assert.equal(readChallenge({ x402Version: 2 }), null);
assert.equal(readChallenge(null), null);
assert.equal(readChallenge("402"), null);

// An option missing scheme or network cannot be acted on, and an option whose
// amount is a number rather than a string is still an amount.
assert.equal(
  readChallenge({ accepts: [{ network: "eip155:56", amount: "1" }] }),
  null,
  "an option with no scheme is not payable",
);
const numeric = readChallenge({ accepts: [{ scheme: "exact", network: "eip155:56", amount: 500 }] });
assert.equal(numeric?.accepts[0]?.amount, "500", "a numeric amount is normalised, not dropped");

// Mixed valid and invalid: keep what can be paid, drop what cannot, never
// invent the difference.
const mixedOptions = readChallenge({
  accepts: [
    { scheme: "exact", network: "eip155:56", amount: "1" },
    { scheme: "exact" },
    { network: "eip155:8453", amount: "2" },
  ],
});
assert.equal(mixedOptions?.accepts.length, 1, "only the payable option survives");

// Kawal must never render a price it computed from decimals it does not have:
// a challenge carries atomic units and an asset address, and nothing in it
// says how many decimals that token uses.
const first = read.accepts[0];
assert.ok(first, "the real challenge has a payable option");
assert.deepEqual(
  Object.keys(first).sort(),
  ["amount", "asset", "maxTimeoutSeconds", "network", "payTo", "scheme"],
  "a parsed option carries what the server sent and nothing derived",
);

assert.equal(networkName("eip155:56"), "BNB Smart Chain");
assert.equal(networkName("eip155:8453"), "Base");
assert.equal(networkName("eip155:999999"), "eip155:999999", "an unknown chain is shown as written");

console.log("ok - taxonomy, signals, mandate, ssrf guard, memo, schemas, pricing, verdicts, links, uptime, vault and ledger, x402");
