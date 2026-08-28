import Link from "next/link";
import { getStats, bscStats } from "@/lib/scan";
import { CATEGORIES } from "@/lib/taxonomy";
import { seatColor, Stamp, Cell, Legend } from "@/components/listing";
import { observedTotals } from "@/lib/uptime";

/**
 * Form K-1: the cover sheet of the book.
 *
 * Rendered per request so the CSP nonce can reach the scripts. A nonce is
 * only unguessable if it is minted per request, which means the HTML carrying
 * it cannot be built ahead of time; a prerendered shell shipped with no nonce
 * and every Next script on it was refused — the page rendered and never
 * hydrated, which looks like success from the outside.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const [stats, observed] = await Promise.all([getStats().catch(() => null), observedTotals()]);
  const bsc = stats ? bscStats(stats) : undefined;

  const roster = bsc?.total_agents ?? 0;
  const withProtocol = bsc ? bsc.mcp_agents + bsc.a2a_agents + bsc.oasf_agents : 0;
  const perAgent = bsc && bsc.total_agents ? bsc.total_feedbacks / bsc.total_agents : 0;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-8 pb-4">
      {/* ------------------------------------------------ Form K-1 ------ */}
      <section className="sheet sheet--carbon">
        {/* Serial and date strip: what a numbering machine and a date stamp
            leave along the top of every sheet. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-1 · Surat jalan agen · cover sheet</span>
          <span className="serial text-[0.85rem]">
            No. K1-{String(roster).padStart(6, "0")}
          </span>
          <span className="cap">Tgl · {today}</span>
        </div>

        <div className="relative grid gap-px bg-rule lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          {/* The headline entry, typed large. */}
          <div className="cell px-5 pt-6 pb-7 lg:px-7">
            <span className="cap">Keterangan · what this form is for</span>
            <h1 className="typed mt-3 max-w-[16ch] text-[2.1rem] font-bold leading-[1.08] text-balance sm:text-[2.9rem] lg:text-[3.4rem]">
              Most agents on BSC cannot be hired.
            </h1>
            <p className="typed mt-5 max-w-[62ch] text-[1rem] leading-relaxed text-carbon-2">
              Kawal calls every agent itself before it lists one, stamps what
              answered, and lets you put it to work under limits it cannot
              cross — spend cap, allowlist, expiry, revocable at any moment.
            </p>

            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/agents" className="counterfoil">
                Browse agents
              </Link>
              <Link href="/mandate" className="counterfoil counterfoil--quiet">
                See the limits
              </Link>
              <Link href="/advantage" className="counterfoil counterfoil--quiet">
                Read the evidence
              </Link>
            </div>

            <p className="typed mt-6 max-w-[62ch] text-[0.85rem] text-carbon-3">
              An agent can ask too:{" "}
              <a href="/api/mcp" className="underline">
                /api/mcp
              </a>{" "}
              answers over the Model Context Protocol and{" "}
              <a href="/.well-known/agent-card.json" className="underline">
                agent-card.json
              </a>{" "}
              over A2A — dial an agent, ask whether it really charges, read who
              wrote its feedback. No key, nothing to sign.
            </p>
          </div>

          {/* The inspector's own mark, pressed over the count it earned. This
              is the only figure on the sheet Kawal did not copy from the
              registry, and the stamp says so. */}
          <div className="cell cell--yellow relative flex flex-col justify-between px-5 pt-6 pb-7 lg:px-7">
            <span className="cap">Diperiksa oleh · inspected by Kawal itself</span>
            {observed ? (
              <>
                <div className="relative mt-3">
                  <p className="typed text-[3rem] font-bold leading-none sm:text-[3.8rem]">
                    {observed.checks.toLocaleString()}
                    <span className="block text-[0.95rem] font-normal text-carbon-2">
                      calls placed to {observed.endpoints} declared endpoints since{" "}
                      {new Date(observed.since * 1000).toISOString().slice(0, 10)}
                    </span>
                  </p>
                  {/* Pressed over the count it earned, not beside it. */}
                  <span className="absolute right-0 top-[1.7rem] z-10 sm:top-[2.1rem]">
                    <Stamp ink="stamp-violet" size="lg" evidence={observed.checks}>
                      Telah diperiksa
                    </Stamp>
                  </span>
                </div>
                <p className="typed mt-6 max-w-[34ch] text-[0.85rem] text-carbon-2">
                  <strong className="font-bold text-carbon">{observed.answered}</strong> of those endpoints
                  answered. The rest are not there, or speak a protocol this prober does not — recorded as
                  unknown, never counted as a failure.
                </p>
                <p className="stamp-note mt-6">
                  single vantage point · an endpoint that blocks this prober reads as down
                </p>
              </>
            ) : (
              <p className="typed mt-3 text-carbon-2">
                No probes on this instance yet. The first visitor to an agent page makes the first call.
              </p>
            )}
          </div>
        </div>

        {/* Three typed cells from the registry, labelled as the registry's. */}
        {bsc && (
          <div className="cells border-x-0 border-b-0 sm:grid-cols-3">
            <Cell cap="Terdaftar · registered on BSC (8004scan's count)">
              <p className="tnum text-[1.9rem] font-bold leading-tight">{roster.toLocaleString()}</p>
              <span className="text-[0.85rem] text-carbon-2">
                {bsc.daily_new_agents.toLocaleString()} more arrived today; 62.8% of the newest 600 are
                copies of a template across 464 owners
              </span>
            </Cell>
            <Cell cap="Menyatakan antarmuka · declare an interface">
              <p className="text-[1.9rem] font-bold leading-tight">{((withProtocol / roster) * 100).toFixed(1)}%</p>
              <span className="text-[0.85rem] text-carbon-2">
                {withProtocol.toLocaleString()} agents expose MCP, A2A or OASF chain-wide. Among the
                newest 600 it is 38.8% — the register is improving
              </span>
            </Cell>
            <Cell cap="Catatan umpan balik · feedback records per agent">
              <p className="text-[1.9rem] font-bold leading-tight">{perAgent.toFixed(3)}</p>
              <span className="text-[0.85rem] text-carbon-2">
                {bsc.total_feedbacks.toLocaleString()} records chain-wide. A sample of 1,200 found just 53
                addresses behind them — a count of writes, not of opinions
              </span>
            </Cell>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------ legend --- */}
      <div className="mt-6">
        <Legend
          items={[
            { mark: <Stamp ink="stamp-violet" size="sm" flat>Telah diperiksa</Stamp>, means: "Kawal called it and it answered in its declared protocol" },
            { mark: <Stamp ink="stamp-blue" size="sm" flat>Diterima</Stamp>, means: "something answered, not in the declared way" },
            { mark: <Stamp ink="stamp-red" size="sm" flat>Ditolak</Stamp>, means: "called, nobody answered" },
            { mark: <Stamp ink="stamp-grey" size="sm" flat>Belum diperiksa</Stamp>, means: "declares nothing to call" },
          ]}
        />
      </div>

      {/* ------------------------------------------------ the four seats --- */}
      <section className="mt-12">
        <h2 className="heading text-[2rem]">Hire by the job</h2>
        <p className="typed mt-2 max-w-[62ch] text-carbon-2">
          Four seats cover what capital on BSC actually needs. Fill one, or fill them all and let them
          work the same pool under separate limits.
        </p>

        <div className="sheet mt-6">
          <div className="flex items-baseline justify-between gap-6 border-b-[1.5px] border-rule px-5 py-2">
            <span className="cap">Form K-2 · manifes kursi · the four seats</span>
            <span className="cap">No. · kursi · tugas · keterangan</span>
          </div>
          <ol>
            {CATEGORIES.filter((c) => c.core).map((c, i) => (
              <li key={c.id} className="manifest-row last:border-b-0" style={{ ["--seat" as string]: seatColor(c.id) }}>
                <Link
                  href={`/agents?category=${c.id}`}
                  className="grid grid-cols-[3rem_minmax(0,1fr)] items-stretch gap-x-4 no-underline sm:grid-cols-[3rem_11rem_minmax(0,1fr)_auto]"
                >
                  <span className="serial serial--seat self-center pl-5 text-[0.85rem]">{String(i + 1).padStart(2, "0")}</span>
                  <span className="cap self-center py-4" style={{ color: seatColor(c.id) }}>{c.seat}</span>
                  <span className="col-start-2 py-4 pr-5 sm:col-start-3">
                    <h3 className="heading text-[1.5rem]">{c.label}</h3>
                    <span className="typed block text-[0.9rem] text-carbon-2">{c.blurb}</span>
                  </span>
                  <span className="cap col-start-2 self-center pb-4 sm:col-start-4 sm:py-4 sm:pr-5">Open form →</span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}
