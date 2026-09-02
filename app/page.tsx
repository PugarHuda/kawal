import { Suspense } from "react";
import Link from "next/link";
import { getStats, bscStats, registryAsOf, type ScanStats } from "@/lib/scan";
import { CATEGORIES } from "@/lib/taxonomy";
import { seatColor, Stamp, Cell, Legend } from "@/components/listing";
import { observedTotals, type Observed } from "@/lib/uptime";
import { Trending } from "@/components/trending";

/**
 * Form K-1: the cover sheet of the book.
 *
 * Rendered per request so the CSP nonce can reach the scripts. A nonce is
 * only unguessable if it is minted per request, which means the HTML carrying
 * it cannot be built ahead of time; a prerendered shell shipped with no nonce
 * and every Next script on it was refused — the page rendered and never
 * hydrated, which looks like success from the outside.
 *
 * The headline and the counterfoils are static and flush first. Every figure
 * that has to be fetched — the probe count from the database, the roster
 * from the registry — sits under its own Suspense boundary and types itself
 * in when it lands, so a slow registry cannot hold the first paint. Measured
 * before this split: the largest paint on a phone waited 4.3 s on
 * `observedTotals()`.
 */
export const dynamic = "force-dynamic";

/** The three research figures on the sheet were taken once, by hand, and dated. */
const SAMPLED = "sampled 2026-08-26";

export default async function Home() {
  // Started here, awaited inside the boundaries: one call each, shared by
  // every cell that reads it, and none of them on the critical path.
  const stats = getStats().catch(() => null);
  const observed = observedTotals();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-8 pb-4">
      {/* ------------------------------------------------ Form K-1 ------ */}
      <section className="sheet sheet--carbon">
        {/* Serial and date strip: what a numbering machine and a date stamp
            leave along the top of every sheet. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-1 · cover sheet</span>
          <Suspense fallback={<span className="serial text-[0.85rem]">No. K1-······</span>}>
            <Serial stats={stats} />
          </Suspense>
          <span className="cap">Date · {today}</span>
          <Suspense fallback={null}>
            <RegistryAsOf stats={stats} />
          </Suspense>
        </div>

        <div className="relative grid gap-px bg-rule lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          {/* The headline entry, typed large. */}
          <div className="cell px-5 pt-6 pb-7 lg:px-7">
            <span className="cap">Key · what this form is for</span>
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
            <span className="cap">Inspected by Kawal itself</span>
            <Suspense fallback={<InspectedBlank />}>
              <Inspected observed={observed} />
            </Suspense>
          </div>
        </div>

        {/* Three typed cells from the registry, labelled as the registry's. */}
        <Suspense fallback={<RegistryBlank />}>
          <RegistryCells stats={stats} />
        </Suspense>
      </section>

      {/* ------------------------------------------------------ legend --- */}
      <div className="mt-6">
        <Legend
          items={[
            { mark: <Stamp ink="stamp-violet" size="sm" flat>Hireable</Stamp>, means: "Kawal called it and it answered in its declared protocol" },
            { mark: <Stamp ink="stamp-blue" size="sm" flat>Reachable</Stamp>, means: "something answered, not in the declared way" },
            { mark: <Stamp ink="stamp-red" size="sm" flat>Does not answer</Stamp>, means: "called, nobody answered" },
            { mark: <Stamp ink="stamp-grey" size="sm" flat>Registered only</Stamp>, means: "declares nothing to call" },
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
            <span className="cap">Form K-2 · the four seats</span>
            <span className="cap">No. · seat · task · notes</span>
          </div>
          <ol>
            {CATEGORIES.filter((c) => c.core).map((c, i) => (
              <li key={c.id} className="manifest-row last:border-b-0" style={{ ["--seat" as string]: seatColor(c.id) }}>
                {/* The whole line is the link and its text is its name:
                    serial, seat, heading, blurb, in that order. Naming it by
                    the heading alone made the accessible name shorter than
                    the visible text, which a screen-reader user cannot
                    reconcile. The arrow is the printed mark, not a second
                    affordance. */}
                <Link
                  href={`/agents?category=${c.id}`}
                  className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-stretch gap-x-4 no-underline sm:grid-cols-[3rem_11rem_minmax(0,1fr)_auto]"
                >
                  <span className="serial serial--seat self-center pl-5 text-[0.85rem]">{String(i + 1).padStart(2, "0")}</span>
                  <span className="cap self-center py-4" style={{ color: seatColor(c.id) }}>{c.seat}</span>
                  <span className="col-start-2 py-4 pr-5 sm:col-start-3">
                    <h3 id={`seat-${c.id}`} className="heading text-[1.5rem]">{c.label}</h3>
                    <span className="typed block text-[0.9rem] text-carbon-2">{c.blurb}</span>
                  </span>
                  <span aria-hidden className="heading col-start-3 self-center pr-5 text-[1.5rem] sm:col-start-4">→</span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ------------------------------------------- what is trending --- */}
      {/* Streamed after the seats: it reads five detail records and the
          probe history, and the cover sheet must not wait on either. An
          outage upstream leaves nothing here rather than a notice. */}
      <Suspense fallback={null}>
        <Trending />
      </Suspense>
    </div>
  );
}

/** The numbering machine's strike: the roster count, once the registry says. */
async function Serial({ stats }: { stats: Promise<ScanStats | null> }) {
  const s = await stats;
  const bsc = s ? bscStats(s) : undefined;
  return <span className="serial text-[0.85rem]">No. K1-{String(bsc?.total_agents ?? 0).padStart(6, "0")}</span>;
}

/**
 * The registry's figures come through a five-minute cache; the date in the
 * strip is when this sheet was printed, this is when the registry last spoke.
 */
async function RegistryAsOf({ stats }: { stats: Promise<ScanStats | null> }) {
  const s = await stats;
  const asOf = registryAsOf();
  if (!s || !asOf) return null;
  return <span className="cap">Registry data as of {asOf.replace("T", " ").slice(0, 16)} UTC</span>;
}

/** The yellow cell before the count lands: the same lines, the value blank. */
function InspectedBlank() {
  return (
    <div className="mt-3" aria-busy="true">
      <span className="typed block text-[3rem] font-bold leading-none text-carbon-3 sm:text-[3.8rem]">—</span>
      <span className="typed mt-2 block text-[0.95rem] text-carbon-2">reading the probe history…</span>
    </div>
  );
}

async function Inspected({ observed }: { observed: Promise<Observed | null> }) {
  const o = await observed;
  if (!o) {
    return (
      <p className="typed mt-3 text-carbon-2">
        No probes on this instance yet. The first visitor to an agent page makes the first call.
      </p>
    );
  }
  return (
    <>
      <div className="mt-3">
        <p className="typed relative inline-block text-[3rem] font-bold leading-none sm:text-[3.8rem]">
          {o.checks.toLocaleString()}
          {/* Pressed against the count's edge and out into the margin. It
              used to sit 2.2rem in — a whole digit at this size — on the
              theory that the last digit was not something the reader still
              needed, and 2,92▮ is not a number. A stamp certifies a figure by
              touching it, not by covering it. */}
          <span className="stamp-responsive absolute -top-1 right-0 z-10 translate-x-[calc(100%-0.5rem)] sm:translate-x-[calc(100%-0.7rem)]">
            <Stamp ink="stamp-violet" size="lg" evidence={o.checks}>
              Hireable
            </Stamp>
          </span>
        </p>
        <p className="typed mt-2 text-[0.95rem] text-carbon-2">
          calls placed to {o.endpoints} declared endpoints since {new Date(o.since * 1000).toISOString().slice(0, 10)}
        </p>
      </div>
      <p className="typed mt-6 max-w-[34ch] text-[0.85rem] text-carbon-2">
        <strong className="font-bold text-carbon">{o.answered}</strong> of those endpoints answered. The rest are not
        there, or speak a protocol this prober does not — recorded as unknown, never counted as a failure.
      </p>
      <p className="stamp-note mt-6">single vantage point · an endpoint that blocks this prober reads as down</p>
    </>
  );
}

const REGISTRY_CAPS = [
  "Registered on BSC (8004scan's count)",
  "Interface declarations",
  "Feedback records per agent",
] as const;

/**
 * The three registry cells with the values not yet typed. A `span`, not the
 * `p.tnum` the real cell prints: the suite reads the first `p.tnum` on the
 * page as the roster figure, and a blank one arriving first would be read
 * instead.
 */
function RegistryBlank() {
  return (
    <div className="cells border-x-0 border-b-0 sm:grid-cols-3" aria-busy="true">
      {REGISTRY_CAPS.map((cap) => (
        <Cell key={cap} cap={cap}>
          <span className="block text-[1.9rem] font-bold leading-tight text-carbon-3">—</span>
          <span className="text-[0.85rem] text-carbon-2">reading the registry…</span>
        </Cell>
      ))}
    </div>
  );
}

async function RegistryCells({ stats }: { stats: Promise<ScanStats | null> }) {
  const s = await stats;
  const bsc = s ? bscStats(s) : undefined;
  if (!bsc) return null;

  const roster = bsc.total_agents;
  // A sum of per-protocol counts, so an agent declaring MCP and A2A is in it
  // twice. The registry offers no distinct count, so the cell says
  // "declarations" rather than "agents" and does not divide by the roster
  // when there is none.
  const declarations = bsc.mcp_agents + bsc.a2a_agents + bsc.oasf_agents;
  const declaredShare = roster > 0 ? `${((declarations / roster) * 100).toFixed(1)}%` : "—";
  const perAgent = roster > 0 ? (bsc.total_feedbacks / roster).toFixed(3) : "—";

  return (
    <div className="cells border-x-0 border-b-0 sm:grid-cols-3">
      <Cell cap={REGISTRY_CAPS[0]}>
        <p className="tnum text-[1.9rem] font-bold leading-tight">{roster.toLocaleString()}</p>
        <span className="text-[0.85rem] text-carbon-2">
          {bsc.daily_new_agents.toLocaleString()} more arrived today
        </span>
        <span className="stamp-note mt-1 block">
          62.8% of the newest 600 are copies of a template across 464 owners · {SAMPLED},{" "}
          <code>npm run roster</code>
        </span>
      </Cell>
      <Cell cap={REGISTRY_CAPS[1]}>
        <p className="text-[1.9rem] font-bold leading-tight">{declaredShare}</p>
        <span className="text-[0.85rem] text-carbon-2">
          {declarations.toLocaleString()} declarations chain-wide, where agents expose MCP, A2A or
          OASF — one declaring two is counted twice
        </span>
        <span className="stamp-note mt-1 block">
          among the newest 600 the share is 38.8% — the register is improving · {SAMPLED},{" "}
          <code>npm run roster</code>
        </span>
      </Cell>
      <Cell cap={REGISTRY_CAPS[2]}>
        <p className="text-[1.9rem] font-bold leading-tight">{perAgent}</p>
        <span className="text-[0.85rem] text-carbon-2">
          {bsc.total_feedbacks.toLocaleString()} records chain-wide — a count of writes, not of
          opinions
        </span>
        <span className="stamp-note mt-1 block">
          a sample of 1,200 found just 53 addresses behind them · {SAMPLED},{" "}
          <code>npm run reputation</code>
        </span>
      </Cell>
    </div>
  );
}
