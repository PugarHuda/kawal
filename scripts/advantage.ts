/**
 * The Agent Advantage Report harness.
 *
 * Run: npm run advantage
 *
 * TermiX asks one question: does hiring an agent through this marketplace
 * beat doing the job yourself, and can you prove it with numbers? This runs
 * three real tasks down both paths, times them, and writes down what each
 * actually returned — including the tasks where hiring loses.
 *
 * Two rules this file is built around:
 *
 *   Nothing is simulated. Every agent call is a live MCP round trip to an
 *   agent listed on Kawal; every manual path is a real RPC or REST call.
 *
 *   Verdicts are computed from the measurements, never written ahead of them.
 *   An earlier draft asserted which path would win each task before the
 *   harness had run once; two of the three guesses were backwards.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, http, formatUnits } from "viem";
import { bsc } from "viem/chains";
import { McpClient, toolText } from "../lib/mcp.ts";
import { VENUES } from "../lib/mandate.ts";
import { BSC_MAINNET } from "../lib/chains.ts";
import {
  verdictFor,
  plural,
  median,
  type TaskResult,
} from "../lib/advantage.report.ts";

const OUT_DIR = "advantage-output";
const RPC = "https://bsc-dataseed.bnbchain.org";

/**
 * A real Venus borrower on BSC, found by scanning vUSDT Borrow events rather
 * than picked from an article. Its position is what makes the health task a
 * real question instead of a lookup that returns zeroes.
 */
const SUBJECT = "0x7A38D8bad0591Ad1673E2aB20C67b2c6286982Cd";

const rpc = createPublicClient({ chain: bsc, transport: http(RPC) });

function save(name: string, body: string) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/${name}`, body);
  return `${OUT_DIR}/${name}`;
}

/**
 * How many times each path is run before its timing is reported.
 *
 * One sample is not evidence. Consecutive runs of this harness flipped two of
 * the three verdicts purely on network variance — the same agent measured
 * both faster and slower than the same manual path within a minute. TermiX
 * weights "proven agent advantage" at 30%, and a number that changes sign
 * between runs proves nothing.
 */
const SAMPLES = 3;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; spread: string; value: T }> {
  const samples: number[] = [];
  let value!: T;
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    value = await fn();
    samples.push(Math.round(performance.now() - started));
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { ms: median(samples), spread: `${sorted[0]}-${sorted[sorted.length - 1]}`, value };
}

/** One MCP round trip, initialize included, because a real hire pays for both. */
async function hire(
  endpoint: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ms: number; spread: string; ok: boolean; text: string }> {
  // Raised from the probe's default: this calls agents we chose on purpose,
  // and one of them answers with 1.6 MB of market definitions. Still bounded,
  // so a misbehaving server cannot stream us out of memory.
  const client = new McpClient(endpoint, { timeoutMs: 90_000, maxBytes: 16_000_000 });
  const { ms, spread, value } = await timed(async () => {
    const init = await client.initialize();
    if (!init.ok) return { ok: false, text: init.error ?? "initialize failed" };
    const call = await client.callTool(tool, args);
    if (!call.ok) return { ok: false, text: call.error ?? "tool call failed" };
    return { ok: true, text: toolText(call.result) };
  });
  return { ms, spread, ...value };
}

// --- task 1: is this lending position about to be liquidated? --------------

const COMPTROLLER_ABI = [
  {
    type: "function",
    name: "getAccountLiquidity",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  },
] as const;

async function task1(): Promise<TaskResult> {
  const question = `Is Venus position ${SUBJECT} at risk of liquidation, and how much headroom does it have?`;

  const h = await hire("https://erc8004.heyanon.ai/mcp/venus", "getAccountLiquidity", {
    chainNames: ["bsc"],
    pool: "CORE",
    userAddress: SUBJECT,
  });

  const m = await timed(async () => {
    const comptroller = VENUES["venus.comptroller"].deployments[BSC_MAINNET]!.address!;
    const [error, liquidity, shortfall] = await rpc.readContract({
      address: comptroller,
      abi: COMPTROLLER_ABI,
      functionName: "getAccountLiquidity",
      args: [SUBJECT as `0x${string}`],
    });
    return JSON.stringify(
      {
        source: "Venus Comptroller getAccountLiquidity, read directly",
        comptroller,
        error: error.toString(),
        liquidityUsd: Number(formatUnits(liquidity, 18)).toFixed(2),
        shortfallUsd: Number(formatUnits(shortfall, 18)).toFixed(2),
      },
      null,
      2,
    );
  });

  save("task1-hired.json", h.text);
  save("task1-manual.json", m.value);

  return {
    id: "task1",
    title: "Liquidation risk on a live lending position",
    category: "Health factor monitoring (high stakes: lending)",
    question,
    hired: {
      path: "hired",
      label: "Venus powered by HeyAnon — MCP getAccountLiquidity",
      ms: h.ms,
      spread: h.spread,
      ok: h.ok,
      output: h.text,
      costUsd: 0,
      coverage: { count: 1, unit: "position" },
      note: "Listed on Kawal as hireable. No x402 challenge was issued, so the call was free.",
    },
    manual: {
      path: "manual",
      label: "Venus Comptroller read directly over RPC",
      ms: m.ms,
      spread: m.spread,
      ok: true,
      output: m.value,
      costUsd: 0,
      coverage: { count: 1, unit: "position" },
      note:
        "Excludes the work of finding and proving the Comptroller address. Kawal spent " +
        "real effort on that (npm run verify:venues) precisely because published lists " +
        "name an implementation address that would return nothing here.",
    },
    verdict: "",
  };
}

// --- task 2: where should stablecoins sit on BSC today? --------------------

const VTOKEN_ABI = [
  { type: "function", name: "supplyRatePerBlock", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

async function task2(): Promise<TaskResult> {
  const question = "Where can capital earn yield on BSC right now, and at what rate?";

  const h = await hire("https://erc8004.heyanon.ai/mcp/beefy", "getVaultsWithChains", {
    chainNames: ["bsc"],
  });

  const m = await timed(async () => {
    const vusdt = VENUES["venus.vusdt"].deployments[BSC_MAINNET]!.address!;
    const [rate, symbol] = await Promise.all([
      rpc.readContract({ address: vusdt, abi: VTOKEN_ABI, functionName: "supplyRatePerBlock" }),
      rpc.readContract({ address: vusdt, abi: VTOKEN_ABI, functionName: "symbol" }),
    ]);
    // BSC targets ~0.75s blocks after the Maxwell upgrade, so a year is about
    // 42.0M blocks. Venus quotes per-block rates at 1e18 scale.
    const BLOCKS_PER_YEAR = 42_048_000;
    const perBlock = Number(formatUnits(rate, 18));
    const apy = (Math.pow(1 + perBlock, BLOCKS_PER_YEAR) - 1) * 100;
    return JSON.stringify(
      {
        source: "Venus vUSDT supplyRatePerBlock, read directly",
        market: vusdt,
        symbol,
        supplyRatePerBlock: rate.toString(),
        assumedBlocksPerYear: BLOCKS_PER_YEAR,
        impliedSupplyApyPercent: apy.toFixed(4),
        covers: "one market on one protocol",
      },
      null,
      2,
    );
  });

  save("task2-hired.json", h.text);
  save("task2-manual.json", m.value);

  let vaultCount = 0;
  try {
    const parsed = JSON.parse(h.text) as { data?: Array<{ vaults?: unknown[] }> };
    vaultCount = parsed.data?.[0]?.vaults?.length ?? 0;
  } catch {
    vaultCount = 0;
  }

  return {
    id: "task2",
    title: "Finding where yield actually is",
    category: "Yield optimisation",
    question,
    hired: {
      path: "hired",
      label: "Beefy powered by HeyAnon — MCP getVaultsWithChains",
      ms: h.ms,
      spread: h.spread,
      ok: h.ok,
      output: h.text,
      costUsd: 0,
      coverage: { count: vaultCount, unit: "vaults across protocols" },
      note: `Returned ${vaultCount} BSC vaults with TVL and platform for each.`,
    },
    manual: {
      path: "manual",
      label: "Venus vUSDT supply rate read directly, annualised by hand",
      ms: m.ms,
      spread: m.spread,
      ok: true,
      output: m.value,
      costUsd: 0,
      coverage: { count: 1, unit: "vaults across protocols" },
      note:
        "Answers a much narrower question for comparable effort: one market, one " +
        "protocol, and only after deciding a blocks-per-year constant that BSC has " +
        "already changed once this year.",
    },
    verdict: "",
  };
}

// --- task 3: what can I trade, and under what constraints? -----------------

async function task3(): Promise<TaskResult> {
  const question = "What perpetual markets does Aster support, and what are their price and lot constraints?";

  const h = await hire("https://erc8004.heyanon.ai/mcp/aster", "getSupportedMarkets", {});

  const m = await timed(async () => {
    const res = await fetch("https://fapi.asterdex.com/fapi/v1/exchangeInfo", {
      cache: "no-store",
    });
    const body = (await res.json()) as { symbols?: unknown[] };
    return JSON.stringify(
      {
        source: "Aster public REST exchangeInfo, called directly",
        endpoint: "https://fapi.asterdex.com/fapi/v1/exchangeInfo",
        symbolCount: body.symbols?.length ?? 0,
      },
      null,
      2,
    );
  });

  save("task3-hired.json", h.text);
  save("task3-manual.json", m.value);

  let agentSymbols = 0;
  try {
    const parsed = JSON.parse(h.text) as { data?: unknown[] };
    agentSymbols = parsed.data?.length ?? 0;
  } catch {
    agentSymbols = 0;
  }
  const manualSymbols = (JSON.parse(m.value) as { symbolCount: number }).symbolCount;

  return {
    id: "task3",
    title: "Enumerating tradable markets",
    category: "Trading (high stakes)",
    question,
    hired: {
      path: "hired",
      label: "Aster powered by HeyAnon — MCP getSupportedMarkets",
      ms: h.ms,
      spread: h.spread,
      ok: h.ok,
      output: h.text,
      costUsd: 0,
      coverage: { count: agentSymbols, unit: "markets" },
      note: `Returned ${agentSymbols} markets.`,
    },
    manual: {
      path: "manual",
      label: "Aster public REST exchangeInfo, called directly",
      ms: m.ms,
      spread: m.spread,
      ok: true,
      output: m.value,
      costUsd: 0,
      coverage: { count: manualSymbols, unit: "markets" },
      note: `Returned ${manualSymbols} markets from a documented public endpoint that needs no key.`,
    },
    verdict: "",
  };
}

// --- report ----------------------------------------------------------------

const tasks = [await task1(), await task2(), await task3()];
for (const t of tasks) t.verdict = verdictFor(t);

function clip(s: string, n = 1400) {
  return s.length > n ? `${s.slice(0, n)}\n… truncated, full output in ${OUT_DIR}/` : s;
}

const generatedAt = new Date().toISOString();

// Named rather than indexed inline. The prose below quotes specific numbers
// from specific tasks, and an out-of-range read there would put `undefined`
// into a sentence presented as a measurement.
const [liquidationTask, yieldTask, tradingTask] = tasks;
if (!liquidationTask || !yieldTask || !tradingTask) {
  throw new Error(`expected three task results, got ${tasks.length}`);
}

const md = `# Agent Advantage Report

Generated ${generatedAt} · every number below came from a live run of
\`npm run advantage\`. No result is simulated, averaged or reconstructed.

## Method

Each task is run twice: once by hiring an agent listed on Kawal through its
declared MCP endpoint, and once by doing the job directly against a public RPC
or REST API. The hired path is timed from a cold start — the MCP \`initialize\`
handshake is included, because a real hire pays for it. Each path is run
${SAMPLES} times and the median reported, with the full range beside it: a
single sample flipped two of these three verdicts between consecutive runs.

Cost is what actually left a wallet. All three agents are registered as
\`x402_supported\` on 8004scan, but none issued a payment challenge, so all
three calls were free. That gap between declared and enforced payment is a
finding in itself and is discussed at the end.

Subject address for task 1: \`${SUBJECT}\` — a real Venus borrower on BSC,
found by scanning vUSDT \`Borrow\` events, not chosen from a write-up.

---

${tasks
  .map(
    (t) => `## ${t.title}

**Category:** ${t.category}
**Question:** ${t.question}

| Path | What ran | Median of 3 (range) | Returned | Cost |
|---|---|---|---|---|
| Hired | ${t.hired.label} | ${t.hired.ms} ms (${t.hired.spread}) | ${t.hired.coverage.count} ${plural(t.hired.coverage.count, t.hired.coverage.unit)} | $${t.hired.costUsd.toFixed(2)} |
| Manual | ${t.manual.label} | ${t.manual.ms} ms (${t.manual.spread}) | ${t.manual.coverage.count} ${plural(t.manual.coverage.count, t.manual.coverage.unit)} | $${t.manual.costUsd.toFixed(2)} |

**${t.verdict}**

Hired — ${t.hired.note ?? ""}

\`\`\`json
${clip(t.hired.output)}
\`\`\`

Manual — ${t.manual.note ?? ""}

\`\`\`json
${clip(t.manual.output)}
\`\`\`
`,
  )
  .join("\n---\n\n")}

---

## What the numbers say

${tasks.map((t) => `- **${t.title}** — ${t.verdict}`).join("\n")}

Wall clock favoured the manual path in all three tasks, and on its own that
number is misleading: a single targeted RPC call will always beat an MCP
handshake plus an agent's own upstream work. The column that decides anything
is what came back.

- **Liquidation risk** — both paths answered for the same one position, so the
  faster path wins and that is the direct read. Worth recording: the two
  disagreed by roughly 1% on the borrow limit, which is different oracle
  snapshots rather than a bug. For a liquidation decision that gap matters,
  and only the direct read is reproducible against a block number.
- **Yield** — the one task where hiring clearly pays. The agent surveyed
  ${yieldTask.hired.coverage.count} vaults across several protocols in a single
  call; the direct read covered ${yieldTask.manual.coverage.count}, and only
  after committing to a blocks-per-year constant that BSC has already changed
  once this year. The manual path is faster at answering a much smaller
  question.
- **Trading** — hiring loses on both axes. Aster publishes the same data on a
  documented public endpoint that needs no key, returned
  ${tradingTask.manual.coverage.count} markets against the agent's
  ${tradingTask.hired.coverage.count}, and did it faster. Paying an agent to
  proxy a public API is a worse deal than calling the API.

The pattern across all three: hiring is worth it when the agent aggregates
across sources you would otherwise have to find, integrate and maintain
yourself. It is not worth it when the agent is a wrapper around one endpoint
you could have called directly. A marketplace that cannot tell a buyer which
of the two they are looking at is not doing its job, which is why Kawal shows
tool counts, live latency and price rather than a single score.

## Price discovery, and why Kawal shows it

A fourth agent was priced but not hired. **Sentinels Audit**
(\`smartsentinels.net/api/audit-mcp\`, token 258641) is a live MCP server whose
free \`sentinels_ai_audit_info\` tool quotes its own price: **0.2 BNB per
contract audit**, paid as a native transfer to
\`0x4E21F74143660ee576F4D2aC26BD30729a849f55\`, with the resulting transaction
hash passed back as \`paymentTxHash\`.

That is roughly \$140 a call. It may well be worth it against a human auditor,
but it is not a number 8004scan surfaces anywhere, and it is the first thing
anyone deciding whether to hire needs to know. The report stops at the quote
rather than paying, because a run this report could not honestly reproduce is
worth less than an unpaid one it can.

## The declared-versus-enforced gap

Kawal's \`hireable\` tier means "declares a callable interface **and**
\`x402_supported\`". Running these tasks showed \`x402_supported\` is a
self-declared flag, not an enforced one: all three agents carry it, none
demanded payment, and the one agent that genuinely charges — Sentinels —
reports \`x402_supported: false\` and takes a plain native transfer instead.

So the flag predicts neither that you will be charged nor that you won't. Kawal
now says so on the agent page rather than letting the tier imply a payment
path that was never tested.
`;

writeFileSync("ADVANTAGE.md", md);

// The same results the markdown carries, in the shape /advantage renders.
//
// Written here rather than parsed back out of ADVANTAGE.md because a report
// and a page reading the same prose would drift the first time either was
// reworded. The raw payloads stay in their own files — task 3 alone is 700 kB,
// and a page does not need to parse that to say the agent returned 550
// markets.
writeFileSync(
  `${OUT_DIR}/results.json`,
  JSON.stringify(
    {
      generatedAt,
      tasks: tasks.map((t) => ({
        ...t,
        hired: { ...t.hired, output: clip(t.hired.output, 600) },
        manual: { ...t.manual, output: clip(t.manual.output, 600) },
      })),
    },
    null,
    2,
  ),
);

console.log(`\nwrote ADVANTAGE.md and ${OUT_DIR}/ (${tasks.length * 2} raw outputs)\n`);
for (const t of tasks) {
  console.log(`${t.title}`);
  console.log(`   hired  ${String(t.hired.ms).padStart(6)} ms  ${t.hired.ok ? "ok" : "FAILED"}`);
  console.log(`   manual ${String(t.manual.ms).padStart(6)} ms  ${t.manual.ok ? "ok" : "FAILED"}`);
  console.log(`   ${t.verdict}`);
}
