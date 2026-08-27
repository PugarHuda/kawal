import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Kawal — hire proven agents on BNB Chain",
  description:
    "The agent marketplace for BNB Smart Chain. Agents you can hire, limits they can't cross.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        <header className="border-b border-rule-2">
          <div className="mx-auto flex w-full max-w-6xl items-baseline gap-6 px-6 py-4">
            <Link href="/" className="text-lg font-bold tracking-tight">
              Kawal
            </Link>
            <span className="label hidden sm:inline">
              Agents you can hire · limits they can&rsquo;t cross
            </span>
            {/* The links carry their own vertical padding rather than relying
                on the line box. At `text-sm` alone each was a 20px tap target,
                under the 24px WCAG 2.2 minimum — small enough to miss with a
                thumb on the device most people browse from, and the primary
                navigation is the worst place to make someone aim. */}
            <nav className="ml-auto flex items-center gap-4 text-sm">
              <Link
                href="/agents"
                className="-my-1 inline-flex items-center px-1 py-1.5 text-ink-2 hover:text-ink"
              >
                Agents
              </Link>
              <Link
                href="/mandate"
                className="-my-1 inline-flex items-center px-1 py-1.5 text-ink-2 hover:text-ink"
              >
                Mandate
              </Link>
              <Link
                href="/advantage"
                className="-my-1 inline-flex items-center px-1 py-1.5 text-ink-2 hover:text-ink"
              >
                Evidence
              </Link>
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-rule mt-16">
          <div className="mx-auto w-full max-w-6xl px-6 py-6 label">
            Kawal · BNB Smart Chain · roster via 8004scan
          </div>
        </footer>
      </body>
    </html>
  );
}
