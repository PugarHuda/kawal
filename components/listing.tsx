import Link from "next/link";
import type { Listing } from "@/lib/catalog";
import { CATEGORIES, type CategoryId } from "@/lib/taxonomy";
import { tierLabel } from "@/lib/signals";
import type { EndpointProof } from "@/lib/probe";

const SEAT_VAR: Record<CategoryId, string> = {
  rebalancing: "var(--seat-rebalancing)",
  grid: "var(--seat-grid)",
  yield: "var(--seat-yield)",
  health: "var(--seat-health)",
  security: "var(--seat-security)",
};

export function seatColor(id: CategoryId | null) {
  return id ? SEAT_VAR[id] : "var(--ink-3)";
}

export function categoryLabel(id: CategoryId | null) {
  return CATEGORIES.find((c) => c.id === id)?.label ?? "Unclassified";
}

function TierBadge({ tier }: { tier: Listing["assessment"]["tier"] }) {
  // "Does not answer" is the only badge that earns a colour of its own: it is
  // the one state Kawal proved rather than read off the registry, and it
  // contradicts what the registration claims.
  if (tier === "unreachable") {
    return (
      <span
        className="label rounded-sm border px-2 py-0.5"
        style={{ letterSpacing: "0.1em", borderColor: "var(--seat-health)", color: "var(--seat-health)" }}
      >
        {tierLabel(tier)}
      </span>
    );
  }

  const tone =
    tier === "hireable"
      ? "border-brass text-brass bg-brass-soft"
      : tier === "reachable"
        ? "border-rule-2 text-ink-2"
        : "border-rule text-ink-3";
  return (
    <span className={`label rounded-sm border px-2 py-0.5 ${tone}`} style={{ letterSpacing: "0.1em" }}>
      {tierLabel(tier)}
    </span>
  );
}

export function ListingRow({ listing, proof }: { listing: Listing; proof?: EndpointProof }) {
  const { agent, classification, assessment } = listing;
  const color = seatColor(classification.category);

  return (
    <article className="border-b border-rule py-5">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <span
          aria-hidden
          className="mt-1.5 h-4 w-[3px] flex-none rounded-sm"
          style={{ background: color }}
        />

        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold tracking-tight">
            <Link href={`/agents/${agent.chain_id}/${agent.token_id}`} className="hover:text-brass">
              {agent.name}
            </Link>
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            {agent.description?.trim() || "No description registered."}
          </p>

          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
            {assessment.signals.map((s) => (
              <li key={s.key} className="label flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: s.pass ? "var(--seat-yield)" : "var(--rule-2)" }}
                />
                <span className={s.pass ? "text-ink-2" : "text-ink-3"}>{s.detail}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col items-end gap-2">
          <TierBadge tier={assessment.tier} />
          {/* Only rendered when Kawal actually called the endpoint. A row with
              no badge means unchecked, never "checked and fine". */}
          {proof && (
            <span
              className="label flex items-center gap-1.5"
              title={
                proof.answered
                  ? `${proof.toolCount ?? 0} ${proof.protocol === "a2a" ? "skills" : "tools"}`
                  : (proof.error ?? "")
              }
            >
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: proof.answered ? "var(--seat-yield)" : "var(--seat-health)" }}
              />
              {proof.answered
                ? `answered ${proof.protocol.toUpperCase()} in ${proof.latencyMs} ms`
                : "did not answer"}
            </span>
          )}
          <span className="label tnum">
            {categoryLabel(classification.category)} · {Math.round(classification.confidence * 100)}%
          </span>
          <span className="label tnum">#{agent.token_id}</span>
        </div>
      </div>
    </article>
  );
}
