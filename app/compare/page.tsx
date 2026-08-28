import Link from "next/link";
import { TierStamp } from "@/components/listing";
import { loadColumn, parseRefs, type Column } from "@/lib/compare";

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
 */

export const metadata = {
  title: "Compare agents",
  description: "Put two or three BNB Chain agents side by side before hiring one.",
};

export default async function ComparePage({ searchParams }: PageProps<"/compare">) {
  const params = await searchParams;
  const refs = parseRefs(params.ids);

  const columns = (await Promise.all(refs.map((r) => loadColumn(r.chainId, r.tokenId)))).filter(
    (c): c is Column => c !== null,
  );

  if (columns.length === 0) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 pt-8 pb-4">
        <section className="sheet">
          <div className="flex items-baseline justify-between border-b-[1.5px] border-rule px-5 py-2">
            <span className="cap">Form K-4 · perbandingan · comparison</span>
            <span className="serial text-[0.85rem]">No. —</span>
          </div>
          <div className="px-5 py-6">
            <h1 className="typed text-[2rem] font-bold leading-[1.1] sm:text-[2.6rem]">Compare agents</h1>
            <p className="typed mt-3 max-w-[60ch] text-carbon-2">
              Pick agents from a category listing and open them here together. The address bar takes
              them as <code className="font-bold">?ids=56:43129,56:45422</code>.
            </p>
            <p className="mt-6">
              <Link href="/agents" className="counterfoil counterfoil--quiet">
                ← Browse agents
              </Link>
            </p>
          </div>
        </section>
      </div>
    );
  }

  const missing = refs.length - columns.length;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-8 pb-4">
      <section className="sheet sheet--carbon">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-4 · perbandingan · the same questions of each</span>
          <span className="serial text-[0.85rem]">No. {columns.map((c) => c.ref).join(" · ")}</span>
        </div>

        <header className="border-b-[1.5px] border-rule px-5 py-5">
          <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem]">{columns.map((c) => c.agent.name).join("  ·  ")}</h1>
          {missing > 0 && (
            <p className="cap mt-2">{missing} of the requested agents could not be loaded and are not shown.</p>
          )}
        </header>

        <div className="overflow-x-auto px-5 pb-2">
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
                        {c.category} · {Math.round(c.confidence * 100)}%
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              <Row label="Can you hire it" columns={columns}>
                {(c) => (
                  // The stamp's own text is the tier label, so no second copy:
                  // a hidden duplicate would make "Hireable" resolve twice.
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

              <Row label="Track record" columns={columns}>
                {(c) => (
                  <span>
                    {c.agent.total_feedbacks === 0
                      ? "never rated"
                      : `${c.agent.total_feedbacks} feedbacks, avg ${c.agent.average_score.toFixed(1)}`}
                  </span>
                )}
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

              <Row label="Registry score" columns={columns}>
                {(c) => <span>{c.agent.total_score.toFixed(2)}</span>}
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
            </tbody>
          </table>
        </div>

        <p className="stamp-note border-t-[1.5px] border-rule px-5 py-4 max-w-none">
          Prices are what each agent states in its own tool descriptions. Nothing here has been paid
          or independently confirmed — 8004scan carries no price field at all, so this is the
          agent&rsquo;s claim, surfaced rather than hidden.
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
