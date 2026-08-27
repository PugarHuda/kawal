import Link from "next/link";
import { CATEGORIES } from "@/lib/taxonomy";
import { seatColor } from "@/components/listing";

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
 * So the page offers the four seats. Someone who arrived looking for an agent
 * is one click from the category that would have held it.
 */
export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-20">
      <p className="label">404</p>
      <h1 className="mt-4 max-w-2xl text-3xl font-bold tracking-[-0.03em]">
        There is no agent at this address.
      </h1>
      <p className="mt-4 max-w-xl text-ink-2">
        Either the link is wrong, or the registration it pointed at is not on
        BNB Smart Chain. Kawal reads the registry live, so an agent that was
        here yesterday and is gone today is a real answer rather than a
        mistake.
      </p>

      <h2 className="label mt-12">Start from a seat instead</h2>
      <div className="mt-4 grid gap-px bg-rule sm:grid-cols-2">
        {CATEGORIES.filter((c) => c.core).map((c) => (
          <Link
            key={c.id}
            href={`/agents?category=${c.id}`}
            className="group bg-surface p-5 transition-colors hover:bg-raised"
          >
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="h-4 w-[3px] rounded-sm"
                style={{ background: seatColor(c.id) }}
              />
              <span className="label">{c.seat}</span>
            </div>
            <p className="mt-2 font-semibold tracking-tight group-hover:text-brass">
              {c.label}
            </p>
            <p className="mt-1 text-sm text-ink-2">{c.blurb}</p>
          </Link>
        ))}
      </div>

      <p className="label mt-10 flex gap-6">
        <Link href="/agents" className="hover:text-ink">
          ← Every agent on BSC
        </Link>
        <Link href="/" className="hover:text-ink">
          Home
        </Link>
      </p>
    </div>
  );
}
