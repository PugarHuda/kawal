/**
 * What ERC-8004 feedback on BSC is actually made of.
 *
 * Run: npm run reputation           sample 600 records from each end
 *      npm run reputation -- 1000   sample more
 *
 * `assess` used to call any agent with `total_feedbacks > 0` rated, and the
 * home page called the chain-wide ratio "ratings per agent". Both took the
 * registry's word about the one thing left that Kawal had not checked.
 *
 * This checks it. It reads from both ends of the register rather than only the
 * newest, because a recent wave of automated writes would otherwise look like
 * the whole history — and the two ends do differ: the old end carries comments
 * and the tag `get top 1 rank >`, the new end carries neither.
 *
 * Two columns matter and they are not the same. `mark` is the ERC-8004 value
 * the writer set, which is present nearly everywhere. `score` is 8004scan's
 * normalised field, which is what an `average_score` is computed from and is
 * null almost everywhere. Reporting only the second would say the register is
 * empty, which is wrong; reporting only the first would miss that the number
 * the ecosystem publishes is taken over almost nothing.
 *
 * Free. HTTP only, no chain writes.
 */

// Top-level await needs this file to be a module, and it imports nothing.
export {};

const ORIGIN = process.env.SCAN_API_ORIGIN ?? "https://8004scan.io";
const CHAIN = 56;
const PER_END = Number(process.argv[2] ?? 600);
const PAGE = 100;

type Row = {
  score?: number | null;
  value?: string | number | null;
  value_decimals?: number | null;
  comment?: string | null;
  is_revoked?: boolean | null;
  user_address?: string | null;
  tag1?: string | null;
  created_at?: string | null;
};

async function pull(order: "asc" | "desc", want: number): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset < want; offset += PAGE) {
    const url = new URL(`${ORIGIN}/api/v1/feedbacks`);
    url.searchParams.set("chain_id", String(CHAIN));
    url.searchParams.set("limit", String(Math.min(PAGE, want - offset)));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sort_by", "created_at");
    url.searchParams.set("sort_order", order);
    url.searchParams.set("include_revoked", "true");

    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      console.error(`8004scan answered HTTP ${res.status} — stopping at ${rows.length} records`);
      break;
    }
    const body = (await res.json()) as { items?: Row[]; total?: number };
    const items = body.items ?? [];
    rows.push(...items);
    // A short page is the end of the register, not a hiccup.
    if (items.length < PAGE) break;
  }
  return rows;
}

function report(label: string, rows: Row[]) {
  const raters = new Map<string, number>();
  const tags = new Map<string, number>();
  let scored = 0;
  let marked = 0;
  let commented = 0;
  let revoked = 0;
  const marks = new Map<number, number>();

  for (const r of rows) {
    if (typeof r.score === "number") scored++;
    if (r.value !== null && r.value !== undefined && r.value !== "" && Number.isFinite(Number(r.value))) {
      marked++;
      const m = Number(r.value) / 10 ** Number(r.value_decimals ?? 0);
      marks.set(m, (marks.get(m) ?? 0) + 1);
    }
    if (typeof r.comment === "string" && r.comment.trim() !== "") commented++;
    if (r.is_revoked === true) revoked++;
    const who = (r.user_address ?? "").toLowerCase();
    if (who) raters.set(who, (raters.get(who) ?? 0) + 1);
    if (r.tag1) tags.set(r.tag1, (tags.get(r.tag1) ?? 0) + 1);
  }

  const pct = (n: number) => (rows.length === 0 ? "0.0" : ((n / rows.length) * 100).toFixed(1));
  const top = [...raters.entries()].sort((a, b) => b[1] - a[1]);
  const topTags = [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

  console.log(`${label} — ${rows.length} records`);
  console.log(`  span             ${rows[0]?.created_at?.slice(0, 10) ?? "?"} .. ${rows[rows.length - 1]?.created_at?.slice(0, 10) ?? "?"}`);
  console.log(`  carry a mark     ${marked} (${pct(marked)}%)   <- the ERC-8004 value the writer set`);
  console.log(`  in score field   ${scored} (${pct(scored)}%)   <- what an average_score is computed from`);
  const topMarks = [...marks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (topMarks.length > 0) {
    console.log(`  commonest marks  ${topMarks.map(([m, n]) => `${m} (${n})`).join(", ")}  across ${marks.size} distinct`);
  }
  console.log(`  carry a comment  ${commented} (${pct(commented)}%)`);
  console.log(`  withdrawn        ${revoked}`);
  console.log(`  distinct writers ${raters.size}`);
  if (top.length > 0) {
    const busiest = top.slice(0, 3).reduce((n, [, c]) => n + c, 0);
    console.log(`  top 3 writers    ${pct(busiest)}% of everything here`);
    for (const [addr, n] of top.slice(0, 3)) console.log(`    ${addr}  ${n}`);
  }
  if (topTags.length > 0) {
    console.log(`  commonest tags   ${topTags.map(([t, n]) => `${t} (${n})`).join(", ")}`);
  }
  console.log();
  return { scored, marked, raters: raters.size, rows: rows.length };
}

console.log(`reading ERC-8004 feedback on BSC from both ends of the register\n`);

const newest = await pull("desc", PER_END);
const oldest = await pull("asc", PER_END);

const a = report("newest", newest);
const b = report("oldest", oldest);

const totalRows = a.rows + b.rows;
const totalScored = a.scored + b.scored;
const totalMarked = a.marked + b.marked;
const writers = new Set<string>([...newest, ...oldest].map((r) => (r.user_address ?? "").toLowerCase()));
writers.delete("");

console.log("---");
if (totalRows === 0) {
  console.log("Nothing came back. The registry may be rate-limiting; try again shortly.");
  process.exit(0);
}

console.log(
  `${totalMarked} of ${totalRows} records carry a mark (${((totalMarked / totalRows) * 100).toFixed(1)}%) \u2014 this is a graded register.`,
);
console.log(
  `${totalScored} of ${totalRows} appear in the score field (${((totalScored / totalRows) * 100).toFixed(1)}%) \u2014 which is what an average_score averages.`,
);
console.log(`\n${writers.size} distinct addresses wrote all ${totalRows} of them.`);
console.log(`That is the thin part. A count of records is a count of writes, not of opinions,`);
console.log(`so Kawal reports who wrote them on the agent page rather than repeating a total.`);
