/**
 * Coverage report: what does BSC actually hold for each of the four required
 * categories, and how much of it can be hired?
 *
 * Run: npm run audit
 *
 * This is the honesty check on the whole product premise. If the four
 * categories come back empty, the marketplace has nothing to sell -- and that
 * answer is worth knowing on day one rather than day twenty.
 */

import { getStats, bscStats } from "../lib/scan.ts";
import { retrieveAllCategories } from "../lib/catalog.ts";

const stats = await getStats();
const bsc = bscStats(stats);

if (bsc) {
  const withProtocol = bsc.mcp_agents + bsc.a2a_agents + bsc.oasf_agents;
  console.log(`BSC roster        ${bsc.total_agents.toLocaleString()} agents`);
  console.log(
    `declares protocol ${withProtocol.toLocaleString()} (${((withProtocol / bsc.total_agents) * 100).toFixed(1)}%)`,
  );
  console.log(
    `feedbacks         ${bsc.total_feedbacks.toLocaleString()} chain-wide ` +
      `(${(bsc.total_feedbacks / bsc.total_agents).toFixed(3)} per agent)`,
  );
  console.log(`new today         ${bsc.daily_new_agents.toLocaleString()}\n`);
}

const results = await retrieveAllCategories();

console.table(
  results.map((r) => ({
    category: r.category.label,
    core: r.category.core ? "yes" : "",
    retrieved: r.retrieved,
    listable: r.listings.length,
    hireable: r.listings.filter((l) => l.assessment.tier === "hireable").length,
    reachable: r.listings.filter((l) => l.assessment.tier === "reachable").length,
    search: r.semantic ? "semantic" : "keyword",
  })),
);

console.log("\nretrieved = unique agents the registry returned across all probes");
console.log("listable  = survived duplicate collapse and cleared the confidence floor");

for (const r of results) {
  if (!r.category.core) continue;
  const top = r.listings.slice(0, 3);
  console.log(`\n${r.category.label}`);
  if (!top.length) {
    console.log("  (nothing listable — this category has to be supplied, not indexed)");
    continue;
  }
  for (const l of top) {
    console.log(
      `  ${l.assessment.tier.padEnd(10)} ${l.agent.name} ` +
        `[${l.agent.supported_protocols.join(",") || "no protocol"}]` +
        ` conf ${l.classification.confidence}`,
    );
  }
}
