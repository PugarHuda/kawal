/**
 * Calls every agent Kawal calls hireable, and writes down what happened.
 *
 * Run: npm run sweep
 *
 * Free — HTTP only, no chain writes — which is why it exists. The uptime
 * panel is worth more the more observations sit behind it, and each pass
 * costs nothing but a few seconds.
 *
 * It is also an audit of our own listing. "Hireable" means the registry says
 * an interface is declared and x402 is supported — and the registry tests
 * neither. The first sweep of 19 such agents found 6 that answered, 2 whose
 * declared endpoint is simply not there, and 11 speaking only A2A or OASF,
 * which this prober does not speak and therefore says nothing about.
 */

import { CATEGORIES } from "../lib/taxonomy.ts";
import { retrieveCategory } from "../lib/catalog.ts";
import { getAgent } from "../lib/scan.ts";
import { proveAgent } from "../lib/probe.ts";
import { uptimeFor } from "../lib/uptime.ts";
import { mapLimit } from "../lib/concurrency.ts";

/** Kept low: these are other people's servers and this runs on a loop. */
const CONCURRENCY = 4;
const TIMEOUT_MS = 10_000;

type Row = {
  category: string;
  name: string;
  ref: string;
  endpoint: string | null;
  answered: boolean;
  latencyMs: number | null;
  tools: number | null;
  error: string | null;
  history: string;
};

const targets: Array<{ category: string; chainId: number; tokenId: string; name: string }> = [];

for (const category of CATEGORIES) {
  const result = await retrieveCategory(category);
  for (const listing of result.listings.filter((l) => l.assessment.tier === "hireable")) {
    targets.push({
      category: category.label,
      chainId: listing.agent.chain_id,
      tokenId: listing.agent.token_id,
      name: listing.agent.name,
    });
  }
}

console.log(`sweeping ${targets.length} agents Kawal lists as hireable\n`);

const rows = await mapLimit(targets, CONCURRENCY, async (t): Promise<Row> => {
  const base = { category: t.category, name: t.name, ref: `${t.chainId}:${t.tokenId}` };
  try {
    const detail = await getAgent(t.chainId, t.tokenId);
    const proof = await proveAgent(detail, { timeoutMs: TIMEOUT_MS });

    if (!proof) {
      return {
        ...base,
        endpoint: null,
        answered: false,
        latencyMs: null,
        tools: null,
        error: "declares no MCP endpoint",
        history: "-",
      };
    }

    const seen = uptimeFor(proof.endpoint);
    return {
      ...base,
      endpoint: proof.endpoint,
      answered: proof.answered,
      latencyMs: proof.answered ? proof.latencyMs : null,
      tools: proof.toolCount,
      error: proof.error,
      history: seen ? `${seen.answered}/${seen.checks}` : "-",
    };
  } catch (e) {
    return {
      ...base,
      endpoint: null,
      answered: false,
      latencyMs: null,
      tools: null,
      error: e instanceof Error ? e.message.slice(0, 60) : String(e),
      history: "-",
    };
  }
});

for (const category of new Set(rows.map((r) => r.category))) {
  console.log(category);
  for (const r of rows.filter((x) => x.category === category)) {
    // Three states, not two. An agent that speaks only A2A or OASF was never
    // called — Kawal's prober speaks MCP — and printing that as DOWN would be
    // the same conflation this whole listing exists to avoid: "we did not
    // check" is not "we checked and it failed".
    const mark = r.answered ? "ok    " : r.endpoint === null ? "unchecked" : "DOWN  ";
    const detail = r.answered
      ? `${String(r.latencyMs).padStart(5)} ms  ${r.tools ?? "?"} tools`
      : (r.error ?? "no answer").slice(0, 44).padStart(20);
    console.log(`  ${mark.padEnd(10)}${r.name.slice(0, 32).padEnd(34)} ${detail}   seen ${r.history}`);
  }
  console.log();
}

const answered = rows.filter((r) => r.answered).length;
const noEndpoint = rows.filter((r) => r.endpoint === null).length;
const dead = rows.length - answered - noEndpoint;

console.log(`${answered} of ${rows.length} answered`);
console.log(`${noEndpoint} speak only A2A or OASF — never called, so nothing is claimed about them`);
console.log(`${dead} declare an MCP endpoint that did not answer`);

if (dead > 0) {
  console.log(
    `\n${dead} agent(s) Kawal calls hireable declare an endpoint that is not there.` +
      `\nThe registry cannot know that: it never calls anything. This is why the` +
      `\nlisting probes instead of trusting the flag.`,
  );
}
