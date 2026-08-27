import Link from "next/link";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { winnerOf, type TaskResult, type Run } from "@/lib/advantage.report";

/**
 * What hiring an agent actually bought, measured against doing it by hand.
 *
 * This lived in ADVANTAGE.md and a CLI script, which meant the one document
 * that answers "why hire at all" was the one document a visitor never saw. A
 * marketplace that cannot show its own evidence is asking to be taken on
 * faith, which is the thing this whole product refuses to do everywhere else.
 *
 * Two of the three races went to the manual path. That is published rather
 * than buried: a marketplace that only reports the runs it won is an advert,
 * and the reader has no way to tell an advert from a measurement. The result
 * is also more useful than a clean sweep would have been — see the closing
 * note on what the single win was actually made of.
 */

export const dynamic = "force-dynamic";

/**
 * Rendered per request for the CSP nonce, like every other page here.
 *
 * A prerendered shell ships without one and every Next script on it is
 * refused — silently, so the page looks fine and never hydrates. `next.config`
 * cannot catch that; the resilience suite asserts on it instead.
 */

export const metadata = {
  title: "Agent Advantage Report — Kawal",
  description:
    "Three real tasks on BNB Chain, run twice: once by hiring an agent, once by hand. Medians, coverage and cost for both.",
};

type Report = { generatedAt: string; tasks: TaskResult[] };

/**
 * Reads the last harness run.
 *
 * Anchored to the working directory for the same reason the ledger and the
 * uptime history are: a relative path follows the process, so a server started
 * from elsewhere would quietly find nothing and render an empty report as
 * though the harness had never won a race.
 *
 * Returns null rather than throwing when the file is absent — a fresh clone
 * has not run `npm run advantage` yet, and the honest answer there is "no
 * measurements", not a 500.
 */
function loadReport(): Report | null {
  const configured = process.env.KAWAL_ADVANTAGE_FILE ?? "advantage-output/results.json";
  const path = isAbsolute(configured) ? configured : join(process.cwd(), configured);

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Report;
    return Array.isArray(parsed.tasks) && parsed.tasks.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export default function AdvantagePage() {
  const report = loadReport();

  if (!report) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <p className="label">Agent Advantage Report</p>
        <h1 className="mt-5 text-3xl font-bold tracking-[-0.03em]">No measurements yet.</h1>
        <p className="mt-5 leading-relaxed text-ink-2">
          The harness has not been run in this deployment. It calls live agents
          over HTTP and costs nothing:{" "}
          <code className="rounded-sm bg-raised px-1.5 py-0.5 text-sm">npm run advantage</code>.
        </p>
      </div>
    );
  }

  const { tasks } = report;
  const hiredWins = tasks.filter((t) => winnerOf(t) === "hired").length;

  return (
    <div className="mx-auto w-full max-w-4xl px-6">
      <section className="border-b border-rule py-14">
        <p className="label">Agent Advantage Report</p>
        <h1 className="mt-5 max-w-2xl text-4xl font-bold leading-[1.08] tracking-[-0.03em]">
          Hiring won {hiredWins} of these {tasks.length} tasks.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-2">
          Kawal sells access to agents, so the number above is the inconvenient
          one. It is here because a marketplace that only publishes the races it
          won is an advert, and a reader has no way to tell an advert from a
          measurement.
        </p>
        <p className="mt-4 max-w-2xl leading-relaxed text-ink-2">
          Three questions someone with money on BNB Chain actually asks. Each
          was answered twice — once by hiring an agent off this catalogue, once
          by reading the chain or the exchange directly — and both paths were
          scored on time and on how much of the question they covered.
        </p>

        <p className="label mt-8">
          Measured {report.generatedAt.slice(0, 10)} · medians over repeated
          samples, spread shown · verdicts computed, not written
        </p>
      </section>

      {tasks.map((t) => (
        <Task key={t.id} task={t} />
      ))}

      <section className="border-b border-rule py-14">
        <h2 className="text-2xl font-semibold tracking-tight">What the losses are made of</h2>
        <p className="mt-4 max-w-2xl leading-relaxed text-ink-2">
          Every task the manual path won, it won on the clock — a direct read
          beats a round trip through somebody else&rsquo;s server, and it always
          will. On those two tasks both paths came back with the same answer, so
          the agent was selling convenience rather than information, and
          convenience is not worth a spend cap.
        </p>
        <p className="mt-4 max-w-2xl leading-relaxed text-ink-2">
          The task hiring won, it won on ground covered: fourteen vaults across
          several protocols against one. Matching that by hand is not one faster
          call, it is many more calls plus knowing which protocols to ask in the
          first place. That is the shape of a real agent purchase — not speed,
          but reach you would otherwise have to enumerate yourself.
        </p>
        <p className="mt-4 max-w-2xl leading-relaxed text-ink-2">
          Worth noting what the cost column says: nothing was charged for any of
          it. All three agents are registered <code className="text-sm">x402_supported</code> on
          8004scan and not one issued a payment challenge, which is why{" "}
          <Link href="/agents" className="underline hover:text-ink">
            the agent pages
          </Link>{" "}
          report that flag as a claim rather than a price.
        </p>
      </section>

      <section className="py-12">
        <p className="text-ink-2">
          The harness is <code className="text-sm">npm run advantage</code>. It calls the same live
          agents this catalogue lists, writes every raw payload to{" "}
          <code className="text-sm">advantage-output/</code>, and recomputes these verdicts from
          the timings rather than from anything written ahead of the run.
        </p>
      </section>
    </div>
  );
}

function Task({ task }: { task: TaskResult }) {
  const won = winnerOf(task);

  return (
    <section className="border-b border-rule py-12">
      <p className="label">{task.category}</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">{task.title}</h2>
      {/* The questions name contract addresses — 42 unbreakable characters,
          wider than the text column on a phone. Without this the whole page
          scrolls sideways to accommodate one hex string. */}
      <p className="mt-3 max-w-2xl leading-relaxed break-words text-ink-2">{task.question}</p>

      {/* Scrolls inside its own box: the labels are long and a phone must not
          be made to scroll the whole page sideways to read a column. */}
      <div className="mt-7 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule-2 text-left">
              <th className="label py-2 pr-4 font-normal">Path</th>
              <th className="label py-2 pr-4 font-normal">How</th>
              <th className="label py-2 pr-4 text-right font-normal">Median</th>
              <th className="label py-2 pr-4 text-right font-normal">Covered</th>
              <th className="label py-2 text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            <PathRow run={task.hired} winner={won === "hired"} />
            <PathRow run={task.manual} winner={won === "manual"} />
          </tbody>
        </table>
      </div>

      <p className="mt-6 max-w-2xl font-medium leading-relaxed">{task.verdict}</p>

      {task.hired.note && (
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-3">{task.hired.note}</p>
      )}
    </section>
  );
}

function PathRow({ run, winner }: { run: Run; winner: boolean }) {
  return (
    <tr className="border-b border-rule align-top">
      <td className="py-3 pr-4">
        <span className="font-medium">{run.path === "hired" ? "Hired" : "By hand"}</span>
        {winner && (
          <span className="label ml-2" style={{ color: "var(--brass)" }}>
            won
          </span>
        )}
      </td>
      <td className="py-3 pr-4 text-ink-2">{run.label}</td>
      <td className="tnum whitespace-nowrap py-3 pr-4 text-right">
        {run.ok ? (
          <>
            {run.ms.toLocaleString()} ms
            <span className="block text-xs text-ink-3">{run.spread}</span>
          </>
        ) : (
          <span className="text-ink-3">failed</span>
        )}
      </td>
      <td className="tnum whitespace-nowrap py-3 pr-4 text-right">
        {run.coverage.count.toLocaleString()}
        <span className="block text-xs text-ink-3">{run.coverage.unit}</span>
      </td>
      <td className="tnum whitespace-nowrap py-3 text-right">
        {run.costUsd === 0 ? <span className="text-ink-3">free</span> : `$${run.costUsd.toFixed(2)}`}
      </td>
    </tr>
  );
}
