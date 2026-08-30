"use client";

import Link from "next/link";

/**
 * The sheet a route hands back when its render threw.
 *
 * Next's default error page carries an inline `<style>` block, which the
 * Content-Security-Policy in `proxy.ts` refuses, so the built-in page arrived
 * unstyled as well as off-brand. This one is a returned form in the book's
 * own grammar: a pink copy, a red stamp, and two ways out.
 *
 * Nothing from `lib/` is imported. Error boundaries are client components,
 * and the stamp is three class names; pulling the listing component in would
 * drag the taxonomy and the signal rules into the client bundle for one span.
 *
 * The message is not printed. Next replaces a server error's message with a
 * digest before it reaches the browser, so the text would be a hash, not a
 * reason; the digest is shown as the serial instead so an operator can match
 * it against the server log.
 */
export default function ErrorSheet({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-14">
      <section className="sheet sheet--pink">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-0 · returned</span>
          <span className="serial text-[0.85rem]">{error.digest ? `No. ${error.digest}` : "No. —"}</span>
        </div>
        <div className="grid gap-6 px-5 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div>
            <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem] max-w-[20ch]">
              This form could not be filled in.
            </h1>
            <p className="typed mt-4 max-w-[60ch] text-carbon-2">
              Something Kawal reads to build this page threw while it was being read — the registry,
              the chain, or an agent&rsquo;s own endpoint. Nothing was signed or sent. Trying again asks
              the same sources once more; if they are down, the manifest still lists what Kawal has
              already seen.
            </p>
          </div>
          <span className="stamp stamp-red stamp--lg">
            Failed
          </span>
        </div>
      </section>

      <p className="mt-8 flex flex-wrap gap-3">
        <button type="button" onClick={() => retry()} className="counterfoil">
          Try again
        </button>
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
