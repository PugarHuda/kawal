import type { Metadata } from "next";
import Link from "next/link";
import { Courier_Prime, Barlow_Condensed } from "next/font/google";
import "./globals.css";

/**
 * The two voices of a carbon form: the pre-printing and the typing.
 *
 * Barlow Condensed is the condensed grotesque every field caption, heading
 * and stamp on an Indonesian customs form is set in. Courier Prime is the
 * typewriter the entries were struck with. Both self-host at build, which is
 * what `font-src 'self'` in the CSP allows and nothing else.
 */
const typed = Courier_Prime({
  variable: "--font-courier-prime",
  weight: ["400", "700"],
  subsets: ["latin"],
});

const form = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  weight: ["500", "600", "700", "800"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Kawal — hire proven agents on BNB Chain",
  description:
    "The agent marketplace for BNB Smart Chain. Agents you can hire, limits they can't cross.",
};

/** The forms in the book, in the order a visitor meets them. */
const TABS = [
  { code: "K-2", label: "Agents", href: "/agents" },
  { code: "K-5", label: "Mandate", href: "/mandate" },
  { code: "K-7", label: "Evidence", href: "/advantage" },
  { code: "K-6", label: "My agents", href: "/owner" },
] as const;

/**
 * The direction contract, as an HTML comment in the emitted markup.
 *
 * A JSX comment is stripped at compile time, which leaves nothing in the
 * built output to audit against. React cannot render a comment node
 * directly, so it is written through a hidden element; the element carries
 * no script and no style, so the CSP has nothing to say about it.
 */
const CONTRACT = `<!--
THESIS: Every agent is a consignment under escort; the page is the inspection
form, and a tier is a stamp Kawal pressed after it called. It refuses the
hero-plus-cards marketplace and the dark dashboard.
OWN-WORLD: three-part carbonless paper (white, yellow, pink) on a desk-paper
ground; ruled cells with condensed pre-printed captions; typewriter entries;
violet, blue, red and grey rubber stamps at -8deg whose ink density tracks
evidence; perforated counterfoils as the only buttons; a punched tally strip
for history; a printed legend on every form. Raised by: chromatophore (ink
density), cloud edge (uncertainty printed under every stamp), rocket plate
(one angle), orienteering (legend), drum machine (tally strip), HyperCard
(addressable counterfoils).
STORY: the visitor reads a form Kawal already filled in about an agent, sees
the stamp and the count behind it, and tears off the counterfoil to hire
under a cap.
FIRST VIEWPORT: Form K-1 full width; serial and date strip; the headline
typed large at left with a violet TELAH DIPERIKSA stamp crossing the probe
count at right; three typed registry cells; the BROWSE THE MANIFEST
counterfoil; the legend strip; four seats as manifest lines.
FORM: Surat Jalan, candidate 7 of 7, seed dc528c41.
FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance.
-->`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${typed.variable} ${form.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <div hidden aria-hidden dangerouslySetInnerHTML={{ __html: CONTRACT }} />
        <header className="border-b-[1.5px] border-rule bg-paper-white">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-stretch gap-x-8 px-6">
            <Link href="/" className="heading flex items-baseline gap-3 py-3 text-2xl no-underline">
              Kawal
              <span className="cap hidden sm:inline">Buku manifes · BNB Smart Chain · ERC-8004</span>
            </Link>
            {/* The book's tabs. The form code is printed beside each name and
                hidden from the accessible name, so a screen reader hears the
                page and a sighted reader sees where it sits in the book. */}
            <nav aria-label="Forms" className="ml-auto flex flex-wrap items-stretch">
              {TABS.map((t) => (
                <Link
                  key={t.href}
                  href={t.href}
                  className="form-face flex items-center gap-2 border-l border-rule-soft px-3 py-2 text-[0.9rem] font-600 uppercase tracking-[0.05em] text-carbon-2 no-underline hover:bg-paper-yellow hover:text-carbon sm:px-4"
                >
                  <span aria-hidden className="serial text-[0.7rem]">
                    {t.code}
                  </span>
                  {t.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="mt-16 border-t-[1.5px] border-rule bg-paper-white">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-baseline justify-between gap-x-8 gap-y-2 px-6 py-4">
            <span className="cap">Kawal · roster via 8004scan · every stamp pressed after a call</span>
            <span className="cap">
              Forms K-1 to K-7 · MCP at /api/mcp · A2A at /.well-known/agent-card.json
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
