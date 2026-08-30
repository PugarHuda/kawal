import Link from "next/link";
import { trendingListings, type TrendingRow } from "@/lib/liveness";
import type { TrendingPeriod } from "@/lib/scan";
import { categoryLabel, seatColor, TierStamp } from "@/components/listing";

/*
 * Moving this week.
 *
 * The registry's own trending list — attention, by its own definition — with
 * Kawal's stamp beside each line. The order is 8004scan's and the stamp is
 * Kawal's, and the sheet exists for the rows where they disagree: an agent
 * everyone is looking at that has never answered a call.
 *
 * Nothing is dialled for this. Each row reads the record Kawal already
 * keeps, so a cover sheet that lists five agents does not make five calls to
 * strangers' servers on every visit. A row Kawal has never called says so.
 */

/** Trending is drawn as a shortlist, not a second manifest. */
const SHOWN = 5;
/** "This week": the middle of the registry's three windows. */
const PERIOD: TrendingPeriod = "7d";

async function load(): Promise<{ rows: TrendingRow[]; asOf: string } | null> {
  try {
    const { rows, asOf } = await trendingListings(PERIOD, SHOWN);
    return rows.length > 0 ? { rows: rows.slice(0, SHOWN), asOf } : null;
  } catch {
    // A registry that will not say what is trending leaves no section, not
    // an error: the cover sheet has its own entries to stand on.
    return null;
  }
}

/**
 * The section, as manifest lines.
 *
 * `inset` draws it inside another sheet (the K-2 manifest) rather than as a
 * sheet of its own; the rows are the same either way.
 */
export async function Trending({ inset = false }: { inset?: boolean }) {
  const data = await load();
  if (!data) return null;

  const strip = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b-[1.5px] border-rule px-5 py-2">
      <span className="cap">
        Moving this week
      </span>
      <span className="cap">8004scan&rsquo;s trend, {PERIOD} · Kawal&rsquo;s stamp</span>
    </div>
  );

  const rows = (
    <ol>
      {data.rows.map(({ rank, listing, measured }) => {
        const { agent, classification, assessment } = listing;
        const observed = assessment.signals.find((s) => s.key === "observed");
        return (
          <li
            key={agent.agent_id}
            className="manifest-row grid grid-cols-[3rem_minmax(0,1fr)] items-start gap-x-4 py-4 last:border-b-0 sm:grid-cols-[3rem_minmax(0,1fr)_auto]"
            style={{ ["--seat" as string]: seatColor(classification.category) }}
          >
            <span className="serial serial--seat self-center text-[0.85rem]">{String(rank).padStart(2, "0")}</span>
            <span className="min-w-0">
              <h3 className="heading text-[1.35rem]">
                <Link href={`/agents/${agent.chain_id}/${agent.token_id}`} className="no-underline hover:underline">
                  {agent.name}
                </Link>
              </h3>
              <span className="cap block" style={{ color: seatColor(classification.category) }}>
                {categoryLabel(classification.category)} · trending #{rank} on 8004scan
              </span>
              {/* The contrast, typed: what the registry's attention is
                  attached to, as Kawal has seen it answer or not. */}
              {observed && (
                <span className={`typed block text-[0.85rem] ${observed.pass ? "text-carbon-2" : "text-carbon-3"}`}>{observed.detail}</span>
              )}
            </span>
            <span className="col-start-2 mt-2 flex items-center gap-3 sm:col-start-3 sm:mt-1">
              <TierStamp tier={assessment.tier} evidence={measured?.observed?.checks ?? null} />
            </span>
          </li>
        );
      })}
    </ol>
  );

  const note = (
    <p className="stamp-note border-t-[1.5px] border-rule px-5 py-3 max-w-none">
      Attention, not evidence: 8004scan ranks by who looked, and the stamp is what Kawal found when it
      called. Registry data as of {data.asOf.replace("T", " ").slice(0, 16)} UTC.
    </p>
  );

  if (inset) {
    return (
      <section aria-label="Moving this week" className="border-t-[1.5px] border-rule">
        {strip}
        <div className="px-5">{rows}</div>
        {note}
      </section>
    );
  }

  return (
    <section aria-label="Moving this week" className="mt-12">
      <h2 className="heading text-[2rem]">What the registry is watching</h2>
      <p className="typed mt-2 max-w-[62ch] text-carbon-2">
        The five agents 8004scan&rsquo;s visitors looked at most this week, each with the stamp Kawal
        pressed after calling. The two do not always agree, and that is the point.
      </p>
      <div className="sheet mt-6">
        {strip}
        <div className="px-5">{rows}</div>
        {note}
      </div>
    </section>
  );
}
