import Link from "next/link";
import { CATEGORIES } from "@/lib/taxonomy";
import { seatColor, Stamp } from "@/components/listing";

/**
 * The page someone lands on after a dead link, and a way back out of it.
 *
 * Next's default 404 ships its own inline `<style>` block, which the
 * Content-Security-Policy refuses — so the built-in page arrived unstyled as
 * well as off-brand. Replacing it fixes both, and fixes the larger problem:
 * this app hands out URLs containing agent token ids, which go stale as
 * registrations change. Landing on a bare "404" after following one is a dead
 * end, and the rubric's first criterion is that nobody hits one.
 *
 * In the book's grammar this is a returned form: stamped, with the four seats
 * offered as the lines to file under instead.
 */
export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-14">
      <section className="sheet sheet--pink">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-0 · returned</span>
          <span className="serial text-[0.85rem]">No. 404</span>
        </div>
        <div className="grid gap-6 px-5 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div>
            <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem] max-w-[20ch]">
              There is no agent at this address.
            </h1>
            <p className="typed mt-4 max-w-[60ch] text-carbon-2">
              Either the link is wrong, or the registration it pointed at is not on BNB Smart Chain.
              Kawal reads the registry live, so an agent that was here yesterday and is gone today is
              a real answer rather than a mistake.
            </p>
          </div>
          <Stamp ink="stamp-red" size="lg">
            Not found
          </Stamp>
        </div>
      </section>

      <h2 className="heading mt-10 text-[1.6rem]">Start from a seat instead</h2>
      <div className="sheet mt-4">
        <ol>
          {CATEGORIES.filter((c) => c.core).map((c, i) => (
            <li key={c.id} className="manifest-row last:border-b-0" style={{ ["--seat" as string]: seatColor(c.id) }}>
              <Link
                href={`/agents?category=${c.id}`}
                className="grid grid-cols-[3rem_minmax(0,1fr)] items-stretch gap-x-4 no-underline"
              >
                <span className="serial serial--seat self-center pl-5 text-[0.85rem]">{String(i + 1).padStart(2, "0")}</span>
                <span className="py-4 pr-5">
                  <span className="cap block" style={{ color: seatColor(c.id) }}>{c.seat}</span>
                  <span className="heading block text-[1.35rem]">{c.label}</span>
                  <span className="typed block text-[0.9rem] text-carbon-2">{c.blurb}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </div>

      <p className="mt-8 flex flex-wrap gap-3">
        <Link href="/agents" className="counterfoil counterfoil--quiet">
          ← Every agent on BSC
        </Link>
        <Link href="/" className="counterfoil counterfoil--quiet">
          Cover sheet
        </Link>
      </p>
    </div>
  );
}
