"use client";

import Link from "next/link";
import { Courier_Prime, Barlow_Condensed } from "next/font/google";
import "./globals.css";

/**
 * The sheet for a failure in the root layout itself.
 *
 * `global-error` replaces the root layout when it renders, so nothing from
 * `layout.tsx` is here unless it is repeated: the `<html>` and `<body>`, the
 * stylesheet, and the two fonts. All three come the same way the layout gets
 * them — `globals.css` is a plain import, which Next serves as a stylesheet
 * from its own origin, and `next/font` self-hosts the faces at build. Both
 * pass a `style-src 'self'` / `font-src 'self'` policy without a nonce, which
 * is what makes this page render styled under the CSP where Next's built-in
 * 500 page does not.
 *
 * The stamp ink filter lives in the layout and is not repeated here; a CSS
 * `filter: url()` pointing at nothing is ignored by the browser, so the
 * stamp prints clean-edged rather than not at all.
 */
const typed = Courier_Prime({
  variable: "--font-courier-prime",
  weight: ["400", "700"],
  subsets: ["latin"],
});

const form = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  weight: ["600", "700", "800"],
  subsets: ["latin"],
});

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en" className={`${typed.variable} ${form.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <title>Returned — Kawal</title>
        <main className="mx-auto w-full max-w-4xl px-6 py-14">
          <section className="sheet sheet--pink">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
              <span className="cap">Form K-0 · returned</span>
              <span className="serial text-[0.85rem]">{error.digest ? `No. ${error.digest}` : "No. —"}</span>
            </div>
            <div className="grid gap-6 px-5 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <div>
                <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem] max-w-[20ch]">
                  The book itself could not be opened.
                </h1>
                <p className="typed mt-4 max-w-[60ch] text-carbon-2">
                  The frame every form sits in threw before any form was read. Nothing was signed or
                  sent. Trying again reloads it; the two stubs below open the manifest and the cover
                  sheet directly.
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
        </main>
      </body>
    </html>
  );
}
