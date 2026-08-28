import Link from "next/link";
import { browse, retrieveCategory, reassess } from "@/lib/catalog";
import { categoryById, CATEGORIES } from "@/lib/taxonomy";
import { ListingRow, seatColor, Stamp, Legend } from "@/components/listing";
import { probeListings } from "@/lib/liveness";
import type { Listing } from "@/lib/catalog";

/**
 * Form K-2: the manifest.
 *
 * Every listing is a consignment line. The seat tabs along the top are the
 * book's index tabs; the header cells are the form's own fields — what was
 * retrieved, what survived, what is stamped hireable; and the rows are the
 * agents, each ruled in its seat's ink with the stamp Kawal pressed after
 * calling it.
 */
export default async function AgentsPage({ searchParams }: PageProps<"/agents">) {
  const params = await searchParams;
  const categoryId = typeof params.category === "string" ? params.category : undefined;
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const category = categoryId ? categoryById(categoryId) : undefined;

  let listings: Listing[] = [];
  let heading = "Every agent on BSC";
  let subheading = "Ranked by what they can actually do, not by when they registered.";
  let coverage: { retrieved: number; listable: number; hireable: number; retrieval: string } | null = null;
  let total: number | null = null;
  let failed = false;

  try {
    if (category) {
      const result = await retrieveCategory(category);
      listings = result.listings;
      heading = category.label;
      subheading = category.blurb;
      coverage = {
        retrieved: result.retrieved,
        listable: result.listings.length,
        hireable: result.listings.filter((l) => l.assessment.tier === "hireable").length,
        retrieval: result.semantic ? "semantic" : "keyword",
      };
    } else {
      const result = await browse({ search: q || undefined });
      listings = result.listings;
      total = result.total;
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
    <div className="mx-auto w-full max-w-6xl px-6 pt-8 pb-4">
      {/* Index tabs along the top edge of the book. */}
      <nav aria-label="Seats" className="flex flex-wrap gap-1">
        <Tab href="/agents" active={!category}>
          All
        </Tab>
        {CATEGORIES.map((c) => (
          <Tab key={c.id} href={`/agents?category=${c.id}`} active={category?.id === c.id} color={seatColor(c.id)}>
            {c.label}
          </Tab>
        ))}
      </nav>

      <section className="sheet sheet--carbon">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-2 · manifes agen · {category ? category.seat : "all seats"}</span>
          <span className="serial text-[0.85rem]">
            {category ? `Seat ${category.id.toUpperCase()}` : total !== null ? `Roster ${total.toLocaleString()}` : ""}
          </span>
        </div>

        <header className="grid gap-px bg-rule lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="cell px-5 pt-5 pb-6">
            <span className="cap">Keterangan · what is listed here</span>
            <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem] mt-2">{heading}</h1>
            <p className="typed mt-3 max-w-[62ch] text-carbon-2">{subheading}</p>

            {/* The search line, typed into the form itself. */}
            {!category && (
              <form method="get" className="mt-5 flex max-w-lg gap-2">
                <label className="flex-1">
                  <span className="cap sr-only">Search the roster</span>
                  <input
                    type="search"
                    name="q"
                    defaultValue={q}
                    placeholder="describe the job — e.g. watch my lending position"
                    className="field w-full"
                  />
                </label>
                <button type="submit" className="counterfoil counterfoil--quiet">
                  Search
                </button>
              </form>
            )}

            {compareHref && (
              <p className="mt-5">
                <Link href={compareHref} className="counterfoil counterfoil--quiet">
                  Compare the {compareCount} strongest side by side →
                </Link>
              </p>
            )}
          </div>

          {coverage ? (
            <div className="cells border-0 sm:grid-cols-2 lg:grid-cols-2">
              <div className="cell cell--yellow">
                <span className="cap">Ditarik · registrations retrieved</span>
                <span className="heading block text-[2rem]">{coverage.retrieved}</span>
              </div>
              <div className="cell cell--yellow">
                <span className="cap">Lolos · survived collapse and floor</span>
                <span className="heading block text-[2rem]">{coverage.listable}</span>
              </div>
              <div className="cell cell--yellow">
                <span className="cap">Dicap · bear Kawal&rsquo;s own stamp</span>
                <span className="heading block text-[2rem]">{coverage.hireable}</span>
              </div>
              <div className="cell cell--yellow">
                <span className="cap">Cara · retrieval</span>
                <span className="typed block text-[1rem]">{coverage.retrieval}</span>
              </div>
            </div>
          ) : (
            <div className="cell cell--yellow px-5 pt-5 pb-6">
              <span className="cap">Cara · how this list is made</span>
              <p className="typed mt-2 text-[0.9rem] text-carbon-2">
                Duplicate registrations are collapsed — roughly two thirds of the newest arrivals are
                copies of a template — and every agent Kawal has called carries the stamp it earned.
                Search goes through the registry&rsquo;s vector index, so a problem described in plain
                words finds agents that never mention it by name.
              </p>
            </div>
          )}
        </header>

        {failed ? (
          <p className="typed border-t-[1.5px] border-rule bg-paper-pink px-5 py-6 text-carbon-2">
            The 8004scan registry did not respond. Nothing here is cached yet, so the catalog is
            empty until it comes back.
          </p>
        ) : listings.length === 0 ? (
          <p className="typed border-t-[1.5px] border-rule bg-paper-pink px-5 py-6 text-carbon-2">
            No agent on BSC currently matches this seat with enough confidence to list. This
            category has to be supplied, not indexed.
          </p>
        ) : (
          <div className="border-t-[1.5px] border-rule px-5">
            {listings.map((l) => (
              <ListingRow key={l.agent.agent_id} listing={l} proof={proofs.get(l.agent.agent_id)?.proof} />
            ))}
          </div>
        )}
      </section>

      <div className="mt-6">
        <Legend
          items={[
            { mark: <Stamp ink="stamp-violet" size="sm" flat>Telah diperiksa</Stamp>, means: "declares an interface and Kawal reached it, or the registry's claim stands unchecked" },
            { mark: <Stamp ink="stamp-blue" size="sm" flat>Diterima</Stamp>, means: "something answered, not in the declared protocol" },
            { mark: <Stamp ink="stamp-red" size="sm" flat>Ditolak</Stamp>, means: "called at least three times, never answered" },
            { mark: <span aria-hidden className="inline-block h-[9px] w-[9px] border border-rule bg-carbon" />, means: "signal holds" },
            { mark: <span aria-hidden className="inline-block h-[9px] w-[9px] border border-rule" />, means: "signal fails or is unverified" },
          ]}
        />
      </div>
    </div>
  );
}

function Tab({
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
      className={`form-face flex items-center gap-2 border-[1.5px] border-b-0 px-3 py-1.5 text-[0.85rem] font-600 uppercase tracking-[0.06em] no-underline ${
        active ? "border-rule bg-paper-white text-carbon" : "border-rule-soft bg-paper text-carbon-2 hover:bg-paper-yellow"
      }`}
    >
      {color && <span aria-hidden className="h-3 w-[5px]" style={{ background: color }} />}
      {children}
    </Link>
  );
}
