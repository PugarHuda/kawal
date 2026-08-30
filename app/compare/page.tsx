import Link from "next/link";
import { ListingRow, TierStamp } from "@/components/listing";
import { CompareSubmit } from "@/components/compare-submit";
import { browse } from "@/lib/catalog";
import { mapLimit } from "@/lib/concurrency";
import { loadColumn, parseRefs, MAX_COLUMNS, type Column } from "@/lib/compare";
import { weakestV5 } from "@/lib/signals";

/**
 * Form K-4: two or three agents, the same questions asked of each.
 *
 * The rubric asks that a user "make a genuinely informed call", and a single
 * agent page cannot do that — judging one in isolation means holding the
 * alternatives in your head. Every row here is a question someone actually
 * weighs before handing over a spend cap: can it be called, does it answer
 * right now, how fast, what will it do, what does it say that costs, and what
 * is being held against it.
 *
 * Deliberately shows the disagreements rather than a combined score. A single
 * number would hide exactly the thing worth seeing: an agent can be the
 * fastest, the best rated, and still be the one whose domain does not verify.
 *
 * Rendered per request: the CSP nonce is minted per request, and every
 * column is a call made now.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Compare agents",
  description: "Put two or three BNB Chain agents side by side before hiring one.",
};

/** How many rows the empty state offers to tick. Enough to choose from, short of a manifest. */
const OFFERED = 8;

export default async function ComparePage({ searchParams }: PageProps<"/compare">) {
  const params = await searchParams;
  const { refs, rejected, truncated } = parseRefs(params.ids);

  // Two at a time: each column is four registry reads and a call to a
  // stranger's server, and three of those at once is the whole budget.
  const columns = (await mapLimit(refs, 2, (r) => loadColumn(r.chainId, r.tokenId))).filter(
    (c): c is Column => c !== null,
  );
  const missing = refs.length - columns.length;

  const notes = [
    rejected > 0 && `${rejected} id${rejected === 1 ? " was" : "s were"} not readable — the form takes chain:token, e.g. 56:43129`,
    truncated > 0 && `${truncated} beyond three ignored`,
    missing > 0 && `${missing} of the requested agents could not be loaded and ${missing === 1 ? "is" : "are"} not shown`,
    refs.length === 1 && columns.length === 1 && "one agent is not a comparison — tick another below",
  ].filter((n): n is string => typeof n === "string");

  if (columns.length < 2) return <Offer notes={notes} carry={columns.map((c) => c.ref)} />;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-8 pb-4">
      <section className="sheet sheet--carbon">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-4 · perbandingan · the same questions of each</span>
          <span className="serial text-[0.85rem]">No. {columns.map((c) => c.ref).join(" · ")}</span>
        </div>

        <header className="border-b-[1.5px] border-rule px-5 py-5">
          <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem]">{columns.map((c) => c.agent.name).join("  ·  ")}</h1>
          {notes.map((n) => (
            <p key={n} className="cap mt-2">
              {n}
            </p>
          ))}
        </header>

        {/* `relative` so the counterfoils' perforated edges, which are positioned
            absolutely, take this scroller as their containing block and scroll
            with the table instead of widening the page. */}
        <div className="relative overflow-x-auto px-5 pb-2">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                <th className="cap w-40 border-b-[1.5px] border-rule py-3 pr-4 align-bottom font-600">Question</th>
                {columns.map((c) => (
                  <th key={c.ref} className="border-b-[1.5px] border-rule py-3 pl-6 align-bottom">
                    <span className="block border-b-[3px] pb-2" style={{ borderColor: c.color }}>
                      <Link
                        href={`/agents/${c.agent.chain_id}/${c.agent.token_id}`}
                        className="heading block text-[1.25rem] no-underline hover:underline"
                      >
                        {c.agent.name}
                      </Link>
                      <span className="cap block" style={{ color: c.color }}>
                        {c.category} · {Math.round(c.confidence * 100)}% (Kawal&rsquo;s classifier)
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              <Row label="Can you hire it" columns={columns}>
                {(c) => (
                  // The stamp carries the tier text itself, so no second copy:
                  // a duplicate would make "Hireable" resolve twice.
                  <TierStamp tier={c.assessment.tier} evidence={c.uptime?.checks ?? null} />
                )}
              </Row>

              <Row label="Answers right now" columns={columns}>
                {(c) =>
                  !c.proof ? (
                    <span className="text-carbon-3">no MCP or A2A endpoint declared</span>
                  ) : c.proof.answered ? (
                    <span className="text-stamp-green">
                      yes, {c.proof.protocol.toUpperCase()} in {c.proof.latencyMs} ms
                    </span>
                  ) : (
                    <span className="text-stamp-red">no — {c.proof.error?.slice(0, 60) ?? "did not answer"}</span>
                  )
                }
              </Row>

              <Row label="Keeps answering" columns={columns}>
                {(c) =>
                  !c.uptime || c.uptime.checks < 2 ? (
                    <span className="text-carbon-3">only one check so far</span>
                  ) : (
                    <span>
                      {c.uptime.answered}/{c.uptime.checks} since {new Date(c.uptime.since * 1000).toISOString().slice(0, 10)}
                      {c.uptime.medianMs !== null && ` · median ${c.uptime.medianMs} ms`}
                    </span>
                  )
                }
              </Row>

              <Row label="What it can do" columns={columns}>
                {(c) =>
                  c.proof?.toolCount ? (
                    <span>
                      {c.proof.toolCount} {c.proof.protocol === "a2a" ? "skills" : "tools"}
                    </span>
                  ) : (
                    <span className="text-carbon-3">nothing listed</span>
                  )
                }
              </Row>

              <Row label="Declared price" columns={columns}>
                {(c) => {
                  const priced = c.proof?.tools.filter((t) => t.declaredPrice) ?? [];
                  if (priced.length === 0) {
                    const free = c.proof?.tools.some((t) => t.declaredFree);
                    return <span className="text-carbon-3">{free ? "declares free" : "not stated"}</span>;
                  }
                  return (
                    <span className="text-stamp-green">
                      {priced
                        .map((t) => `${t.declaredPrice!.amount} ${t.declaredPrice!.token}`)
                        .filter((v, i, a) => a.indexOf(v) === i)
                        .join(", ")}
                    </span>
                  );
                }}
              </Row>

              {/* The x402 flag is a registration's claim about itself. Where
                  there was an endpoint to ask, Kawal sent the protocol's own
                  opening request and reports what came back. */}
              <Row label="Asked to charge" columns={columns}>
                {(c) =>
                  c.payment ? (
                    c.payment.demanded ? (
                      <span className="text-stamp-green">quoted {c.payment.quote ?? "a price"}</span>
                    ) : (
                      <span className="text-carbon-3">claims x402, asked for nothing</span>
                    )
                  ) : c.agent.x402_supported ? (
                    <span className="text-carbon-3">claims x402 · nothing to ask</span>
                  ) : (
                    <span className="text-carbon-3">no x402 flag · not asked</span>
                  )
                }
              </Row>

              <Row label="Domain proven" columns={columns}>
                {(c) => {
                  const services = c.quality?.endpoint_health?.services ?? [];
                  const checked = services.filter((s) => s.status !== "skipped");
                  if (checked.length === 0) return <span className="text-carbon-3">not checked</span>;
                  const verified = checked.filter((s) => s.domain_verified).length;
                  return verified === checked.length ? (
                    <span className="text-stamp-green">all {checked.length}</span>
                  ) : (
                    <span className="text-stamp-red">
                      {verified} of {checked.length}
                    </span>
                  );
                }}
              </Row>

              {/* Who wrote it, not how much of it there is: the same reading
                  the inspection sheet makes, in the same words. */}
              <Row label="Track record" columns={columns}>
                {(c) => {
                  const rated = c.assessment.signals.find((s) => s.key === "rated");
                  return <span className={rated?.pass ? "" : "text-carbon-3"}>{rated?.detail ?? "not read"}</span>;
                }}
              </Row>

              <Row label="Score trend" columns={columns}>
                {(c) => {
                  const h = c.history;
                  if (!h || h.data_points < 2 || h.score_change === null) {
                    return <span className="text-carbon-3">no history yet</span>;
                  }
                  const up = h.score_change > 0.5;
                  const down = h.score_change < -0.5;
                  return (
                    <span className={up ? "text-stamp-green" : down ? "text-stamp-red" : ""}>
                      {up ? "rising" : down ? "falling" : "flat"} ({h.score_change >= 0 ? "+" : ""}
                      {h.score_change.toFixed(2)} / {h.period_days}d)
                    </span>
                  );
                }}
              </Row>

              {/* The registry's one number, with the part holding it down
                  named: a 40 short on compliance and a 40 short on momentum
                  are different agents to hire. */}
              <Row label="Score v5" columns={columns}>
                {(c) => {
                  const weakest = weakestV5(c.scoreV5);
                  if (!weakest) {
                    return (
                      <span>
                        {c.agent.total_score.toFixed(2)}
                        <span className="text-carbon-3"> · no v5 breakdown from 8004scan</span>
                      </span>
                    );
                  }
                  return (
                    <span>
                      {c.scoreV5!.total_score.toFixed(2)}
                      <span className="text-carbon-3">
                        {" "}
                        · weakest {weakest.label.toLowerCase()} {weakest.dimension.score.toFixed(0)}/100 × {weakest.weightPct}
                      </span>
                    </span>
                  );
                }}
              </Row>

              <Row label="Flagged risks" columns={columns}>
                {(c) => {
                  const flags = c.quality?.risk_flags ?? [];
                  if (flags.length === 0) return <span className="text-carbon-3">none</span>;
                  return (
                    <ul className="space-y-1">
                      {flags.slice(0, 4).map((f) => (
                        <li key={f.id}>
                          <span className="cap mr-2">{f.severity}</span>
                          {f.title}
                        </li>
                      ))}
                    </ul>
                  );
                }}
              </Row>

              <Row label="Registered" columns={columns}>
                {(c) => <span>{new Date(c.agent.created_at).toISOString().slice(0, 10)}</span>}
              </Row>

              <Row label="Checked at" columns={columns}>
                {(c) => (
                  <span className="text-carbon-3">
                    {c.checkedAt.replace("T", " ").slice(0, 19)} UTC
                    {c.proof ? " · called from here" : " · nothing to call, registry read only"}
                  </span>
                )}
              </Row>

              <Row label="Next" columns={columns}>
                {(c) => (
                  <span className="flex flex-col items-start gap-2">
                    <Link
                      href={`/mandate?${c.categoryId ? `seat=${c.categoryId}&` : ""}agent=${c.ref}`}
                      className="counterfoil counterfoil--quiet"
                    >
                      Hire under a cap →
                    </Link>
                    <Link href={`/agents/${c.agent.chain_id}/${c.agent.token_id}`} className="counterfoil counterfoil--quiet">
                      View form
                    </Link>
                  </span>
                )}
              </Row>
            </tbody>
          </table>
        </div>

        <p className="stamp-note border-t-[1.5px] border-rule px-5 py-4 max-w-none">
          Prices are what each agent states in its own tool descriptions. Nothing here has been paid
          or independently confirmed — 8004scan carries no price field at all, so this is the
          agent&rsquo;s claim, surfaced rather than hidden. The seat and confidence under each name are
          Kawal&rsquo;s keyword classifier, not registry data.
        </p>
      </section>

      <p className="mt-6">
        <Link href="/agents" className="counterfoil counterfoil--quiet">
          ← Back to the listing
        </Link>
      </p>
    </div>
  );
}

/**
 * The form with nothing on it yet.
 *
 * Offers the strongest of the roster as rows to tick rather than a sentence
 * about address-bar syntax: the visitor this page exists for has a job in
 * mind, not a token id. When the registry is down there is nothing to offer,
 * and the sheet says so.
 *
 * `carry` is a lone id that did load: it stays ticked (or hidden, when it is
 * not among the offered rows) so the visitor only has to add one more.
 */
async function Offer({ notes, carry }: { notes: string[]; carry: string[] }) {
  const rows = await browse()
    .then((r) => r.listings.filter((l) => l.assessment.tier === "hireable").slice(0, OFFERED))
    .catch(() => null);
  const offered = new Set(rows?.map((l) => `${l.agent.chain_id}:${l.agent.token_id}`));
  const hidden = carry.filter((ref) => !offered.has(ref));

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-8 pb-4">
      <section className="sheet">
        <div className="flex items-baseline justify-between border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-4 · perbandingan · comparison</span>
          <span className="serial text-[0.85rem]">No. —</span>
        </div>
        <div className="px-5 py-6">
          <h1 className="typed text-[2rem] font-bold leading-[1.1] sm:text-[2.6rem]">Compare agents</h1>
          <p className="typed mt-3 max-w-[60ch] text-carbon-2">
            Tick two or three and the same questions are put to each: can it be called, does it
            answer now, what it says it charges, who wrote its feedback.
          </p>
          {notes.map((n) => (
            <p key={n} className="cap mt-2">
              {n}
            </p>
          ))}
        </div>

        <form method="get" action="/compare" className="border-t-[1.5px] border-rule">
          <h2 className="sr-only">Agents to tick</h2>
          {hidden.map((ref) => (
            <input key={ref} type="hidden" name="ids" value={ref} />
          ))}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b-[1.5px] border-rule px-5 py-3">
            <CompareSubmit max={MAX_COLUMNS} />
            <span className="cap">the strongest of the roster, by evidence · unchecked here, so the stamps print at base ink</span>
          </div>
          {rows === null ? (
            <p className="typed bg-paper-pink px-5 py-6 text-carbon-2">
              The 8004scan registry did not respond, so there is nothing to offer for ticking until it
              comes back.
            </p>
          ) : rows.length === 0 ? (
            <p className="typed bg-paper-pink px-5 py-6 text-carbon-2">
              Nothing on the roster currently declares both an interface and a way to pay.
            </p>
          ) : (
            <div className="px-5">
              {rows.map((l) => (
                <ListingRow
                  key={l.agent.agent_id}
                  listing={l}
                  selectable
                  checked={carry.includes(`${l.agent.chain_id}:${l.agent.token_id}`)}
                />
              ))}
            </div>
          )}
        </form>

        <p className="stamp-note border-t-[1.5px] border-rule px-5 py-4 max-w-none">
          The address bar takes the same pairs directly: /compare?ids=56:43129,56:45422
        </p>
      </section>

      <p className="mt-6">
        <Link href="/agents" className="counterfoil counterfoil--quiet">
          ← Browse agents
        </Link>
      </p>
    </div>
  );
}

function Row({
  label,
  columns,
  children,
}: {
  label: string;
  columns: Column[];
  children: (c: Column) => React.ReactNode;
}) {
  return (
    <tr className="border-b border-rule-soft align-top">
      <th scope="row" className="cap py-3.5 pr-4 font-600">
        {label}
      </th>
      {columns.map((c) => (
        <td key={c.ref} className="typed py-3.5 pl-6 text-[0.88rem]">
          {children(c)}
        </td>
      ))}
    </tr>
  );
}
