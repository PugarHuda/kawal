import Link from "next/link";
import type { Listing } from "@/lib/catalog";
import { CATEGORIES, type CategoryId } from "@/lib/taxonomy";
import { tierLabel, type Tier } from "@/lib/signals";
import type { EndpointProof } from "@/lib/probe";

/*
 * The manifest: the form grammar every listing surface is built from.
 *
 * A listing is a consignment line on Form K-2. The seat is the ink the line
 * is ruled in, the tier is the stamp Kawal pressed after calling, and the
 * probe is the typed entry beside it. Nothing here is a card.
 */

const SEAT_VAR: Record<CategoryId, string> = {
  rebalancing: "var(--seat-rebalancing)",
  grid: "var(--seat-grid)",
  yield: "var(--seat-yield)",
  health: "var(--seat-health)",
  security: "var(--seat-security)",
};

export function seatColor(id: CategoryId | null) {
  return id ? SEAT_VAR[id] : "var(--carbon-3)";
}

export function categoryLabel(id: CategoryId | null) {
  return CATEGORIES.find((c) => c.id === id)?.label ?? "Unclassified";
}

/**
 * Which ink a tier is stamped in.
 *
 * One ink per outcome. Violet is the inspector's own mark — pressed only
 * where Kawal called and something answered in the declared protocol. Red is
 * the one verdict Kawal proved rather than read: called, and nobody answered.
 */
export function tierInk(tier: Tier): "stamp-violet" | "stamp-blue" | "stamp-red" | "stamp-grey" {
  switch (tier) {
    case "hireable":
      return "stamp-violet";
    case "reachable":
      return "stamp-blue";
    case "unreachable":
      return "stamp-red";
    default:
      return "stamp-grey";
  }
}

/**
 * A rubber stamp.
 *
 * `evidence` is how many observations sit behind the verdict; the ink prints
 * darker with more. Ten probes press at about two thirds, ninety at full.
 * `flat` removes the angle for stamps that sit inside a table cell, where a
 * rotated block would collide with the rule.
 */
export function Stamp({
  ink,
  size = "md",
  evidence,
  flat = false,
  children,
  className = "",
  title,
}: {
  ink: "stamp-violet" | "stamp-blue" | "stamp-red" | "stamp-grey" | "stamp-green";
  size?: "sm" | "md" | "lg";
  evidence?: number | null;
  flat?: boolean;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  const density = evidence === undefined || evidence === null ? 1 : 0.62 + Math.min(evidence, 90) / 90 * 0.38;
  return (
    <span
      className={`stamp ${ink} ${size === "lg" ? "stamp--lg" : size === "sm" ? "stamp--sm" : ""} ${flat ? "stamp--flat" : ""} ${className}`}
      style={{ ["--ink" as string]: density }}
      title={title}
    >
      {children}
    </span>
  );
}

/** The tier as the stamp it earned. */
export function TierStamp({
  tier,
  evidence,
  size = "sm",
  flat = true,
}: {
  tier: Tier;
  evidence?: number | null;
  size?: "sm" | "md" | "lg";
  flat?: boolean;
}) {
  return (
    <Stamp ink={tierInk(tier)} size={size} evidence={evidence} flat={flat}>
      {tierLabel(tier)}
    </Stamp>
  );
}

/**
 * The probe history as a perforated tally strip.
 *
 * One cell per call, punched when it answered, blank when it did not, the
 * newest outlined. Drawn from counts rather than rows: the history table
 * keeps every observation, but a strip that long is a texture, not a record,
 * so the strip shows up to `cap` cells and says how many it stands for.
 */
export function Tally({
  answered,
  checks,
  cap = 60,
}: {
  answered: number;
  checks: number;
  cap?: number;
}) {
  const shown = Math.min(checks, cap);
  // Distribute the answered cells across the shown ones proportionally, so
  // a 89/91 strip reads as nearly all punched and a 3/54 strip reads as
  // nearly all blank. The exact sequence is in the history table, not here.
  const punched = checks === 0 ? 0 : Math.round((answered / checks) * shown);
  const cells = Array.from({ length: shown }, (_, i) => i < punched);
  return (
    <span
      className="tally"
      role="img"
      aria-label={`${answered} of ${checks} calls answered`}
      title={`${answered} of ${checks} calls answered`}
    >
      {cells.map((on, i) => (
        <i key={i} className={`${on ? "on" : ""} ${i === cells.length - 1 ? "new" : ""}`} />
      ))}
    </span>
  );
}

/** A pre-printed caption with its typed value, as one cell of a form. */
export function Cell({
  cap,
  children,
  tone,
  className = "",
  span,
}: {
  cap: string;
  children: React.ReactNode;
  tone?: "yellow" | "pink";
  className?: string;
  span?: number;
}) {
  return (
    <div
      className={`cell ${tone === "yellow" ? "cell--yellow" : tone === "pink" ? "cell--pink" : ""} ${className}`}
      style={span ? { gridColumn: `span ${span}` } : undefined}
    >
      <span className="cap">{cap}</span>
      <div className="typed min-w-0 break-words">{children}</div>
    </div>
  );
}

/**
 * The key printed on every form.
 *
 * Names each stamp and mark in use, so no symbol on the page goes
 * unexplained. Pass only the entries the page actually uses.
 */
export function Legend({ items }: { items: Array<{ mark: React.ReactNode; means: string }> }) {
  return (
    <div className="legend" aria-label="Legend">
      <span className="cap">Keterangan · key</span>
      {items.map((it, i) => (
        <span key={i}>
          {it.mark}
          <span className="typed text-[0.8rem] text-carbon-2">{it.means}</span>
        </span>
      ))}
    </div>
  );
}

/** One consignment line on the manifest. */
export function ListingRow({ listing, proof }: { listing: Listing; proof?: EndpointProof }) {
  const { agent, classification, assessment } = listing;
  const color = seatColor(classification.category);
  const observed = assessment.signals.find((s) => s.key === "observed");
  const evidence = observed ? Number(observed.detail.match(/of (\d+) call/)?.[1] ?? 0) || null : null;

  return (
    <article
      className="manifest-row grid grid-cols-[minmax(0,1fr)] gap-x-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto]"
      style={{ ["--seat" as string]: color }}
    >
      <div className="min-w-0">
        <h3 className="heading text-[1.35rem]">
          <Link href={`/agents/${agent.chain_id}/${agent.token_id}`} className="no-underline hover:underline">
            {agent.name}
          </Link>
        </h3>
        <p className="typed mt-1 max-w-2xl text-[0.9rem] text-carbon-2">
          {agent.description?.trim() || "No description registered."}
        </p>

        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          {assessment.signals.map((s) => (
            <li key={s.key} className="typed flex items-center gap-2 text-[0.78rem]">
              <span
                aria-hidden
                className="inline-block h-[9px] w-[9px] border border-rule"
                style={{ background: s.pass ? "var(--carbon)" : "transparent" }}
              />
              <span className={s.pass ? "text-carbon-2" : "text-carbon-3"}>{s.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="col-start-1 mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-start-2 sm:mt-0 sm:flex-col sm:items-end">
        <TierStamp tier={assessment.tier} evidence={evidence} />
        {/* Only typed when Kawal actually called the endpoint. A line with no
            entry means unchecked, never "checked and fine". */}
        {proof && (
          <span
            className="typed flex items-center gap-2 text-[0.78rem]"
            title={
              proof.answered
                ? `${proof.toolCount ?? 0} ${proof.protocol === "a2a" ? "skills" : "tools"}`
                : (proof.error ?? "")
            }
          >
            <span
              aria-hidden
              className="inline-block h-[9px] w-[9px] border border-rule"
              style={{ background: proof.answered ? "var(--stamp-violet)" : "var(--stamp-red)" }}
            />
            {proof.answered
              ? `answered ${proof.protocol.toUpperCase()} in ${proof.latencyMs} ms`
              : "did not answer"}
          </span>
        )}
        <span className="cap" style={{ color }}>
          {categoryLabel(classification.category)} · {Math.round(classification.confidence * 100)}%
        </span>
        <span className="serial serial--seat text-[0.78rem]">No. {agent.token_id}</span>
      </div>
    </article>
  );
}
