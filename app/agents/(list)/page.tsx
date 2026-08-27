import Link from "next/link";
import { browse, retrieveCategory, reassess } from "@/lib/catalog";
import { categoryById, CATEGORIES } from "@/lib/taxonomy";
import { ListingRow, seatColor } from "@/components/listing";
import { probeListings } from "@/lib/liveness";
import type { Listing } from "@/lib/catalog";

export default async function AgentsPage({ searchParams }: PageProps<"/agents">) {
  const params = await searchParams;
  const categoryId = typeof params.category === "string" ? params.category : undefined;
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const category = categoryId ? categoryById(categoryId) : undefined;

  let listings: Listing[] = [];
  let heading = "Every agent on BSC";
  let subheading = "Ranked by what they can actually do, not by when they registered.";
  let coverage: string | null = null;
  let failed = false;

  try {
    if (category) {
      const result = await retrieveCategory(category);
      listings = result.listings;
      heading = category.label;
      subheading = category.blurb;
      coverage =
        `${result.retrieved} registrations retrieved · ` +
        `${result.listings.length} survived duplicate collapse and the confidence floor · ` +
        `${result.listings.filter((l) => l.assessment.tier === "hireable").length} hireable · ` +
        `${result.semantic ? "semantic" : "keyword"} retrieval`;
    } else {
      const result = await browse({ search: q || undefined });
      listings = result.listings;
      if (q) {
        heading = `“${q}”`;
        subheading = `${result.total.toLocaleString()} registrations match this term chain-wide.`;
      }
    }
  } catch {
    failed = true;
  }

  // Call the hireable endpoints ourselves before anyone decides. Bounded to a
  // handful and memoised, so this costs one burst and nothing thereafter.
  const proofs = await probeListings(listings);

  // Rows Kawal has called are re-scored against what answered, then re-ranked.
  // An agent the registry calls hireable that has never answered must not keep
  // the top of a page it is wrong about.
  listings = reassess(listings, proofs);

  // The listing ranks by evidence, so the first few rows are already the
  // shortlist a buyer would build by hand. Handing them straight to the
  // comparison saves the step that judging in isolation makes people skip.
  const shortlist = listings.slice(0, 3);
  const compareCount = shortlist.length;
  const compareHref =
    compareCount >= 2
      ? `/compare?ids=${shortlist.map((l) => `${l.agent.chain_id}:${l.agent.token_id}`).join(",")}`
      : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12">
      <nav className="flex flex-wrap gap-2">
        <Chip href="/agents" active={!category}>
          All
        </Chip>
        {CATEGORIES.map((c) => (
          <Chip key={c.id} href={`/agents?category=${c.id}`} active={category?.id === c.id} color={seatColor(c.id)}>
            {c.label}
          </Chip>
        ))}
      </nav>

      <header className="mt-10">
        <h1 className="text-3xl font-bold tracking-[-0.03em]">{heading}</h1>
        <p className="mt-2 max-w-2xl text-ink-2">{subheading}</p>
        {coverage && <p className="label mt-4">{coverage}</p>}

        {compareHref && (
          <p className="mt-4">
            <Link
              href={compareHref}
              className="label rounded-sm border border-rule-2 px-3 py-1.5 hover:border-ink hover:text-ink"
            >
              Compare the {compareCount} strongest side by side →
            </Link>
          </p>
        )}
      </header>

      {failed ? (
        <p className="mt-12 border border-rule-2 bg-surface p-6 text-ink-2">
          The 8004scan registry did not respond. Nothing here is cached yet, so
          the catalog is empty until it comes back.
        </p>
      ) : listings.length === 0 ? (
        <p className="mt-12 border border-rule-2 bg-surface p-6 text-ink-2">
          No agent on BSC currently matches this seat with enough confidence to
          list. This category has to be supplied, not indexed.
        </p>
      ) : (
        <div className="mt-8 border-t border-rule">
          {listings.map((l) => (
            <ListingRow
              key={l.agent.agent_id}
              listing={l}
              proof={proofs.get(l.agent.agent_id)?.proof}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Chip({
  href,
  active,
  color,
  children,
}: {
  href: string;
  active: boolean;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`label flex items-center gap-2 rounded-sm border px-3 py-1.5 transition-colors ${
        active ? "border-ink bg-ink text-ground" : "border-rule-2 hover:border-ink-3"
      }`}
    >
      {color && (
        <span aria-hidden className="h-2.5 w-[3px] rounded-sm" style={{ background: color }} />
      )}
      {children}
    </Link>
  );
}
