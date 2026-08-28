import Link from "next/link";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { winnerOf, type TaskResult, type Run } from "@/lib/advantage.report";
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
 * though the harness had never won a race. Null rather than a throw when the
 * file is absent — the honest answer there is "no measurements", not a 500.
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
      <div className="mx-auto w-full max-w-4xl px-6 pt-8 pb-4">
        <section className="sheet">
          <div className="flex items-baseline justify-between border-b-[1.5px] border-rule px-5 py-2">
            <span className="cap">Form K-7 · laporan keunggulan · agent advantage report</span>
            <span className="serial text-[0.85rem]">No. —</span>
          </div>
          <div className="px-5 py-6">
            <h1 className="heading text-[2.4rem]">No measurements yet.</h1>
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

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-8 pb-4">
      <section className="sheet sheet--carbon">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-7 · laporan keunggulan · agent advantage report</span>
          <span className="serial text-[0.85rem]">Diukur · {report.generatedAt.slice(0, 10)}</span>
        </div>

        <header className="grid gap-px bg-rule lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="cell px-5 pt-6 pb-7">
            <span className="cap">Keterangan · what was measured</span>
            <h1 className="heading mt-2 max-w-[16ch] text-[2.4rem] sm:text-[3.2rem]">
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
              written ahead of the run.
            </p>
            <div className="mt-4 self-end">
              <Stamp ink={hiredWins >= tasks.length / 2 ? "stamp-violet" : "stamp-red"} size="lg" evidence={tasks.length * 30}>
                {hiredWins} dari {tasks.length}
              </Stamp>
            </div>
          </div>
        </header>

        {tasks.map((t, i) => (
          <Task key={t.id} task={t} index={i + 1} />
        ))}

        <section className="border-t-[1.5px] border-rule px-5 py-6">
          <h2 className="heading text-[1.8rem]">What the losses are made of</h2>
          <p className="typed mt-3 max-w-[64ch] text-[0.92rem] text-carbon-2">
            Every task the manual path won, it won on the clock — a direct read beats a round trip
            through somebody else&rsquo;s server, and it always will. On those two tasks both paths came
            back with the same answer, so the agent was selling convenience rather than information,
            and convenience is not worth a spend cap.
          </p>
          <p className="typed mt-3 max-w-[64ch] text-[0.92rem] text-carbon-2">
            The task hiring won, it won on ground covered: fourteen vaults across several protocols
            against one. Matching that by hand is not one faster call, it is many more calls plus
            knowing which protocols to ask in the first place. That is the shape of a real agent
            purchase — not speed, but reach you would otherwise have to enumerate yourself.
          </p>
          <p className="typed mt-3 max-w-[64ch] text-[0.92rem] text-carbon-2">
            Worth noting what the cost column says: nothing was charged for any of it. All three
            agents are registered <code className="font-bold">x402_supported</code> on 8004scan and not
            one issued a payment challenge, which is why{" "}
            <Link href="/agents" className="underline">
              the agent pages
            </Link>{" "}
            report that flag as a claim rather than a price.
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
