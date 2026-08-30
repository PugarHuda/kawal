import Link from "next/link";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { winnerOf, parseReport, plural, sampleCount, type TaskResult, type Run, type Report } from "@/lib/advantage.report";
import { Stamp } from "@/components/listing";

/**
 * Form K-7: what hiring an agent actually bought, measured against doing it
 * by hand.
 *
 * This lived in ADVANTAGE.md and a CLI script, which meant the one document
 * that answers "why hire at all" was the one document a visitor never saw. A
 * marketplace that cannot show its own evidence is asking to be taken on
 * faith, which is the thing this whole product refuses to do everywhere else.
 *
 * Two of the three races went to the manual path. That is published rather
 * than buried: a marketplace that only reports the runs it won is an advert,
 * and the reader has no way to tell an advert from a measurement.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agent advantage report",
  description:
    "Three real tasks on BNB Chain, run twice: once by hiring an agent, once by hand. Medians, coverage and cost for both.",
};

/**
 * Reads the last harness run.
 *
 * Anchored to the working directory for the same reason the ledger and the
 * uptime history are: a relative path follows the process, so a server started
 * from elsewhere would quietly find nothing and render an empty report as
 * though the harness had never won a race. Null rather than a throw when the
 * file is absent or does not parse as a report — the honest answer in both
 * cases is "no measurements", not a 500.
 */
function loadReport(): Report | null {
  const configured = process.env.KAWAL_ADVANTAGE_FILE ?? "advantage-output/results.json";
  const path = isAbsolute(configured) ? configured : join(process.cwd(), configured);

  try {
    return parseReport(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * One sentence per task saying what decided it, read off the numbers.
 *
 * The first version of this section was three paragraphs written after one
 * run — "fourteen vaults", "two of the three" — which the next run would
 * quietly falsify while the page went on printing them. The rule narrated
 * here is the one `winnerOf` applies, so the prose cannot disagree with the
 * marker beside each row.
 */
function whatDecided(t: TaskResult): string {
  const won = winnerOf(t);
  if (won === "none") {
    return `${t.title}: no verdict. One path failed on this run, so its numbers describe the attempt rather than the agent.`;
  }
  const winner = won === "hired" ? t.hired : t.manual;
  const loser = won === "hired" ? t.manual : t.hired;
  const ratio = t.hired.coverage.count / Math.max(t.manual.coverage.count, 1);
  if (ratio >= 2 || ratio <= 0.5) {
    return (
      `${t.title}: ${won === "hired" ? "hiring" : "doing it by hand"} won on ground covered, ` +
      `${winner.coverage.count.toLocaleString()} ${plural(winner.coverage.count, winner.coverage.unit)} against ` +
      `${loser.coverage.count.toLocaleString()}. Matching that is many more calls, not one faster one.`
    );
  }
  const same = `both paths returned the same ${plural(2, t.hired.coverage.unit)}, so the clock decided`;
  const clock = `${winner.ms.toLocaleString()} ms against ${loser.ms.toLocaleString()} ms`;
  return won === "hired"
    ? `${t.title}: ${same}. Hiring answered in ${clock}. Same answer, sooner.`
    : `${t.title}: ${same}. By hand took ${clock}. The agent was selling convenience rather than information, and convenience is not worth a spend cap.`;
}

export default function AdvantagePage() {
  const report = loadReport();

  if (!report) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 pt-8 pb-4">
        <section className="sheet">
          <div className="flex items-baseline justify-between border-b-[1.5px] border-rule px-5 py-2">
            <span className="cap">Form K-7 · agent advantage report</span>
            <span className="serial text-[0.85rem]">No. —</span>
          </div>
          <div className="px-5 py-6">
            <h1 className="typed text-[2rem] font-bold leading-[1.1] sm:text-[2.6rem]">No measurements yet.</h1>
            <p className="typed mt-3 max-w-[60ch] text-carbon-2">
              The harness has not been run in this deployment. It calls live agents over HTTP and costs
              nothing: <code className="font-bold">npm run advantage</code>.
            </p>
          </div>
        </section>
      </div>
    );
  }

  const { tasks } = report;
  const hiredWins = tasks.filter((t) => winnerOf(t) === "hired").length;
  const samples = sampleCount(tasks);
  const spentUsd = tasks.reduce((sum, t) => sum + t.hired.costUsd + t.manual.costUsd, 0);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-8 pb-4">
      <section className="sheet sheet--carbon">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-7 · agent advantage report</span>
          <span className="serial text-[0.85rem]">Measured · {report.generatedAt.slice(0, 10)}</span>
        </div>

        <header className="grid gap-px bg-rule lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="cell px-5 pt-6 pb-7">
            <span className="cap">Key · what was measured</span>
            <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem] mt-2 max-w-[18ch]">
              Hiring won {hiredWins} of these {tasks.length} tasks.
            </h1>
            <p className="typed mt-4 max-w-[62ch] text-[1rem] text-carbon-2">
              Kawal sells access to agents, so the number above is the inconvenient one. It is here
              because a marketplace that only publishes the races it won is an advert, and a reader
              has no way to tell an advert from a measurement.
            </p>
            <p className="typed mt-3 max-w-[62ch] text-[0.9rem] text-carbon-2">
              Three questions someone with money on BNB Chain actually asks. Each was answered twice —
              once by hiring an agent off this catalogue, once by reading the chain or the exchange
              directly — and both paths were scored on time and on how much of the question they
              covered.
            </p>
          </div>
          <div className="cell cell--yellow flex flex-col justify-between px-5 pt-6 pb-7">
            <span className="cap">Cara · method</span>
            <p className="typed mt-2 text-[0.9rem] text-carbon-2">
              Medians over repeated samples, spread shown. Verdicts computed from the timings, never
              written ahead of the run. {samples.toLocaleString()} timed call{samples === 1 ? "" : "s"}{" "}
              behind the stamp.
            </p>
            <div className="mt-4 self-end">
              <Stamp ink={hiredWins >= tasks.length / 2 ? "stamp-violet" : "stamp-red"} size="lg" evidence={samples}>
                {hiredWins} of {tasks.length}
              </Stamp>
            </div>
          </div>
        </header>

        {tasks.map((t, i) => (
          <Task key={t.id} task={t} index={i + 1} />
        ))}

        <section className="border-t-[1.5px] border-rule px-5 py-6">
          <h2 className="heading text-[1.8rem]">What the losses are made of</h2>
          <ul className="mt-3 max-w-[64ch] space-y-3">
            {tasks.map((t) => (
              <li key={t.id} className="typed text-[0.92rem] text-carbon-2">
                {whatDecided(t)}
              </li>
            ))}
          </ul>
          <p className="typed mt-4 max-w-[64ch] text-[0.92rem] text-carbon-2">
            A direct read beats a round trip through somebody else&rsquo;s server on the clock, and it
            always will. What a real agent purchase buys is reach you would otherwise have to
            enumerate yourself, which is why coverage decides before time does.
          </p>
          <p className="typed mt-3 max-w-[64ch] text-[0.92rem] text-carbon-2">
            What the cost column says:{" "}
            {spentUsd === 0
              ? "nothing was charged for any of it; no path issued a payment challenge."
              : `$${spentUsd.toFixed(2)} left a wallet across every run.`}{" "}
            <Link href="/agents" className="underline">
              The agent pages
            </Link>{" "}
            report an <code className="font-bold">x402_supported</code> flag as a claim rather than a
            price for the same reason.
          </p>
        </section>

        <p className="stamp-note max-w-none border-t-[1.5px] border-rule px-5 py-4">
          The harness is <code>npm run advantage</code>. It calls the same live agents this catalogue
          lists, writes every raw payload to <code>advantage-output/</code>, and recomputes these
          verdicts from the timings rather than from anything written ahead of the run.
        </p>
      </section>
    </div>
  );
}

function Task({ task, index }: { task: TaskResult; index: number }) {
  const won = winnerOf(task);

  return (
    <section className="border-t-[1.5px] border-rule px-5 py-6">
      <div className="flex flex-wrap items-baseline gap-x-4">
        <span className="serial text-[0.85rem]">Tugas {String(index).padStart(2, "0")}</span>
        <span className="cap">{task.category}</span>
      </div>
      <h2 className="heading mt-2 text-[1.8rem]">{task.title}</h2>
      {/* The questions name contract addresses — 42 unbreakable characters,
          wider than the text column on a phone. */}
      <p className="typed mt-2 max-w-[64ch] break-words text-[0.9rem] text-carbon-2">{task.question}</p>

      {/* Scrolls inside its own box: a phone must not be made to scroll the
          whole page sideways to read a column. */}
      <div className="mt-5 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="cap border-b-[1.5px] border-rule py-2 pr-4 text-left font-600">Path</th>
              <th className="cap border-b-[1.5px] border-rule py-2 pr-4 text-left font-600">How</th>
              <th className="cap border-b-[1.5px] border-rule py-2 pr-4 text-right font-600">Median</th>
              <th className="cap border-b-[1.5px] border-rule py-2 pr-4 text-right font-600">Covered</th>
              <th className="cap border-b-[1.5px] border-rule py-2 text-right font-600">Cost</th>
            </tr>
          </thead>
          <tbody>
            <PathRow run={task.hired} winner={won === "hired"} />
            <PathRow run={task.manual} winner={won === "manual"} />
          </tbody>
        </table>
      </div>

      <p className="typed mt-4 max-w-[64ch] text-[0.95rem] font-bold">{task.verdict}</p>
      {task.hired.note && <p className="stamp-note mt-2 max-w-[64ch]">{task.hired.note}</p>}
    </section>
  );
}

function PathRow({ run, winner }: { run: Run; winner: boolean }) {
  return (
    <tr className="border-b border-rule-soft align-top">
      <td className="typed py-3 pr-4 text-[0.9rem]">
        <span className="font-bold">{run.path === "hired" ? "Hired" : "By hand"}</span>
        {winner && (
          <span className="ml-2">
            <Stamp ink="stamp-violet" size="sm" flat>
              won
            </Stamp>
          </span>
        )}
      </td>
      <td className="typed py-3 pr-4 text-[0.85rem] text-carbon-2">{run.label}</td>
      <td className="typed whitespace-nowrap py-3 pr-4 text-right text-[0.9rem]">
        {run.ok ? (
          <>
            {run.ms.toLocaleString()} ms
            <span className="block text-[0.75rem] text-carbon-3">{run.spread}</span>
          </>
        ) : (
          <span className="text-carbon-3">failed</span>
        )}
      </td>
      <td className="typed whitespace-nowrap py-3 pr-4 text-right text-[0.9rem]">
        {run.coverage.count.toLocaleString()}
        <span className="block text-[0.75rem] text-carbon-3">{run.coverage.unit}</span>
      </td>
      <td className="typed whitespace-nowrap py-3 text-right text-[0.9rem]">
        {run.costUsd === 0 ? <span className="text-carbon-3">free</span> : `$${run.costUsd.toFixed(2)}`}
      </td>
    </tr>
  );
}
