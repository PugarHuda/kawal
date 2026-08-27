/**
 * What the newest registrations on BSC are actually made of.
 *
 * Run: npm run roster            sample the 600 newest
 *      npm run roster -- 1000    sample more
 *
 * Kawal's front page quotes two chain-wide figures off the registry: how many
 * agents exist, and what share of them declare an interface. Both are true and
 * both describe an average taken over everything ever minted, which turns out
 * to be a different population from the one arriving now.
 *
 * Two things this measures that nobody publishes.
 *
 * How much of the roster is one template. `collapseDuplicates` already folds
 * identical name-and-description registrations together on every category
 * page, because without it a listing is the same agent forty times. Run across
 * the newest arrivals it stops being a display detail and becomes a figure:
 * roughly two thirds of what BSC added most recently is a copy. It is not one
 * spammer either — the owners are nearly all distinct, so this is a template
 * being minted by many people rather than a farm run by one.
 *
 * And whether the register is improving. The chain-wide declare rate is about
 * 8.5%; among the newest it is far higher. Quoting only the first makes Kawal
 * pessimistic about exactly the agents a buyer would meet first.
 *
 * Free. HTTP only, no chain writes.
 */

export {};

import { listAgents, getStats, bscStats } from "../lib/scan.ts";
import { toListings, collapseDuplicates } from "../lib/catalog.ts";
import { BSC_MAINNET } from "../lib/chains.ts";

const WANT = Number(process.argv[2] ?? 600);
const PAGE = 100;
const CALLABLE = new Set(["MCP", "A2A", "OASF"]);

const sample = [];
for (let page = 1; sample.length < WANT; page++) {
  const { agents } = await listAgents({
    chainId: BSC_MAINNET,
    page,
    limit: PAGE,
    sortBy: "created_at",
    sortOrder: "desc",
  });
  sample.push(...agents);
  // A short page is the end of what the registry will serve, not a hiccup.
  if (agents.length < PAGE) break;
}

if (sample.length === 0) {
  console.error("The registry returned nothing. Try again shortly.");
  process.exit(1);
}

const distinct = collapseDuplicates(toListings(sample));
const copies = sample.length - distinct.length;

const owners = new Map<string, number>();
for (const a of sample) owners.set(a.owner_address, (owners.get(a.owner_address) ?? 0) + 1);
const busiest = [...owners.entries()].sort((a, b) => b[1] - a[1]);

const callable = sample.filter((a) =>
  (a.supported_protocols ?? []).some((p) => CALLABLE.has(p.toUpperCase())),
);

const pct = (n: number) => ((n / sample.length) * 100).toFixed(1);

console.log(`the ${sample.length} newest BSC registrations\n`);
console.log(`  distinct after collapse  ${distinct.length}`);
console.log(`  copies of a template     ${copies} (${pct(copies)}%)`);
console.log(`  distinct owners          ${owners.size}`);
console.log(`  busiest owner            ${busiest[0]?.[1] ?? 0} registration(s)`);
console.log(`  declare an interface     ${callable.length} (${pct(callable.length)}%)\n`);

// The comparison is the point: a rate among new arrivals means little without
// the rate it is moving away from.
const stats = await getStats().catch(() => null);
const bsc = stats ? bscStats(stats) : undefined;

if (bsc) {
  const chainWide = bsc.mcp_agents + bsc.a2a_agents + bsc.oasf_agents;
  const chainRate = (chainWide / bsc.total_agents) * 100;
  const newRate = (callable.length / sample.length) * 100;

  console.log(`chain-wide, for comparison`);
  console.log(`  roster                   ${bsc.total_agents.toLocaleString()} agents`);
  console.log(`  declare an interface     ${chainWide.toLocaleString()} (${chainRate.toFixed(1)}%)`);
  console.log(`  added today              ${bsc.daily_new_agents.toLocaleString()}\n`);

  const ratio = chainRate === 0 ? 0 : newRate / chainRate;
  if (ratio >= 1.5) {
    console.log(
      `New arrivals declare an interface ${ratio.toFixed(1)}x more often than the roster as a whole.`,
    );
    console.log(`The chain-wide figure describes a backlog, not the agents a buyer meets first.`);
  } else if (ratio <= 0.67) {
    console.log(`New arrivals declare an interface less often than the roster as a whole.`);
  } else {
    console.log(`New arrivals declare an interface at about the chain-wide rate.`);
  }
}

if (copies / sample.length >= 0.5 && owners.size > sample.length / 4) {
  console.log(
    `\n${pct(copies)}% of this sample is a duplicate registration, spread across ` +
      `${owners.size} owners — a template being copied, not one address minting a farm.`,
  );
}
