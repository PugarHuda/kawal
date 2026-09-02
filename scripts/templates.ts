/**
 * How much of BSC's agent register points at an address that was never
 * filled in.
 *
 * Run: npm run templates            probe 24 of them
 *      npm run templates -- 60      probe more
 *
 * Braces are excluded from URIs by RFC 3986, so a `{placeholder}` in a
 * declared endpoint is never an address — it is the template the publisher
 * meant to substitute into and did not. That makes this measurable rather
 * than anecdotal, and the measurement is not small: on 2026-09-01 every agent
 * describing itself as being on one platform declared the same A2A card URL
 * with `{agentId}` still in it, and there were 17,885 of them — 6% of the
 * whole BSC register and three quarters of every A2A declaration on the
 * chain.
 *
 * Three questions, because the first two answers are both misleading on their
 * own:
 *
 *   1. As registered, does it answer? (No: 404.)
 *   2. With the id the registry already holds substituted in, does it answer?
 *      (Yes: 200 — so the platform is up and "it is broken" is wrong.)
 *   3. Is what comes back actually bound to anything callable? (No: every card
 *      read so far reports UNBOUND and offline with a null endpoint — so "it
 *      works if you substitute" is wrong too.)
 *
 * Stopping at 1 accuses a working platform. Stopping at 2 excuses a register
 * full of addresses nobody can follow. Kawal reports all three.
 *
 * Free. HTTP only, no chain writes, and nothing here is executed on the
 * agents dialled — one GET each, exactly as a buyer's browser would.
 */

export {};

import { listAgents, getAgent } from "../lib/scan.ts";
import { unsubstituted, substituted } from "../lib/probe.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { BSC_MAINNET } from "../lib/chains.ts";
import { guardedFetch, readCapped } from "../lib/ssrf.ts";

const SAMPLE = Number(process.argv[2] ?? 24);
/** Other people's servers: one at a time in small handfuls, like every probe here. */
const CONCURRENCY = 4;

console.log("Kawal → registrations whose endpoint is still a template\n");

/**
 * The search that finds them.
 *
 * By the description they publish, not by a domain: the string is a claim
 * anyone could mint, and it is used here to *find* candidates, never to
 * conclude anything. Every number below comes from calling the address the
 * registration gave.
 */
const { agents, total } = await listAgents({
  chainId: BSC_MAINNET,
  search: "Termix Platform",
  limit: Math.max(SAMPLE, 1),
});
console.log(`the registry returns ${total.toLocaleString("en-US")} agents matching that description`);
console.log(`probing ${Math.min(SAMPLE, agents.length)} of them\n`);

type Row = {
  id: string;
  name: string;
  endpoint: string | null;
  placeholder: string | null;
  asRegistered: number | null;
  substituted: number | null;
  bound: boolean | null;
  presence: string | null;
};

async function status(url: string): Promise<{ code: number | null; body: string }> {
  try {
    const res = await guardedFetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return { code: res.status, body: res.ok ? await readCapped(res) : "" };
  } catch {
    return { code: null, body: "" };
  }
}

const rows: Row[] = await mapLimit(agents.slice(0, SAMPLE), CONCURRENCY, async (a) => {
  const base: Row = {
    id: a.token_id,
    name: a.name,
    endpoint: null,
    placeholder: null,
    asRegistered: null,
    substituted: null,
    bound: null,
    presence: null,
  };
  const detail = await getAgent(BSC_MAINNET, a.token_id).catch(() => null);
  const endpoint = (detail?.services?.a2a ?? detail?.services?.mcp)?.endpoint ?? null;
  if (!endpoint) return base;

  const placeholder = unsubstituted(endpoint);
  const asRegistered = (await status(endpoint)).code;
  if (!placeholder) return { ...base, endpoint, asRegistered };

  const filled = await status(substituted(endpoint, a.token_id));
  let bound: boolean | null = null;
  let presence: string | null = null;
  if (filled.code === 200 && filled.body) {
    try {
      // Whatever the platform's own shape, the question is the same: does this
      // name something to call? A card that says it is unbound is answering
      // honestly, and is still not an agent anyone can hire.
      const card = JSON.parse(filled.body) as { status?: string; presence?: string; endpoint?: string | null };
      presence = card.presence ?? null;
      bound = Boolean(card.endpoint) && card.status !== "UNBOUND";
    } catch {
      bound = null;
    }
  }
  return { ...base, endpoint, placeholder, asRegistered, substituted: filled.code, bound, presence };
});

const withEndpoint = rows.filter((r) => r.endpoint);
const templated = rows.filter((r) => r.placeholder);
const deadAsRegistered = templated.filter((r) => r.asRegistered !== null && r.asRegistered >= 400);
const filledAnswers = templated.filter((r) => r.substituted === 200);
const actuallyBound = filledAnswers.filter((r) => r.bound === true);

for (const r of rows.slice(0, 8)) {
  console.log(`  ${r.id} ${r.name}`);
  console.log(`     declared     ${r.endpoint ?? "nothing to call"}`);
  if (r.placeholder) {
    console.log(
      `     as registered ${r.asRegistered ?? "no answer"} · with ${r.placeholder} filled in ${r.substituted ?? "no answer"}` +
        (r.presence ? ` · the card says ${r.presence}${r.bound === false ? ", bound to nothing" : ""}` : ""),
    );
  }
}
if (rows.length > 8) console.log(`  … ${rows.length - 8} more, same shape\n`);

console.log(`\ndeclared an endpoint            ${withEndpoint.length} of ${rows.length}`);
console.log(`endpoint is an unfilled template ${templated.length}`);
console.log(`refused as registered            ${deadAsRegistered.length}`);
console.log(`answered once the id was filled  ${filledAnswers.length}`);
console.log(`bound to something callable      ${actuallyBound.length}`);

console.log(
  `\n${templated.length} of ${rows.length} registrations name an address that is not an address. ` +
    `${filledAnswers.length} of those reach a live card once the registry's own id is put where the ` +
    `placeholder is, so the platform behind them is up — and ${actuallyBound.length} of those cards is bound ` +
    `to anything a buyer could call.`,
);
console.log(
  "\nKawal probes the endpoint as published. A registration nobody can follow is the finding; repairing it " +
    "quietly on the reader's behalf would hide exactly what this measures.\n",
);

// 0 nothing templated · 1 templates found. A caller can gate on it.
process.exit(templated.length > 0 ? 1 : 0);
