import Link from "next/link";
import { getStats, bscStats } from "@/lib/scan";
import { CATEGORIES } from "@/lib/taxonomy";
import { seatColor } from "@/components/listing";
import { observedTotals } from "@/lib/uptime";

/**
 * Rendered per request so the CSP nonce can reach the scripts.
 *
 * A nonce is only unguessable if it is minted per request, which means the
 * HTML carrying it cannot be built ahead of time. This page was the one
 * statically prerendered route, so its markup shipped with no nonce at all and
 * every Next script was refused — the page rendered and never hydrated, which
 * looks like success from the outside.
 *
 * The alternative was `script-src 'unsafe-inline'`, which would have weakened
 * the exact thing a CSP is for. Rendering costs little here: the chain figures
 * below still come from the five-minute fetch cache, so this trades a
 * prerendered shell for a real policy, not a slower page.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const stats = await getStats().catch(() => null);
  const observed = observedTotals();
  const bsc = stats ? bscStats(stats) : undefined;

  const roster = bsc?.total_agents ?? 0;
  const withProtocol = bsc ? bsc.mcp_agents + bsc.a2a_agents + bsc.oasf_agents : 0;
  const perAgent = bsc && bsc.total_agents ? bsc.total_feedbacks / bsc.total_agents : 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-6">
      <section className="border-b border-rule py-16">
        <p className="label">BNB Smart Chain · ERC-8004</p>
        <h1 className="mt-5 max-w-3xl text-4xl font-bold leading-[1.05] tracking-[-0.035em] sm:text-6xl">
          Most agents on BSC cannot be hired.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-2">
          Kawal lists the ones that can, shows you why, and lets you put them to
          work under limits you set — spend cap, allowlist, expiry, revocable at
          any moment.
        </p>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            href="/agents"
            className="rounded-sm bg-ink px-5 py-2.5 text-sm font-medium text-ground hover:opacity-90"
          >
            Browse agents
          </Link>
          <Link
            href="/mandate"
            className="rounded-sm border border-rule-2 px-5 py-2.5 text-sm font-medium text-ink-2 hover:text-ink"
          >
            See the limits
          </Link>
          <Link
            href="/advantage"
            className="rounded-sm border border-rule-2 px-5 py-2.5 text-sm font-medium text-ink-2 hover:text-ink"
          >
            Read the evidence
          </Link>
        </div>
      </section>

      {bsc && (
        <section className="grid gap-px border-b border-rule bg-rule sm:grid-cols-3">
          <Figure
            value={roster.toLocaleString()}
            label="registered on BSC"
            note={`${bsc.daily_new_agents.toLocaleString()} more arrived today`}
          />
          <Figure
            value={`${((withProtocol / roster) * 100).toFixed(1)}%`}
            label="declare an interface"
            note={`${withProtocol.toLocaleString()} agents expose MCP, A2A or OASF — the rest cannot be called at all`}
          />
          {/* Called "records", not "ratings". A sample of 1,200 taken from
              both ends of the BSC register found a mark on every one but only
              53 addresses behind the lot — `npm run reputation` re-measures.
              A ratio computed over that counts writes, not opinions, and
              calling it a rating on our front page would repeat exactly the
              kind of claim this site exists to check. */}
          <Figure
            value={perAgent.toFixed(3)}
            label="feedback records per agent"
            note={`${bsc.total_feedbacks.toLocaleString()} records chain-wide. A sample of 1,200 found just 53 addresses behind them — a count of writes, not of opinions`}
          />
        </section>
      )}

      {observed && (
        <section className="border-b border-rule bg-surface px-6 py-8">
          <p className="label">Measured here, not read off the registry</p>
          <p className="mt-3 max-w-2xl leading-relaxed text-ink-2">
            Every figure above is 8004scan&rsquo;s. This one is Kawal&rsquo;s:{" "}
            <strong className="tnum font-semibold text-ink">
              {observed.checks.toLocaleString()}
            </strong>{" "}
            calls placed to{" "}
            <strong className="tnum font-semibold text-ink">{observed.endpoints}</strong>{" "}
            declared endpoints since{" "}
            {new Date(observed.since * 1000).toISOString().slice(0, 10)}, of which{" "}
            <strong className="tnum font-semibold text-ink">{observed.answered}</strong>{" "}
            answered. The rest are either not there or speak a protocol this
            prober does not — recorded as unknown rather than counted as a
            failure.
          </p>
        </section>
      )}

      <section className="py-14">
        <h2 className="text-2xl font-semibold tracking-tight">Hire by the job</h2>
        <p className="mt-2 max-w-xl text-ink-2">
          Four seats cover what capital on BSC actually needs. Fill one, or fill
          them all and let them work the same pool under separate limits.
        </p>

        <div className="mt-8 grid gap-px bg-rule sm:grid-cols-2">
          {CATEGORIES.filter((c) => c.core).map((c) => (
            <Link
              key={c.id}
              href={`/agents?category=${c.id}`}
              className="group bg-surface p-6 transition-colors hover:bg-raised"
            >
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className="h-4 w-[3px] rounded-sm"
                  style={{ background: seatColor(c.id) }}
                />
                <span className="label">{c.seat}</span>
              </div>
              <h3 className="mt-3 text-lg font-semibold tracking-tight group-hover:text-brass">
                {c.label}
              </h3>
              <p className="mt-1.5 text-sm text-ink-2">{c.blurb}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function Figure({ value, label, note }: { value: string; label: string; note: string }) {
  return (
    <div className="bg-surface px-6 py-8">
      <p className="tnum text-3xl font-semibold tracking-tight">{value}</p>
      <p className="label mt-2">{label}</p>
      <p className="mt-3 max-w-xs text-sm leading-relaxed text-ink-2">{note}</p>
    </div>
  );
}
