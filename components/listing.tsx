import Link from "next/link";
import type { Listing } from "@/lib/catalog";
import { CATEGORIES, type CategoryId } from "@/lib/taxonomy";
import { tierLabel, type Tier } from "@/lib/signals";
import type { EndpointProof } from "@/lib/probe";
import type { ListingProbe } from "@/lib/liveness";

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

/** The face of each tier stamp, as the die is cut. The legend explains these words. */
const TIER_FACE: Record<Tier, string> = {
  hireable: "Telah diperiksa",
  reachable: "Diterima",
  unreachable: "Ditolak",
  registered: "Belum diperiksa",
};

/**
 * The least ink a stamp prints with.
 *
 * A verdict with nothing behind it prints at this, not at full: full ink is
 * what ninety probes earn, and a stamp pressed on the registry's word alone
 * has earned none of it.
 */
const BASE_INK = 0.62;

/**
 * A rubber stamp.
 *
 * `evidence` is how many observations sit behind the verdict; the ink prints
 * darker with more. Ten probes press at about two thirds, ninety at full,
 * none at the base density. `flat` removes the angle for stamps that sit
 * inside a table cell, where a rotated block would collide with the rule.
 * `lang` marks a face cut in Indonesian so a screen reader says it right.
 */
export function Stamp({
  ink,
  size = "md",
  evidence,
  flat = false,
  children,
  className = "",
  lang,
}: {
  ink: "stamp-violet" | "stamp-blue" | "stamp-red" | "stamp-grey" | "stamp-green";
  size?: "sm" | "md" | "lg";
  evidence?: number | null;
  flat?: boolean;
  children: React.ReactNode;
  className?: string;
  lang?: string;
}) {
  // A small stamp is 11px type: at base ink it drops under AA contrast, so
  // the density rule applies from md up and the small faces print full.
  const density =
    size === "sm"
      ? 1
      : evidence === undefined || evidence === null
        ? BASE_INK
        : BASE_INK + (Math.min(evidence, 90) / 90) * (1 - BASE_INK);
  return (
    <span
      className={`stamp ${ink} ${size === "lg" ? "stamp--lg" : size === "sm" ? "stamp--sm" : ""} ${flat ? "stamp--flat" : ""} ${className}`}
      style={{ ["--ink" as string]: density }}
      lang={lang}
    >
      {children}
    </span>
  );
}

/**
 * The tier as the stamp it earned.
 *
 * The face is the Indonesian die the legend explains; the English tier is
 * beside it for a screen reader and for anything that reads the page as text.
 * One copy each, so "Hireable" resolves once.
 */
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
    <>
      <Stamp ink={tierInk(tier)} size={size} evidence={evidence} flat={flat} lang="id">
        {TIER_FACE[tier]}
      </Stamp>
      <span className="sr-only">{tierLabel(tier)}</span>
    </>
  );
}

/**
 * The probe history as a perforated tally strip.
 *
 * One cell per call, punched when it answered, blank when it did not. Drawn
 * from counts rather than rows: the history table keeps every observation,
 * but a strip that long is a texture, not a record, so the strip shows up to
 * `cap` cells and says how many it stands for.
 *
 * The newest call is outlined only when the caller says how it went: the
 * punched cells are grouped, so without that the outline would land on a
 * blank cell whenever any call had ever failed, whatever the latest one did.
 */
export function Tally({
  answered,
  checks,
  cap = 60,
  newestAnswered,
}: {
  answered: number;
  checks: number;
  cap?: number;
  newestAnswered?: boolean;
}) {
  const shown = Math.min(checks, cap);
  // Distribute the answered cells across the shown ones proportionally, so
  // a 89/91 strip reads as nearly all punched and a 3/54 strip reads as
  // nearly all blank. The exact sequence is in the history table, not here.
  const punched = checks === 0 ? 0 : Math.round((answered / checks) * shown);
  const cells = Array.from({ length: shown }, (_, i) => i < punched);
  const newest =
    newestAnswered === undefined ? -1 : newestAnswered ? punched - 1 : shown - 1;
  return (
    <span className="tally" role="img" aria-label={`${answered} of ${checks} calls answered`}>
      {cells.map((on, i) => (
        <i key={i} className={`${on ? "on" : ""} ${i === newest ? "new" : ""}`} />
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
 * unexplained. Pass only the entries the page actually uses. A definition
 * list, because that is what a key is; `contents` lets the pairs flow in the
 * legend's own row.
 */
export function Legend({ items }: { items: Array<{ mark: React.ReactNode; means: string }> }) {
  return (
    <section className="legend" aria-label="Legend">
      <span className="cap">Keterangan · key</span>
      <dl className="contents">
        {items.map((it, i) => (
          <div key={i} className="inline-flex items-center gap-2">
            <dt>{it.mark}</dt>
            <dd className="typed text-[0.8rem] text-carbon-2">{it.means}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** A punched square: carbon when the mark holds, blank when it does not. */
function Punch({ on, ink = "var(--carbon)" }: { on: boolean; ink?: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-[9px] w-[9px] shrink-0 border border-rule"
      style={{ background: on ? ink : "transparent" }}
    />
  );
}

/** The typed line beside a probe: what answered, how fast, and what it offers. */
function ProbeLine({ proof }: { proof: EndpointProof }) {
  const unit = proof.protocol === "a2a" ? "skills" : "tools";
  return (
    <span className="typed flex items-center gap-2 text-[0.78rem]">
      <Punch on ink={proof.answered ? "var(--stamp-violet)" : "var(--stamp-red)"} />
      <span>
        {proof.answered
          ? `answered ${proof.protocol.toUpperCase()} in ${proof.latencyMs} ms`
          : "did not answer"}
        {proof.answered && proof.toolCount !== null && ` · ${proof.toolCount} ${unit}`}
        {!proof.answered && proof.error && (
          <span className="text-carbon-3"> · {proof.error.slice(0, 60)}</span>
        )}
      </span>
    </span>
  );
}

/**
 * One consignment line on the manifest.
 *
 * `probe` is what Kawal found when it called this row's endpoint, when it
 * did. `selectable` adds the tick box that posts the row to Form K-4.
 */
export function ListingRow({
  listing,
  probe,
  selectable = false,
  checked = false,
}: {
  listing: Listing;
  probe?: ListingProbe;
  selectable?: boolean;
  checked?: boolean;
}) {
  const { agent, classification, assessment } = listing;
  const color = seatColor(classification.category);
  const ref = `${agent.chain_id}:${agent.token_id}`;
  const observed = assessment.signals.find((s) => s.key === "observed");
  // The count behind the verdict, from the signal that carries it or from
  // the running record the probe came with. Null prints at base ink.
  const evidence = observed?.evidence ?? probe?.observed?.checks ?? null;

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
        <p className="typed mt-1 max-w-2xl break-words text-[0.9rem] text-carbon-2">
          {agent.description?.trim() || "No description registered."}
        </p>

        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          {assessment.signals.map((s) => (
            <li key={s.key} className="typed flex items-center gap-2 text-[0.78rem]">
              <Punch on={s.pass} />
              <span className="sr-only">{s.pass ? "passes: " : "fails: "}</span>
              <span className={s.pass ? "text-carbon-2" : "text-carbon-3"}>{s.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="col-start-1 mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-start-2 sm:mt-0 sm:flex-col sm:items-end">
        <TierStamp tier={assessment.tier} evidence={evidence} />
        {/* Only typed when Kawal actually called the endpoint. A line with no
            entry means unchecked, never "checked and fine". */}
        {probe && <ProbeLine proof={probe.proof} />}
        <span className="cap" style={{ color }}>
          {categoryLabel(classification.category)} · {Math.round(classification.confidence * 100)}% (Kawal&rsquo;s classifier)
        </span>
        <span className="serial serial--seat text-[0.78rem]">No. {agent.token_id}</span>
        {selectable && (
          <label className="cap inline-flex cursor-pointer items-center gap-2">
            <input type="checkbox" name="ids" value={ref} defaultChecked={checked} className="h-4 w-4 cursor-pointer" />
            <span lang="id">Bandingkan</span> · compare
          </label>
        )}
      </div>
    </article>
  );
}
