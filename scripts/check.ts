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
  v5Rows,
  weakestV5,
} from "../lib/signals.ts";
import { errorsCleanly } from "../lib/mcp.ts";
import { readOasfRecord } from "../lib/probe.ts";
import { planMandate, preempt, UnsafeMandateError, VENUES, MAX_DURATION_DAYS } from "../lib/mandate.ts";
import { BSC_MAINNET, BSC_TESTNET } from "../lib/chains.ts";
import { readChallenge, networkName } from "../lib/x402.ts";
import { summarise, isTrackRecord, CAPTURED_SHARE } from "../lib/reputation.ts";
import { handleRpc, TOOLS, PROTOCOL_VERSION } from "../lib/server.mcp.ts";
import { diagnose, failureLabel } from "../lib/failure.ts";
import { challenge, PRICE_WEI, NETWORK } from "../lib/x402.terms.ts";
import { readAgentCard, a2aAnswered, canonicalize, b64url, fromB64url, utf8, cardPayload, verifyCardSignature } from "../lib/a2a.ts";
import { agentCard, handleA2a, signAgentCard } from "../lib/server.a2a.ts";
import { summariseMarket, formatU, JOB_STATUS, type MarketJob } from "../lib/erc8183.ts";
import { blocksPerDayBetween, annualise, fromRay, pct } from "../app/mandate/rates.ts";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { take, takeDurable, groupOf, resetForTests } from "../lib/ratelimit.ts";
import { buildFeedback, buildResponseTime, uptimePercent, windowDays, registryFor, MIN_OBSERVATIONS_TO_PUBLISH, KNOWN_DEFECTS, FEEDBACK_ABI } from "../lib/feedback.ts";
import { decodeFunctionData, keccak256, toHex, isAddress, getAddress, sha256 } from "viem";
import { registeredOn } from "../lib/unindexed.ts";
import { noteWrite } from "../lib/published.ts";
import { ScanAgentDetailSchema } from "../lib/scan.schema.ts";
import type { ScanAgent } from "../lib/scan.ts";
import { assertPublicUrl, BlockedUrlError } from "../lib/ssrf.ts";
import { memo, clearMemo, memoStats } from "../lib/memo.ts";
import { parseAgents, ScanAgentSchema } from "../lib/scan.schema.ts";
import { readTool } from "../lib/probe.ts";
import { verdictFor, winnerOf, type TaskResult } from "../lib/advantage.report.ts";
import { explorerTx, explorerAddress } from "../lib/altana.ts";
import { loginMessage, signable } from "../lib/scan.auth.ts";

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

/** A reputation reading with `n` records, `share` of them from one address. */
function summariseFor(n: number, share: number) {
  const top = Math.round(n * share);
  return summarise(
    Array.from({ length: n }, (_, i) => ({
      value: "100",
      user_address: i < top ? "0xAAA" : `0x${i.toString(16).padStart(3, "0")}`,
    })),
    n,
    "t",
  );
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

// --- Kawal's own measurements reach the ranking ------------------------------
//
// `rank` scored from the registry alone, so an agent Kawal had called eighty
// times and reached eighty times sat level with one it had never dialled. The
// terms are documented on `rank`; these pin the direction of each.

const proven = { checks: 20, answered: 20 };
const shaky = { checks: 20, answered: 10 };
assert.ok(
  rank(declared, assess(declared, undefined, proven), { observed: proven }) >
    rank(declared, assess(declared, undefined, shaky), { observed: shaky }),
  "an endpoint that always answers outranks one that answers half the time",
);
assert.equal(
  rank(declared, assess(declared, undefined, proven), { observed: { checks: 2, answered: 2 } }),
  rank(declared, assess(declared, undefined, proven)),
  "below the observation floor the answered term is zero, not a guess",
);
assert.equal(
  rank(declared, assess(declared, undefined, described), { observed: described }),
  rank(declared, assess(declared, undefined, described)),
  "a published non-HTTP route earns no uptime credit either way",
);
assert.ok(
  rank(declared, assess(declared), { uptime: { medianMs: 200 } }) >
    rank(declared, assess(declared), { uptime: { medianMs: 4_000 } }),
  "a faster median is worth a little",
);
assert.ok(
  rank(declared, assess(declared), { uptime: { medianMs: 200 } }) - rank(declared, assess(declared)) <= 50,
  "and only a little",
);
const fanRated = agent({ total_feedbacks: 40 });
const oneFan = summariseFor(40, 0.9);
const manyFans = summariseFor(40, 0.3);
assert.ok(
  rank(fanRated, assess(fanRated), { reputation: manyFans }) >
    rank(fanRated, assess(fanRated), { reputation: oneFan }),
  "forty records from one address count for half of forty from many",
);

// 8004scan's risk flags. High and critical fail the signal and cost rank;
// low and medium are noted and cost nothing.
const flag = (severity: "low" | "medium" | "high" | "critical") => ({
  id: `f-${severity}`,
  severity,
  category: "security",
  title: `${severity} flag`,
  description: "",
  source: "8004scan",
});
const clean = assess(declared, undefined, undefined, undefined, undefined, { risk_flags: [] });
const noted = assess(declared, undefined, undefined, undefined, undefined, { risk_flags: [flag("medium")] });
const serious = assess(declared, undefined, undefined, undefined, undefined, { risk_flags: [flag("high"), flag("critical")] });
assert.equal(assess(declared).signals.find((s) => s.key === "flagged"), undefined, "unread, no flag row is shown");
assert.equal(clean.signals.find((s) => s.key === "flagged")?.pass, true);
assert.equal(noted.signals.find((s) => s.key === "flagged")?.pass, true, "a medium flag is noted, not failed");
assert.match(noted.signals.find((s) => s.key === "flagged")!.detail, /1 low or medium flag/);
assert.equal(serious.signals.find((s) => s.key === "flagged")?.pass, false);
assert.equal(serious.flagged, 2);
assert.ok(rank(declared, clean) > rank(declared, serious), "serious flags cost rank");
assert.equal(rank(declared, clean), rank(declared, noted), "mild ones do not");
assert.equal(serious.tier, "hireable", "flags inform the ranking, not the tier");

// The observed signal carries its evidence count for the stamp.
assert.equal(
  assess(declared, undefined, proven).signals.find((s) => s.key === "observed")?.evidence,
  20,
  "the observed row says how many calls it rests on",
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

// --- the marker on /advantage must agree with the sentence under it ---------
//
// The page marks a winner beside each row. Its first draft scored that
// independently — "whoever covered more" — which matched the prose on the
// numbers of the day and diverged the moment coverage was level: the verdict
// read "Hiring is the better default here" while the row marked the manual
// path as the winner. One rule now, asserted on the case that split them.

const breadth = task(run({ coverage: { count: 14, unit: "vaults" } }),
                     { ...run(), path: "manual", ms: 50, coverage: { count: 1, unit: "vaults" } });
assert.equal(winnerOf(breadth), "hired", "a wide coverage gap goes to the agent");

const shortfall = task(run({ coverage: { count: 1, unit: "markets" } }),
                       { ...run(), path: "manual", coverage: { count: 567, unit: "markets" } });
assert.equal(winnerOf(shortfall), "manual", "returning far less loses regardless of the clock");

// Coverage level, agent faster. The old page rule called this for the manual
// path; the verdict has always called it for the agent.
const fastAgent = task(run({ ms: 40 }), { ...run(), path: "manual", ms: 200 });
assert.equal(winnerOf(fastAgent), "hired", "level coverage is decided by the clock");
assert.match(verdictFor(fastAgent), /Hiring is the better default/, "and the prose says the same");

const fastManual = task(run({ ms: 900 }), { ...run(), path: "manual", ms: 100 });
assert.equal(winnerOf(fastManual), "manual", "level coverage, slower agent, manual wins");
assert.match(verdictFor(fastManual), /convenience, not information/, "and the prose says the same");

assert.equal(winnerOf(task(run({ ok: false }), run())), "none", "a failed run has no winner to mark");

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

const { recordProbe, uptimeFor, observedTotals, resetUptimeForTests } = await import("../lib/uptime.ts");
// The store layer caches opened stores by path and the uptime module caches
// its own handle; both must forget anything opened before the redirect.
(await import("../lib/db.ts")).resetStoresForTests();
resetUptimeForTests();

const proof = (over: Record<string, unknown> = {}) => ({
  endpoint: "https://example.test/mcp",
  protocol: "mcp" as const,
  reachable: true,
  answered: true,
  isMcp: true,
  a2a: null,
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

assert.equal(await uptimeFor("https://nothing.test/mcp"), null, "an unobserved endpoint has no record");

for (const ms of [300, 100, 200]) await recordProbe(proof({ latencyMs: ms }));
await recordProbe(proof({ answered: false, isMcp: false, latencyMs: 9000, error: "HTTP 502" }));

const up = (await uptimeFor("https://example.test/mcp"))!;
assert.equal(up.checks, 4, "every observation counts");
assert.equal(up.answered, 3, "only the answering ones count as answered");
// The median must ignore the failure: a timeout's latency is the timeout, not
// the agent's speed, and mixing them flatters nothing and misleads everyone.
assert.equal(up.medianMs, 200, "median is taken over answering checks only");
assert.equal(up.worstMs, 300, "the slowest answering check is the tail worth seeing");

const dead = "https://down.test/mcp";
await recordProbe(proof({ endpoint: dead, answered: false, isMcp: false, latencyMs: 5000, error: "HTTP 502" }));
const downtime = (await uptimeFor(dead))!;
assert.equal(downtime.answered, 0, "an endpoint that never answered reports zero");
assert.equal(downtime.medianMs, null, "no answering checks means no median to quote");

// The home page band counts endpoints, not rows. `SUM(is_mcp)` would read 3
// here — the three answering probes of one agent — and report more agents
// answering than Kawal has ever called.
const totals = (await observedTotals())!;
assert.equal(totals.checks, 5, "every probe kept, across all endpoints");
assert.equal(totals.endpoints, 2, "two distinct endpoints were dialled");
assert.equal(totals.answered, 1, "one of them ever answered; rows are not endpoints");

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

/* ---------------------------------------------------- reputation ---
 *
 * `assess` called any agent with total_feedbacks > 0 "rated" and printed the
 * registry's average beside it. Reading 1,200 BSC records from both ends of
 * the register found a mark on every one but only 53 addresses behind the lot,
 * one of which wrote 265 of the oldest 600 under the tag `get top 1 rank >`.
 * The thin part is who wrote them, not whether a number is there.
 * `npm run reputation` re-measures.
 */

const fb = (over: Record<string, unknown> = {}) => ({
  score: 80,
  value: "8000",
  value_decimals: 2,
  comment: "fine",
  is_revoked: false,
  user_address: "0xAAA",
  ...over,
});

const none = summarise([], 0, "t");
assert.equal(none.raters, 0, "no records, no writers");
assert.equal(none.topRaterShare, 0, "and no share to divide by zero over");
assert.equal(isTrackRecord(none), false, "nothing read is not a track record");

// A mark and 8004scan's normalised score are different fields, and the whole
// point of reading the records was noticing they disagree: every sampled BSC
// record carries a value, while 1,192 of 1,200 carry a null score. An earlier
// version of this keyed the signal off `score` and failed essentially every
// agent on the chain for a reason that had nothing to do with the agent.
const scoreless = summarise(
  [fb({ score: null }), fb({ score: null, user_address: "0xBBB" })],
  2,
  "t",
);
assert.equal(scoreless.scored, 0, "a null score is not a score");
assert.equal(scoreless.valued, 2, "but the mark on the record still counts");
assert.equal(isTrackRecord(scoreless), true, "and two marking addresses is a track record");

// Scientific notation is how these arrive as often as plain digits.
assert.equal(summarise([fb({ value: "1E+4" })], 1, "t").valued, 1, "1E+4 is a mark");
assert.equal(summarise([fb({ value: null })], 1, "t").valued, 0, "a null value is not");
assert.equal(summarise([fb({ value: "" })], 1, "t").valued, 0, "nor is an empty one");

// `Number()` is far too willing, and this is a trust boundary: these rows come
// from an API this project exists to distrust. A whitespace string, a stray
// boolean and an empty array all convert to finite numbers, so an earlier
// version counted each of them as a mark somebody had set — and `valued` is
// what decides whether an agent is shown as having a track record. Malformed
// data upstream would have promoted an agent here.
assert.equal(summarise([fb({ value: " " })], 1, "t").valued, 0, "whitespace is not a mark");
assert.equal(summarise([fb({ value: true })], 1, "t").valued, 0, "a boolean is not a mark");
assert.equal(summarise([fb({ value: [] })], 1, "t").valued, 0, "an array is not a mark");
assert.equal(summarise([fb({ value: {} })], 1, "t").valued, 0, "an object is not a mark");
assert.equal(summarise([fb({ value: "abc" })], 1, "t").valued, 0, "unparseable is not a mark");
assert.equal(summarise([fb({ value: "Infinity" })], 1, "t").valued, 0, "and neither is infinity");
assert.equal(summarise([fb({ value: 0 })], 1, "t").valued, 1, "but zero is a mark somebody set");

// A response carrying a total but no readable rows is a shape change upstream,
// not a verdict about an agent. `summarise` must report that it read nothing
// rather than letting `total` stand in for records it never saw.
const empty = summarise([], 500, "t");
assert.equal(empty.total, 500, "the registry's own count is carried verbatim");
assert.equal(empty.sampled, 0, "but nothing was read");
assert.equal(empty.valued, 0, "so nothing can be marked");
assert.equal(isTrackRecord(empty), false, "and a total alone is never a track record");

// Rows with no writer at all must not become a track record by default.
const anonymous = summarise([fb({ user_address: null }), fb({ user_address: null })], 2, "t");
assert.equal(anonymous.raters, 0, "no addresses, no writers");
assert.equal(anonymous.topRaterShare, 0, "and no share to compute");
assert.equal(isTrackRecord(anonymous), false, "marks nobody signed are not a record");

// Records with no mark at all cannot support a judgement.
const unmarked = summarise(
  [fb({ value: null }), fb({ value: null, user_address: "0xBBB" })],
  2,
  "t",
);
assert.equal(unmarked.valued, 0, "nothing marked");
assert.equal(unmarked.raters, 2, "though the writers still count");
assert.equal(isTrackRecord(unmarked), false, "and an unmarked pile is not a record");

// Addresses differing only in case are one writer. Counting them as two would
// report capture as diversity, which is the error that flatters.
const cased = summarise([fb({ user_address: "0xAbC" }), fb({ user_address: "0xabc" })], 2, "t");
assert.equal(cased.raters, 1, "one wallet in two casings is one writer");
assert.equal(cased.topRaterShare, 1, "and it wrote everything");
assert.equal(isTrackRecord(cased), false, "one address is not a market");

// An empty comment string is not a comment.
assert.equal(summarise([fb({ comment: "   " })], 1, "t").commented, 0, "whitespace is not a comment");

// Withdrawn records are read, not dropped: hiding them would silently improve
// every agent whose reviewer took it back.
const withdrawn = summarise([fb({ is_revoked: true }), fb({ user_address: "0xBBB" })], 2, "t");
assert.equal(withdrawn.revoked, 1, "a withdrawal is counted");
assert.equal(withdrawn.sampled, 2, "and still counted as read");

// The concentration line, exercised either side.
const captured = summarise(
  [fb(), fb(), fb(), fb({ user_address: "0xBBB" })],
  4,
  "t",
);
assert.equal(captured.topRaterShare, 0.75, "three of four from one address");
assert.ok(captured.topRaterShare >= CAPTURED_SHARE, "which is over the line");
assert.equal(isTrackRecord(captured), false, "so it describes the writer, not the agent");

const spread = summarise(
  [fb(), fb({ user_address: "0xBBB" }), fb({ user_address: "0xCCC" })],
  3,
  "t",
);
assert.ok(spread.topRaterShare < CAPTURED_SHARE, "an even spread stays under the line");
assert.equal(isTrackRecord(spread), true, "several scoring addresses is a track record");

// And the signal follows the reading rather than the count. The registration
// below claims 40 feedbacks and a 4.8 average either way.
const boasting = agent({ total_feedbacks: 40, average_score: 4.8 });
const rowOf = (a: typeof boasting, r?: Parameters<typeof assess>[4]) =>
  assess(a, undefined, undefined, undefined, r).signals.find((x) => x.key === "rated")!;

assert.equal(rowOf(boasting).pass, true, "unread, the registry's count stands");
assert.match(rowOf(boasting).detail, /records not read here/, "but it must not read as verified");
assert.equal(rowOf(boasting, unmarked).pass, false, "read and unmarked is a failed signal");
assert.match(rowOf(boasting, unmarked).detail, /nothing to judge on/);
assert.equal(rowOf(boasting, captured).pass, false, "read and captured is a failed signal");
assert.match(rowOf(boasting, captured).detail, /75% from one address/);
assert.equal(rowOf(boasting, spread).pass, true, "read and spread passes");
assert.match(rowOf(boasting, spread).detail, /from 3 addresses/);

/* ------------------------------------------------------ feedback ---
 *
 * The only bytes Kawal makes that cannot be edited afterwards. The shape was
 * read off a live GEBO record and decoded against the registry ABI; these
 * assertions hold the builder to it, because being wrong here is a permanent
 * record on a public registry with our name on it rather than a bad render.
 */

const measured = {
  chainId: BSC_MAINNET,
  agentId: "43970",
  endpoint: "https://example.test/mcp",
  protocol: "mcp" as const,
  checks: 40,
  answered: 39,
  since: Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000),
  medianMs: 180,
};
const stamped = new Date("2026-08-27T00:00:00Z");
const built = buildFeedback(measured, stamped);

// The hash covers the payload bytes, not the data: URI that carries them. A
// live GEBO record hashes the decoded JSON, and getting this backwards writes
// a record no indexer can verify.
assert.equal(built.hash, keccak256(toHex(built.payload)), "the hash is taken over the payload");
assert.notEqual(built.hash, keccak256(toHex(built.uri)), "and not over the URI wrapper");
assert.ok(built.uri.startsWith("data:application/json;base64,"), "the URI is a self-carrying payload");
assert.equal(
  Buffer.from(built.uri.slice("data:application/json;base64,".length), "base64").toString("utf8"),
  built.payload,
  "and decodes back to exactly the bytes that were hashed",
);

// The calldata must decode to what the printout claimed, through the same ABI.
const decoded = decodeFunctionData({ abi: FEEDBACK_ABI, data: built.data });
assert.equal(decoded.functionName, "giveFeedback");
const [dAgent, dValue, dDecimals, dTag1, dTag2, dEndpoint, dUri, dHash] = decoded.args;
assert.equal(dAgent, 43970n, "the agent id survives the round trip");
assert.equal(dValue, 9750n, "39 of 40 is 97.50%, carried at two decimals");
assert.equal(dDecimals, 2);
assert.equal(dTag1, "uptime");
assert.equal(dTag2, "26d", "the window is the measured span, not a fixed label");
assert.equal(dEndpoint, measured.endpoint);
assert.equal(dUri, built.uri);
assert.equal(dHash, built.hash, "the hash in the calldata is the one over the payload");

// The defects travel with the number. A reliability figure outlives its
// caveats unless they are in the record itself.
const parsed = JSON.parse(built.payload);
assert.deepEqual(parsed.method.knownDefects, KNOWN_DEFECTS, "every record states its blind spots");
assert.match(parsed.reasoning, /97\.50%/, "the reasoning quotes the figure it published");
assert.equal(parsed.agentRegistry, `eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`);

// The registry address must be a valid EIP-55 checksum, because viem checks
// it at send time and nothing earlier does. A hand-typed version of this
// constant was wrong in several letters; every dry run passed, and the first
// real send would have thrown on record one.
const registry = registryFor(BSC_MAINNET);
assert.ok(isAddress(registry, { strict: true }), "the registry address carries a valid checksum");
assert.equal(registry, getAddress("0x8004baa17c55a88189ae136b182e5fda19de9b63"), "and is the ERC-8004 Reputation Registry on BSC");
assert.equal(built.to, registry, "which is where the record is sent");

// A thin sample must not become a permanent claim.
assert.throws(
  () => buildFeedback({ ...measured, checks: MIN_OBSERVATIONS_TO_PUBLISH - 1 }, stamped),
  /refusing to publish/,
  "below the floor, nothing is built at all",
);

// Nor must an impossible one. 30 answered of 10 checks encoded cleanly into a
// record claiming 300% uptime — permanent, on a public registry, with our name
// on it. It refuses rather than clamping: clamping would publish 100% about an
// agent whose real figure is unknown, which is a confident lie where this is an
// honest halt.
assert.throws(
  () => buildFeedback({ ...measured, checks: 10, answered: 30 }, stamped),
  /not consistent/,
  "more answers than checks is corrupt history, not a 300% agent",
);
assert.throws(
  () => buildFeedback({ ...measured, answered: -1 }, stamped),
  /not consistent/,
  "and neither is a negative count",
);

// A token id that is not a number reached BigInt() and surfaced as a bare
// SyntaxError naming no agent. The publisher writes about other people's
// agents, so a refusal has to say which one.
assert.throws(
  () => buildFeedback({ ...measured, agentId: "43970x" }, stamped),
  /not a token id/,
  "a malformed agent id is refused by name",
);

// Zero uptime is a real measurement and must stay publishable: refusing to
// write the bad news would make the good news worthless.
const neverAnswered = buildFeedback({ ...measured, answered: 0 }, stamped);
assert.equal(neverAnswered.percent, 0, "nothing answered is nought per cent");
assert.match(neverAnswered.payload, /"value":"0"/, "and it is written as such");

assert.equal(uptimePercent({ checks: 0, answered: 0 }), 0, "no probes is not a division");
assert.equal(uptimePercent({ checks: 3, answered: 1 }), 33.33, "rounded to the published precision");
assert.equal(windowDays(stamped.getTime() / 1000, stamped.getTime() / 1000), 1, "a window is never zero days");

/* ---------------------------------------------------- mcp server ---
 *
 * Kawal answers over MCP so agents can ask it things, which means it now has
 * an unauthenticated public endpoint that makes outbound requests. The
 * protocol handling is checked here rather than only against a running server:
 * a transport bug is a bug in the one surface that has no browser in front of
 * it to make the failure obvious.
 */

type RpcBody = {
  result?: Record<string, unknown> & {
    tools?: Array<Record<string, unknown>>;
    serverInfo?: { name?: string };
    capabilities?: { tools?: unknown };
    protocolVersion?: string;
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  error?: { code?: number; message?: string };
};

const rpc = (method: string, params?: unknown, id: unknown = 1) =>
  handleRpc({ jsonrpc: "2.0", id, method, params });

/** The envelope, named once, so these assertions are not eight casts. */
const envelope = (r: { body: unknown }) => (r.body ?? {}) as RpcBody;

const handshake = await rpc("initialize");
assert.equal(handshake.status, 200);
const initResult = envelope(handshake).result!;
assert.equal(initResult.protocolVersion, PROTOCOL_VERSION, "the handshake names a revision");
assert.equal(initResult.serverInfo?.name, "kawal");
assert.ok(initResult.capabilities?.tools, "and declares the tools capability");

const listed = await rpc("tools/list");
const tools = envelope(listed).result!.tools!;
assert.equal(tools.length, TOOLS.length, "every tool is listed");
for (const t of tools) {
  assert.ok(typeof t.name === "string" && t.name.length > 0, "a tool has a name");
  assert.ok(String(t.description).length > 40, `${String(t.name)} explains itself`);
  assert.equal((t.inputSchema as Record<string, unknown>).type, "object", `${String(t.name)} takes an object`);
}

// The security invariant, asserted rather than remembered.
//
// This endpoint is public, unauthenticated, and fetches on the caller's
// behalf. A tool that accepted a URL would make it an open proxy with a
// server-side fetch behind it. Callers name an agent and the endpoint dialled
// is the one the registry published, so this must stay true as tools are
// added.
for (const t of TOOLS) {
  const properties = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const key of Object.keys(properties)) {
    assert.doesNotMatch(
      key,
      /url|uri|endpoint|host|address/i,
      `tool ${t.name} must not accept ${key}: a public fetcher that takes a location is an open proxy`,
    );
  }
}

// A notification has no id and must get no body: answering one leaves a
// well-behaved client waiting for a reply to a statement.
const notified = await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
assert.equal(notified.status, 202, "a notification is accepted");
assert.equal(notified.body, null, "and answered with nothing at all");

// Unknown methods and unknown tools are told apart: one is a protocol fault,
// the other is a question about something that does not exist.
const unknownMethod = await rpc("kawal/nonsense");
assert.equal(envelope(unknownMethod).error?.code, -32601);
// resources/list is a real method now: the static documents an agent reads once.
const resources = envelope(await rpc("resources/list")).result as { resources: Array<{ uri: string }> };
assert.ok(resources.resources.some((r) => r.uri === "kawal://taxonomy"), "the taxonomy is a readable resource");

const unknownTool = await rpc("tools/call", { name: "drop_tables", arguments: {} });
assert.equal(envelope(unknownTool).error?.code, -32601, "an unknown tool is not found");

const malformed = await handleRpc("not an object");
assert.equal(malformed.status, 400, "a non-object body is a parse error");

const noMethod = await handleRpc({ jsonrpc: "2.0", id: 9 });
assert.equal(envelope(noMethod).error?.code, -32600, "a message with no method is invalid");

// Bad arguments come back as a tool result, not a transport fault: the caller
// asked a valid question and is owed the reason it could not be answered.
// These run offline because validation happens before any network call.
const badChain = await rpc("tools/call", { name: "verify_agent", arguments: { chainId: 1, tokenId: "1" } });
const badChainResult = envelope(badChain).result!;
assert.equal(badChain.status, 200, "a rejected argument is still a successful exchange");
assert.equal(badChainResult.isError, true, "but the result says it failed");
assert.match(badChainResult.content![0]!.text!, /chainId must be one of/);

for (const tokenId of ["", "abc", "12x", "../../etc", "1e5"]) {
  const bad = await rpc("tools/call", { name: "verify_agent", arguments: { tokenId } });
  const result = envelope(bad).result!;
  assert.equal(result.isError, true, `token id ${JSON.stringify(tokenId)} is refused`);
  assert.match(result.content![0]!.text!, /decimal token id/);
}

const emptyQuery = await rpc("tools/call", { name: "find_agents", arguments: { query: "   " } });
assert.equal(envelope(emptyQuery).result?.isError, true, "an empty search is refused");

/* ------------------------------------------------ failure kinds ---
 *
 * "Does not answer" was one word covering four situations. Kawal's own log:
 * 62 probes could not resolve a domain, 61 got `agent not found` from a host
 * that was plainly alive, 38 got a Cloudflare 502, and a handful timed out.
 * A vanished domain is an abandonment; a 502 is a bad afternoon; the 404 is a
 * deregistration ERC-8004 has no way to record. Collapsing them loses the
 * only part a buyer can act on.
 */

assert.equal(diagnose(null), null, "no error, no diagnosis");
assert.equal(diagnose(""), null, "and an empty one is not a failure either");

const gone = diagnose("blocked: could not resolve syenite.ai")!;
assert.equal(gone.failure, "gone", "a dead domain is an abandonment");
assert.equal(gone.transient, false, "waiting will not help");
// The message is both a guard string and a DNS failure. The DNS reading is
// the one worth showing: the guard did not refuse on policy, it could not
// find the host.
assert.notEqual(gone.failure, "blocked", "a resolve failure is not a policy refusal");

const delisted = diagnose('HTTP 404: {"error":"agent not found"}')!;
assert.equal(delisted.failure, "delisted", "a host that disowns an agent is not merely down");
assert.match(delisted.summary, /deregistration/, "and the reason is named");

const down = diagnose("HTTP 502: cloudflare error")!;
assert.equal(down.failure, "down");
assert.equal(down.transient, true, "an origin error may pass later");

assert.equal(diagnose("HTTP 405: ")!.failure, "refusing", "a 4xx that is not 404 is a refusal");
assert.equal(diagnose("HTTP 410: gone")!.failure, "delisted", "410 is as final as 404");
// Three spellings of one event, all named the same and given their deadline
// where the message carries one — a page used to print the raw text.
assert.equal(diagnose("timed out after 6000ms")!.failure, "timeout");
assert.equal(diagnose("timed out after 6000ms")!.transient, true);
assert.match(diagnose("timed out after 6000ms")!.summary, /within 6 s/);
assert.equal(diagnose("The operation was aborted due to timeout")!.failure, "timeout", "a TimeoutError is a timeout");
assert.equal(diagnose("This operation was aborted")!.failure, "timeout", "and so is a bare AbortError");
assert.match(diagnose("This operation was aborted")!.summary, /before the deadline/, "with no figure to quote");
assert.equal(diagnose("blocked: refusing 127.0.0.1: loopback 127.0.0.0/8")!.failure, "blocked");

// Anything unrecognised must say so rather than be filed under a guess.
const odd = diagnose("the socket did something unusual")!;
assert.equal(odd.failure, "unknown");
assert.equal(odd.raw, "the socket did something unusual", "and the original text is always carried");
for (const f of ["gone", "delisted", "down", "refusing", "timeout", "blocked", "unknown"] as const) {
  assert.ok(failureLabel(f).length > 0, `${f} has a label a person can read`);
}

/* ------------------------------------------------------- charging ---
 *
 * Kawal measured that 75 of 200 BSC registrations declare x402 support and
 * that no reachable claimant ever issues a challenge. `/api/report` is the
 * counter-example, which only means anything if Kawal's own reader can read
 * it: a payment claim this project cannot verify is precisely what it refuses
 * to publish about anybody else.
 */

const offered = challenge("0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92");

// Through the reader written against a live q402 challenge, not against a spec.
const readBack = readChallenge(offered);
assert.notEqual(readBack, null, "Kawal's own challenge survives Kawal's own reader");
assert.equal(readBack!.accepts.length, 1, "with exactly one way to pay");
assert.equal(readBack!.accepts[0]!.amount, PRICE_WEI.toString(), "quoted in atomic units");
assert.equal(readBack!.accepts[0]!.network, NETWORK, "on the chain it says");
assert.equal(readBack!.serviceName, "Kawal deep report");
assert.match(readBack!.quote ?? "", /X-PAYMENT/, "and the quote says how to pay it");

// The same document must survive the header carrier, which is what a proxy
// acts on without reading a body.
const viaHeader = readChallenge(
  JSON.parse(Buffer.from(JSON.stringify(offered), "utf8").toString("base64") === ""
    ? "{}"
    : Buffer.from(Buffer.from(JSON.stringify(offered), "utf8").toString("base64"), "base64").toString("utf8")),
);
assert.notEqual(viaHeader, null, "base64 round trip changes nothing");
assert.equal(viaHeader!.accepts[0]!.payTo, offered.accepts[0]!.payTo);

// The address is never invented. `challenge` renders what it is handed, and
// the caller supplies an address derived from a key this instance holds.
assert.equal(offered.accepts[0]!.payTo, "0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92");
assert.ok(PRICE_WEI > 0n, "a price of nothing is not a price");

// And the paid tool is advertised rather than hidden: a caller is entitled to
// know what exists and what it costs before being refused.
const paidTool = TOOLS.find((t) => t.name === "deep_report");
assert.ok(paidTool, "the paid tool is listed with the free ones");
assert.match(paidTool!.description, /costs money/, "and says so in its description");

/* ------------------------------------------------------------ a2a ---
 *
 * The prober spoke MCP and nothing else, which left 46 of 114 listed agents
 * unverifiable. These fixtures are the shapes read off live BSC registrations
 * before the reader was written, not the specification's examples.
 */

// A card as BORT serves it, trimmed.
const bortCard = {
  name: "BORT Agent",
  description: "Autonomous on-chain agents on BNB Smart Chain.",
  url: "https://api.bortagent.xyz/api/a2a",
  provider: { organization: "BORT", url: "https://bortagent.xyz" },
  version: "1.0.0",
  capabilities: { streaming: false, x402: true },
  protocolVersion: "0.3.0",
  preferredTransport: "JSONRPC",
  skills: [
    { id: "trade", name: "On-chain trading", description: "Buy and sell tokens.", tags: ["trading"] },
    { id: "market-data", name: "Live market data", description: "Prices for 0.01 BNB per call." },
  ],
};
const bort = readAgentCard(bortCard)!;
assert.ok(bort, "a real card parses");
assert.equal(bort.url, "https://api.bortagent.xyz/api/a2a", "the JSON-RPC url is read off the card");
assert.equal(bort.skills.length, 2);
assert.equal(bort.declaresX402, true, "the capabilities block is read");
assert.equal(bort.provider, "BORT");
assert.equal(bort.skills[1]!.tags.length, 0, "missing tags is an empty list, not a crash");

// The nip.io seller: no url field at all, skills with every field present.
const sellerCard = {
  capabilities: { streaming: false },
  name: "bnbLpRangeRebalancer-agent",
  protocolVersion: "0.3.0",
  skills: [{ id: "negotiate", name: "Negotiate an ERC-8183 job", description: "x", tags: ["erc8183"] }],
};
const seller = readAgentCard(sellerCard)!;
assert.equal(seller.url, null, "no url means the declared endpoint is the server");
assert.equal(seller.provider, null);

// What brainonbnb serves on GET /a2a: a worked example, not a card. Its
// skills are strings and it has no name. It is a live A2A server all the
// same, which is why the prober asks the URL directly when the card fails.
assert.equal(readAgentCard({ endpoint: "A2A JSON-RPC", skills: ["list", "negotiate"] }), null, "a description is not a card");
assert.equal(readAgentCard({ name: "x" }), null, "no skills array, no card");
assert.equal(readAgentCard({ name: "", skills: [] }), null, "an empty name is no name");
assert.equal(readAgentCard("card"), null);
assert.equal(readAgentCard({ name: "x", skills: [{ id: "a" }, "junk", { nope: 1 }] })!.skills.length, 1, "malformed skills are dropped, not fatal");
assert.equal(readAgentCard({ name: "x", skills: [], url: "ftp://nope" })!.url, null, "a non-http url is not a server to dial");

// What counts as answering. A card is a description; the JSON-RPC side is
// the heartbeat. A static card in front of a dead server must not pass.
const a2a = (over: Record<string, unknown>) => ({
  endpoint: "https://x.test/.well-known/agent-card.json",
  card: bort, rpcUrl: bort.url, rpc: "answered" as const, rpcStatus: 200, latencyMs: 1, error: null,
  ...over,
});
assert.equal(a2aAnswered(a2a({})), true, "card + JSON-RPC envelope answers");
assert.equal(a2aAnswered(a2a({ rpc: "gated", rpcStatus: 401 })), true, "card + 401 is a live server wanting credentials");
assert.equal(a2aAnswered(a2a({ rpc: "silent", rpcStatus: 0 })), false, "card over a silent server is not an answer");
assert.equal(a2aAnswered(a2a({ rpc: "not-json-rpc" })), false, "card over something that is not JSON-RPC is not an answer");
assert.equal(a2aAnswered(a2a({ card: null, rpc: "answered" })), true, "no card, but JSON-RPC answered: the bare-endpoint shape");
assert.equal(a2aAnswered(a2a({ card: null, rpc: "gated", rpcStatus: 401 })), false, "no card and a 401 proves nothing about what is there");

/* --------------------------------------------------- a2a server ---
 *
 * Kawal's own card and JSON-RPC surface, read with the same code Kawal
 * points at everybody else. A card Kawal could not verify would be the claim
 * it refuses to make about anyone.
 */

const ours = readAgentCard(agentCard("https://kawal.test"))!;
assert.ok(ours, "Kawal's card parses with Kawal's reader");
assert.equal(ours.url, "https://kawal.test/api/a2a", "and names the endpoint on the origin it was served from");
assert.equal(ours.protocolVersion, "0.3.0");
assert.equal(ours.skills.length, TOOLS.length, "every MCP tool is an A2A skill \u2014 same code, second door");
assert.ok(ours.skills.some((s) => s.id === "verify_agent"));

const a2aRpc = (method: string, params?: unknown, id: unknown = 1) =>
  handleA2a({ jsonrpc: "2.0", id, method, params });
const a2aBody = (r: { body: unknown }) => (r.body ?? {}) as RpcBody;

assert.equal((await handleA2a({ jsonrpc: "2.0", method: "message/send" })).status, 202, "a notification gets no body");
assert.equal((await handleA2a("nope")).status, 400);
assert.equal(a2aBody(await a2aRpc("tasks/get", { id: "kawal-liveness-probe" })).error?.code, -32001, "the harmless question gets the answer the spec names");
assert.equal(a2aBody(await a2aRpc("message/stream", {})).error?.code, -32602, "a stream with no message is an invalid-params fault, not an unsupported operation: streaming is real now");
assert.equal(a2aBody(await a2aRpc("agent/getAuthenticatedExtendedCard")).error?.code, -32007);
assert.equal(a2aBody(await a2aRpc("tasks/pushNotificationConfig/set", {})).error?.code, -32004);
assert.equal(a2aBody(await a2aRpc("nonsense/method")).error?.code, -32601);

const noParts = await a2aRpc("message/send", { message: { role: "user" } });
assert.equal(a2aBody(noParts).error?.code, -32602, "a message with no parts is invalid params");

const unknownSkill = await a2aRpc("message/send", {
  message: { role: "user", messageId: "m", parts: [{ kind: "data", data: { skill: "drop_tables" } }] },
});
assert.equal(a2aBody(unknownSkill).error?.code, -32602, "an unknown skill is invalid params, not a crash");

// Validation runs before any network call, so this stays offline.
const badToken = await a2aRpc("message/send", {
  message: { role: "user", messageId: "m", parts: [{ kind: "data", data: { skill: "verify_agent", tokenId: "../etc" } }] },
});
assert.equal(a2aBody(badToken).error?.code, -32602, "a refused argument is the caller's, and says so");
assert.match(a2aBody(badToken).error?.message ?? "", /decimal token id/);

const emptyText = await a2aRpc("message/send", {
  message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "   " }] },
});
assert.equal(a2aBody(emptyText).error?.code, -32602, "blank text carries no request");

/* ------------------------------------------------------ rate limit ---
 *
 * The endpoints that fetch on a caller's behalf are an amplifier without a
 * ceiling. Time is a parameter so this checks refill without waiting.
 */

resetForTests();
const limit = { capacity: 3, perSecond: 1 };
const t0 = 1_000_000;
assert.equal(take("a", limit, t0).ok, true);
assert.equal(take("a", limit, t0).ok, true);
assert.equal(take("a", limit, t0).ok, true, "the burst is the capacity");
const denied = take("a", limit, t0);
assert.equal(denied.ok, false, "and one more is refused");
assert.ok(!denied.ok && denied.retryAfterSeconds >= 1, "with a real wait, never zero");
assert.equal(take("b", limit, t0).ok, true, "another caller has their own bucket");
assert.equal(take("a", limit, t0 + 1_000).ok, true, "a second later one token is back");
assert.equal(take("a", limit, t0 + 1_000).ok, false, "and only one");
assert.equal(take("a", limit, t0 + 60_000).ok, true, "refill is capped at capacity, not unbounded");
assert.equal(take("a", limit, t0 + 60_000).ok, true);
assert.equal(take("a", limit, t0 + 60_000).ok, true);
assert.equal(take("a", limit, t0 + 60_000).ok, false, "three, not sixty");

assert.equal(groupOf("/api/mcp"), "api");
assert.equal(groupOf("/api/a2a"), "api");
assert.equal(groupOf("/api/report"), "api");
assert.equal(groupOf("/owner"), "owner");
assert.equal(groupOf("/agents/56/1"), "page", "an agent page dials an endpoint, so it is limited");
assert.equal(groupOf("/compare"), "page", "and so is a comparison");
assert.equal(groupOf("/agents"), null, "the listing reads memoised data and is not");
assert.equal(groupOf("/api/health"), null, "and neither is the health check a monitor polls");
// Without a shared database the durable path is the in-memory bucket, so
// the two must agree exactly — the tests above already pinned the arithmetic.
assert.equal(process.env.TURSO_DATABASE_URL, undefined, "this check runs without a shared database");
resetForTests();
assert.equal((await takeDurable("d", limit, t0)).ok, true);
assert.equal((await takeDurable("d", limit, t0)).ok, true);
assert.equal((await takeDurable("d", limit, t0)).ok, true);
assert.equal((await takeDurable("d", limit, t0)).ok, false, "the durable path is the same bucket locally");
resetForTests();

/* ------------------------------------------------ probe deepening ---
 *
 * The MCP probe now asks for a tool that cannot exist and records how the
 * server says no; the OASF probe reads whatever the endpoint serves. Both
 * readers are pure, so the shapes seen live are pinned here.
 */

assert.equal(errorsCleanly({ ok: false, ms: 1, status: 200, error: "Unknown tool", errorCode: -32602 }), true);
assert.equal(errorsCleanly({ ok: false, ms: 1, status: 200, error: "Method not found", errorCode: -32601 }), true);
assert.equal(errorsCleanly({ ok: true, ms: 1, status: 200, result: { isError: true, content: [] } }), true, "an isError result is a clean refusal");
assert.equal(errorsCleanly({ ok: true, ms: 1, status: 200, result: { content: [{ type: "text", text: "ran" }] } }), false, "a server that ran a tool that does not exist did not refuse");
assert.equal(errorsCleanly({ ok: false, ms: 1, status: 500, error: "HTTP 500: boom" }), false, "a 500 is falling over");
assert.equal(errorsCleanly({ ok: false, ms: 1, status: 0, error: "timed out after 6000ms" }), false, "a hang is not a refusal");

// Read live off BSC: an OASF record, an A2A card served as one, and things
// that are neither.
const oasfRecord = readOasfRecord({ oasf_version: "1.0.0", agent_id: "48995", name: "Synergix", protocols: { a2a: "enabled" } });
assert.equal(oasfRecord?.name, "Synergix");
assert.equal(oasfRecord?.version, "1.0.0", "the OASF version field wins");
assert.equal(oasfRecord?.skills.length, 0);
const cardAsOasf = readOasfRecord({ name: "ClawdMint", version: "1.2.0", capabilities: { streaming: true }, skills: [{ id: "chat", name: "Chat" }, "echo"] });
assert.equal(cardAsOasf?.version, "1.2.0");
assert.deepEqual(cardAsOasf?.skills.map((s) => s.name), ["Chat", "echo"], "skills read as objects or strings");
assert.equal(readOasfRecord({ skills: [] }), null, "no name, no agent");
assert.equal(readOasfRecord("Synergix"), null);
assert.equal(readOasfRecord([{ name: "x" }]), null, "a list is not a record");

/* ------------------------------------------------- signing in ---
 *
 * The admin key signs the text 8004scan sends back from `/auth/nonce`. The
 * builder is held to the shape read off the live server on 29 Aug 2026, and
 * the guard in front of the key must refuse anything that is not exactly
 * that shape naming this wallet and this nonce — a server that could get
 * arbitrary text signed would hold a signing oracle for the wallet.
 */

const liveNonce = "fbc413ee57752ba5c5155e8d0d2a30bd";
const liveGreeting =
  "Welcome to 8004scan!\n\nSign this message to authenticate your wallet.\n\n" +
  "Wallet: 0xc7f5cdc8dd028e0b9af2ca9d3891f135b23f4b92\nNonce: fbc413ee57752ba5c5155e8d0d2a30bd\n" +
  "Timestamp: 2026-08-29T01:07:35.844264+00:00\n\n" +
  "This signature will not trigger any blockchain transaction or cost any gas fees.";
const kawalWallet = "0xc7F5cdC8dd028E0b9aF2cA9d3891F135b23f4B92";

assert.equal(loginMessage(kawalWallet, liveNonce, "2026-08-29T01:07:35.844264+00:00"), liveGreeting, "the builder reproduces the live greeting byte for byte");
assert.equal(signable(liveGreeting, kawalWallet, liveNonce), true, "so the live greeting is signable for this wallet and nonce");
assert.equal(signable(liveGreeting, kawalWallet, "0000000000000000"), false, "not for a nonce we did not ask for");
assert.equal(signable(liveGreeting, "0x0000000000000000000000000000000000000001", liveNonce), false, "not for another wallet");
assert.equal(signable(liveGreeting + "\nApprove: everything", kawalWallet, liveNonce), false, "not with a line appended");
assert.equal(signable(liveGreeting.replace("Welcome to 8004scan!", "Welcome to 8004scan"), kawalWallet, liveNonce), false, "not with a character changed");
assert.equal(signable("", kawalWallet, liveNonce), false, "and never nothing");
assert.equal(signable("Timestamp: now", kawalWallet, liveNonce), false, "a timestamp line alone is not the greeting");

/* ------------------------------------------------- self-rating ---
 *
 * An address that is the agent — its wallet, its owner, or the address that
 * minted it — writing feedback about the agent is the agent grading itself.
 * Counted and named; never subtracted, so the reader sees it was done.
 */

const insiders = { agent_wallet: "0xWaLLeT", owner_address: "0xOwner", creator_address: "0xMinter" };
const selfGraded = summarise(
  [fb({ user_address: "0xwallet" }), fb({ user_address: "0xOWNER" }), fb({ user_address: "0xminter" }), fb({ user_address: "0xBBB" })],
  4,
  "t",
  insiders,
);
assert.equal(selfGraded.selfRated, 3, "wallet, owner and minter each count, whatever the case");
assert.deepEqual([...selfGraded.selfRaters].sort(), ["0xminter", "0xowner", "0xwallet"], "and are named, lowercased");
assert.equal(selfGraded.raters, 4, "they are still distinct writers for the concentration figure");
assert.equal(summarise([fb({ user_address: "0xBBB" })], 1, "t", insiders).selfRated, 0, "a stranger is not self-rating");
assert.equal(summarise([fb({ user_address: "0xBBB" })], 1, "t").selfRated, 0, "and without a registration to compare against, nothing is");
assert.deepEqual(summarise([fb()], 1, "t").selfRaters, [], "the list is present and empty rather than absent");
assert.equal(summarise([fb({ user_address: null })], 1, "t", { owner_address: "" }).selfRated, 0, "an empty owner matches no anonymous row");
const sameAddressThrice = summarise([fb({ user_address: "0xowner" }), fb({ user_address: "0xowner" })], 2, "t", { owner_address: "0xowner", agent_wallet: "0xowner" });
assert.equal(sameAddressThrice.selfRated, 2, "two records from the owner are two self-ratings");
assert.deepEqual(sameAddressThrice.selfRaters, ["0xowner"], "from one address, listed once");

/* ------------------------------------------------- evidence on IPFS ---
 *
 * A pinned record names a CID instead of carrying the bytes, and the hash
 * must not move: it is over the payload, and a reader reproduces it from
 * what the CID resolves to. That only works if the payload survives a parse
 * and a re-serialisation unchanged, which is asserted rather than assumed.
 */

const cid = "ipfs://QmbbRw6NJTBsujBPsx7hLAvfmjoT3km165SCjaYEoX5E4X";
const pinnedRecord = buildFeedback(measured, stamped, cid);
assert.equal(pinnedRecord.uri, cid, "the URI names the pin");
assert.equal(pinnedRecord.payload, built.payload, "the payload is the same bytes");
assert.equal(pinnedRecord.hash, built.hash, "so the hash is the same hash");
assert.ok(pinnedRecord.data.length < built.data.length, "and the calldata is shorter for it");
const [, , , , , , pinnedUri, pinnedHash] = decodeFunctionData({ abi: FEEDBACK_ABI, data: pinnedRecord.data }).args;
assert.equal(pinnedUri, cid, "the calldata carries the ipfs:// URI");
assert.equal(pinnedHash, built.hash, "beside the unchanged hash");
assert.equal(JSON.stringify(JSON.parse(built.payload)), built.payload, "the payload is canonical: parse and re-serialise gives the same bytes");
assert.equal(keccak256(toHex(JSON.stringify(JSON.parse(built.payload)))), built.hash, "which is what lets a verifier rebuild the hash from a fetched CID");
assert.equal(buildResponseTime(measured, stamped, cid)?.uri, cid, "the responseTime record takes a pin the same way");
assert.equal(buildResponseTime(measured, stamped, cid)?.hash, buildResponseTime(measured, stamped)?.hash, "at the same hash");

/* ------------------------------------------------------ signed cards ---
 *
 * RFC 8785 first, because a canonicaliser that is nearly right signs bytes
 * nobody else can reproduce. The two examples are the RFC's own (§3.2.3 for
 * key order, Appendix B for numbers and strings), then Kawal's signer and
 * verifier are run against each other and against WebCrypto's P-256.
 */

assert.equal(
  canonicalize({
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "\ud83d\ude00": "Emoji: Grinning Face",
    "\u0080": "Control",
    "\u00f6": "Latin Small Letter O With Diaeresis",
  }),
  '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
  "RFC 8785 §3.2.3: keys sort by UTF-16 code unit, so the emoji lands before the Hebrew letter",
);
assert.equal(
  canonicalize({
    numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27],
    string: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
    literals: [null, true, false],
  }),
  '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  "RFC 8785 Appendix B: ES number and string serialisation",
);
assert.equal(canonicalize({ b: undefined, a: [undefined, -0] }), '{"a":[null,0]}', "undefined drops as a member and reads as null in an array; -0 is 0");
assert.throws(() => canonicalize({ n: Number.NaN }), TypeError, "JSON cannot carry NaN, so neither can JCS");
assert.throws(() => canonicalize({ f: () => 1 }), TypeError);
assert.equal(new TextDecoder().decode(fromB64url(b64url(utf8("Kawal · 検査")))), "Kawal · 検査", "base64url round-trips UTF-8 without padding");
assert.throws(() => fromB64url("not+base64/url="), TypeError, "standard base64 is refused, not silently accepted");

{
  const key = generatePrivateKey();
  const card = agentCard("https://kawal.test");
  const signed = await signAgentCard(card, key);
  const sigs = signed.signatures as Array<{ protected: string; signature: string }>;
  assert.equal(sigs.length, 1);
  const header = JSON.parse(new TextDecoder().decode(fromB64url(sigs[0]!.protected))) as { alg: string; jwk: { kty: string; crv: string; x: string; y: string } };
  assert.equal(header.alg, "ES256K");
  assert.deepEqual([header.jwk.kty, header.jwk.crv], ["EC", "secp256k1"]);
  const pub = privateKeyToAccount(key).publicKey;
  assert.equal(`0x04${toHex(fromB64url(header.jwk.x)).slice(2)}${toHex(fromB64url(header.jwk.y)).slice(2)}`, pub, "the JWK is the signing key's own point");
  assert.equal(fromB64url(sigs[0]!.signature).length, 64, "raw r||s, no recovery byte, no DER");
  assert.equal(readAgentCard(signed)?.name, "Kawal", "a signed card still reads as a card");

  assert.equal(await verifyCardSignature(signed), "valid");
  assert.equal(await verifyCardSignature({ ...signed, name: "Not Kawal" }), "invalid", "one changed byte of the card and the signature no longer covers it");
  // Flip a byte of the signature itself, not a character of its encoding.
  // 64 bytes encode to 86 base64url characters, and the last of those carries
  // four bits the decoder throws away — so editing that character left the
  // same 64 bytes about half the time, and this assertion failed at random
  // depending on the key the run generated.
  const tampered = Uint8Array.from(fromB64url(sigs[0]!.signature));
  tampered[0] = tampered[0]! ^ 0xff;
  assert.notEqual(b64url(tampered), sigs[0]!.signature, "the tamper must actually change the signature");
  assert.equal(await verifyCardSignature({ ...signed, signatures: [{ ...sigs[0], signature: b64url(tampered) }] }), "invalid", "a changed signature is invalid, not unsupported");
  assert.equal(await verifyCardSignature(card), "unsigned");
  assert.equal(await verifyCardSignature({ ...card, signatures: [] }), "unsigned", "an empty list is no signature");
  assert.equal(
    await verifyCardSignature({ ...signed, signatures: [{ protected: b64url(utf8(JSON.stringify({ alg: "RS256" }))), signature: sigs[0]!.signature }] }),
    "unsupported",
    "an algorithm Kawal cannot check is reported as unchecked, not as wrong",
  );
  assert.equal(
    await verifyCardSignature({ ...signed, signatures: [{ protected: b64url(utf8(JSON.stringify({ alg: "ES256K", kid: "somewhere-else" }))), signature: sigs[0]!.signature }] }),
    "unsupported",
    "a supported algorithm with no key in the card cannot be checked here",
  );
  assert.equal(await verifyCardSignature({ ...signed, signatures: [{ protected: "%%%", signature: sigs[0]!.signature }] }), "invalid", "a header that is not base64url is a broken signature");
  assert.equal(
    await verifyCardSignature({ ...signed, signatures: [{ protected: b64url(utf8(JSON.stringify({ alg: "RS256" }))), signature: "x" }, sigs[0]] }),
    "valid",
    "one valid signature among unsupported ones makes the card valid",
  );
  // A key whose JWK travels in the unprotected header, as RFC 7515 allows.
  const bare = JSON.parse(new TextDecoder().decode(fromB64url(sigs[0]!.protected))) as Record<string, unknown>;
  const reProtected = b64url(utf8(JSON.stringify({ alg: bare.alg })));
  const reSigned = await sign({ hash: sha256(utf8(`${reProtected}.${cardPayload(card)}`)), privateKey: key, to: "bytes" });
  assert.equal(
    await verifyCardSignature({ ...card, signatures: [{ protected: reProtected, header: { jwk: bare.jwk }, signature: b64url(reSigned.slice(0, 64)) }] }),
    "valid",
    "the key may travel in the unprotected header",
  );

  // ES256 through WebCrypto, which is what a non-EVM agent would sign with.
  const p256 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", p256.publicKey);
  const prot = b64url(utf8(JSON.stringify({ alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } })));
  const input = utf8(`${prot}.${cardPayload(card)}`);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, p256.privateKey, input));
  assert.equal(raw.length, 64);
  const es256 = { ...card, signatures: [{ protected: prot, signature: b64url(raw) }] };
  assert.equal(await verifyCardSignature(es256), "valid", "ES256 over P-256 verifies through WebCrypto");
  assert.equal(await verifyCardSignature({ ...es256, version: "0.0.0" }), "invalid");
}

/* ------------------------------------------------- the ERC-8183 market ---
 *
 * The walk itself needs a chain; the counting does not, and it is the
 * counting a page prints.
 */

{
  const job = (id: number, status: number, provider: string, budget: bigint): MarketJob => ({
    id: BigInt(id),
    client: "0x48cE74cdC366E8347f17F7187FBf2Ab9240692E9",
    provider: provider as `0x${string}`,
    evaluator: "0x51895229E12F9876011789B04f8698af06cCD6DA",
    description: "x",
    budget,
    expiredAt: 0n,
    status,
    statusName: JOB_STATUS[status] ?? "UNKNOWN",
    hook: "0x51895229E12F9876011789B04f8698af06cCD6DA",
    submittedAt: 0n,
    deliverable: `0x${"0".repeat(64)}`,
  });
  const recent = {
    chainId: BSC_MAINNET,
    nextJobId: 56666n,
    readAt: "2026-08-29T00:00:00.000Z",
    jobs: [
      job(56665, 1, "0x4E21F74143660ee576F4D2aC26BD30729a849f55", 10n ** 17n),
      job(56664, 1, "0x4e21f74143660ee576f4d2ac26bd30729a849f55", 10n ** 17n),
      job(56663, 3, "0xa891E1743C5c8F00B7e216bC026C37914ddCD9c3", 5n * 10n ** 16n),
      job(56662, 9, "0xBBfD4c1e74bBC25047C9E6dFB9136f5a7055d1Cc", 0n),
    ],
  };
  const m = summariseMarket(recent);
  assert.deepEqual(m.byStatus, { OPEN: 0, FUNDED: 2, SUBMITTED: 0, COMPLETED: 1, REJECTED: 0, EXPIRED: 0 }, "every status is present, counted from the enum the kernel locks");
  assert.equal(m.budgetRaw, 25n * 10n ** 16n);
  assert.equal(m.providers, 3, "the same seller in two checksums is one seller");
  assert.equal(m.nextJobId, 56666n);
  assert.equal(recent.jobs[3]!.statusName, "UNKNOWN", "a status the enum does not name is not counted as one it does");
  assert.equal(formatU(25n * 10n ** 16n), "0.25 $U");
}

/* -------------------------------------------------------- venue rates --- */

assert.equal(Math.round(blocksPerDayBetween(10_000n, 4_501)), 191_957, "the cadence measured on 2026-08-29: 10,000 blocks in 4,501 s");
assert.equal(Math.round(blocksPerDayBetween(10_000n, 30_000)), 28_800, "three-second blocks, the cadence BSC launched with");
assert.throws(() => blocksPerDayBetween(10_000n, 0), RangeError);
// Venus vUSDT on 2026-08-29: 375484814 per block at 191,957 blocks/day is 2.63% a year.
assert.equal(annualise(375_484_814n, 191_957).toFixed(4), "0.0263");
assert.equal(annualise(0n, 191_957), 0);
assert.equal(fromRay(23_671_138_640_458_510_106_023_766n).toFixed(4), "0.0237", "Aave's ray rate is already annual");
assert.equal(pct(0.026308), "2.63%");
assert.equal(pct(0), "0.00%");

/* ------------------------------------------------------------ v5 parts --- */
{
  // 8004scan's live shape for 56:43129 on 2026-08-30: weights as fractions of
  // one, and `weighted_score` = score × weight, so the five land on a 0-100
  // scale. The page prints the share out of 100, which is what its caption
  // promises and what a part scored out of 100 can be read against.
  const dim = (score: number, weight: number) => ({ score, weight, weighted_score: score * weight, explanation: "", details: {} });
  const v5 = {
    agent_id: "9135dc06",
    agent_name: "Venus powered by HeyAnon",
    total_score: 30.47,
    last_scored_at: "2026-08-30T09:54:21.587882Z",
    version: "5.2",
    algorithm: "v5_leaderboard_policy",
    engagement: dim(6.39, 0.3),
    service: dim(90, 0.25),
    publisher: dim(43.48, 0.2),
    compliance: dim(80, 0.15),
    momentum: dim(5.02, 0.1),
    weights: {},
  };
  const rows = v5Rows(v5);
  assert.deepEqual(rows.map((r) => r.key), ["engagement", "service", "publisher", "compliance", "momentum"], "the registry's order, not the object's");
  assert.deepEqual(rows.map((r) => r.weightPct), [30, 25, 20, 15, 10]);
  assert.equal(rows.reduce((s, r) => s + r.weightPct, 0), 100, "the caption says the weights sum to 100, so they must");
  // The registry's headline is not the sum of the registry's own parts —
  // 30.47 against 45.62 here, 30.45 against 44.87 for 45381, both read on
  // 2026-08-30. The agent sheet prints both and says they disagree, so this
  // records the discrepancy rather than papering over it.
  assert.equal(rows.reduce((s, r) => s + r.dimension.weighted_score, 0).toFixed(2), "45.62");
  assert.notEqual(rows.reduce((s, r) => s + r.dimension.weighted_score, 0).toFixed(2), v5.total_score.toFixed(2));
  assert.equal(weakestV5(v5)?.key, "momentum", "weakest on the 0-100 scale, not the weighted one");
  assert.equal(weakestV5(v5)?.weightPct, 10);
  // A dimension the registry left null is not drawn, and an unscored agent
  // has no rows at all rather than five zeroes.
  assert.equal(v5Rows({ ...v5, service: null }).length, 4);
  assert.deepEqual(v5Rows(null), []);
  assert.equal(weakestV5(null), null);
}

// -- an agent the index has never heard of ---------------------------------
{
  // The date a chain-built row does not have. `new Date("").toISOString()`
  // throws a RangeError, which on the agent page is a 500 on the one path
  // that exists to survive the index being unhelpful.
  assert.equal(registeredOn("2026-08-27T03:52:41.769Z"), "2026-08-27");
  assert.equal(registeredOn(""), "not published");
  assert.equal(registeredOn("whenever"), "not published");

  // Rows out of 8004scan carry no `indexed` field and must read as indexed;
  // only a row that says otherwise is treated as chain-built, so a page can
  // never mistake a scored agent for an unscored one.
  const fromIndex = ScanAgentDetailSchema.parse({
    id: "56:43129",
    agent_id: "43129",
    token_id: "43129",
    chain_id: 56,
    contract_address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    name: "Venus powered by HeyAnon",
    created_at: "2026-07-01T00:00:00Z",
  });
  assert.equal(fromIndex.indexed, true, "absent means indexed");
  assert.equal(ScanAgentDetailSchema.parse({ ...fromIndex, indexed: false }).indexed, false);
  assert.equal(ScanAgentDetailSchema.parse({ ...fromIndex, indexed: "no" }).indexed, true, "junk falls back to indexed");
}

// -- the record of what was already written --------------------------------
{
  // `at` decides whether an agent is written about again. The responseTime
  // branch used to let the previous entry overwrite the `at` it had just set,
  // so an agent stayed permanently due and collected a duplicate record on
  // every run — ten of them, measured against the chain on 2026-08-31.
  const prev = {
    txHash: "0xaaa" as string,
    at: "2026-08-30T00:00:00.000Z",
    checks: 40,
    evidence: "ipfs://old",
  };
  const now = () => "2026-08-31T12:00:00.000Z";

  const afterResponseTime = noteWrite(prev, "responseTime", "0xbbb", 114, "ipfs://new", now);
  assert.equal(afterResponseTime.at, "2026-08-31T12:00:00.000Z", "the write must advance `at`, or it is written again tomorrow");
  assert.equal(afterResponseTime.checks, 114);
  assert.equal(afterResponseTime.responseTimeTx, "0xbbb");
  assert.equal(afterResponseTime.responseTimeEvidence, "ipfs://new");
  // The uptime side of the entry is carried, not clobbered: both records are
  // about the same agent and the revoke path needs either hash.
  assert.equal(afterResponseTime.txHash, "0xaaa");
  assert.equal(afterResponseTime.evidence, "ipfs://old");

  const afterUptime = noteWrite(prev, "uptime", "0xccc", 114, null, now);
  assert.equal(afterUptime.at, "2026-08-31T12:00:00.000Z");
  assert.equal(afterUptime.txHash, "0xccc", "a fresh uptime record replaces the old one");
  assert.equal(afterUptime.responseTimeTx, undefined);
  // A pin that failed carries no evidence key rather than an undefined one,
  // so `--verify` reads the record as inline rather than as a broken CID.
  assert.equal(afterUptime.evidence, "ipfs://old", "an unpinned write leaves the previous CID alone");
  assert.equal(noteWrite(undefined, "uptime", "0xddd", 12, null, now).evidence, undefined);
}

console.log("ok - taxonomy, signals, mandate, ssrf guard, memo, schemas, pricing, verdicts, links, uptime, vault and ledger, x402, reputation, feedback, mcp server, failure kinds, charging, a2a, a2a server, rate limit, signing in, self-rating, evidence on ipfs, jcs, signed cards, erc8183 market, venue rates, v5 parts, unindexed agents, publication record");
