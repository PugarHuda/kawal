/**
 * The parts of the Agent Advantage Report that decide what a run *means*.
 *
 * Split out of the runner because the runner has top-level side effects: it
 * calls live agents and rewrites ADVANTAGE.md on import. Pulling `verdictFor`
 * in to test it therefore fired the whole harness off the back of `npm run
 * check`, turning an offline self-check into a network job.
 *
 * Nothing here touches the network, the clock, or the filesystem, so it can be
 * asserted against directly.
 */

import { z } from "zod";

/**
 * The shape of one run, as the harness writes it and the page reads it.
 *
 * A schema rather than a type because `results.json` is a file on disk that
 * anything can edit. The page used to check `tasks.length > 0` and trust the
 * rest, so a hand-edited file with a missing `coverage` rendered a 500 where
 * the honest answer is "no measurements".
 */
export const RunSchema = z.object({
  path: z.enum(["hired", "manual"]),
  label: z.string(),
  ms: z.number().nonnegative(),
  ok: z.boolean(),
  /** What came back, verbatim. Long payloads are also written to OUT_DIR. */
  output: z.string(),
  /** Fastest-to-slowest of the samples, so the reader can see the noise. */
  spread: z.string(),
  /** Money that actually left a wallet for this run, in USD. */
  costUsd: z.number().nonnegative(),
  /**
   * How much of the question this path actually answered. Wall clock alone
   * would score a one-market lookup as beating a fourteen-vault survey.
   */
  coverage: z.object({ count: z.number().nonnegative(), unit: z.string() }),
  /** How many timed calls the median was taken over. Older files omit it. */
  samples: z.number().int().positive().optional(),
  note: z.string().optional(),
});

export const TaskResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  question: z.string(),
  hired: RunSchema,
  manual: RunSchema,
  verdict: z.string(),
});

export const ReportSchema = z.object({
  generatedAt: z.string(),
  tasks: z.array(TaskResultSchema).min(1),
});

export type Run = z.infer<typeof RunSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type Report = z.infer<typeof ReportSchema>;

/** A report, or null when the file does not parse as one. */
export function parseReport(raw: unknown): Report | null {
  const result = ReportSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * How many timed calls stand behind the report.
 *
 * Counts the samples each run records; a run written before that field
 * existed counts as the one measurement it is. Used as the ink density of the
 * verdict stamp, so the number has to be one the file actually contains.
 */
export function sampleCount(tasks: TaskResult[]): number {
  return tasks.reduce((n, t) => n + (t.hired.samples ?? 1) + (t.manual.samples ?? 1), 0);
}

/** Median of the samples, so one slow round trip cannot set the headline. */
export function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  // An empty sample used to fall into the even branch and add two undefined
  // reads together, producing NaN with no complaint — a number that would
  // have gone straight into a report as a measurement.
  if (sorted.length === 0) return 0;

  const mid = sorted.length >> 1;
  if (sorted.length % 2) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/** "1 vaults" in a report a judge reads is just sloppy. */
export function plural(count: number, unit: string) {
  if (count === 1) return unit.replace(/^(\w+?)s\b/, "$1");
  return unit;
}

/**
 * How the two paths compare on ground covered.
 *
 * Coverage only decides anything when the gap is wide enough to be about the
 * answer rather than about noise, so the middle band is deliberately broad.
 */
function coverage(t: TaskResult): "breadth" | "shortfall" | "comparable" {
  const ratio = t.hired.coverage.count / Math.max(t.manual.coverage.count, 1);
  if (ratio >= 2) return "breadth";
  if (ratio <= 0.5) return "shortfall";
  return "comparable";
}

/**
 * Which path a task went to, by the same rule `verdictFor` narrates.
 *
 * Exported because /advantage marks a winner beside each row, and the first
 * draft of that page scored it independently — "whoever covered more" — which
 * agreed with the prose on today's numbers and would have disagreed the first
 * time an agent was both faster and level on coverage. A page contradicting
 * the sentence printed under it is worse than a page with no marker.
 */
export function winnerOf(t: TaskResult): "hired" | "manual" | "none" {
  if (!t.hired.ok || !t.manual.ok) return "none";
  switch (coverage(t)) {
    case "breadth":
      return "hired";
    case "shortfall":
      return "manual";
    default:
      // Coverage is level, so the clock decides — the same tie-break the
      // closing sentence of `verdictFor` makes in prose.
      return t.hired.ms <= t.manual.ms ? "hired" : "manual";
  }
}

/**
 * Scores a task on both axes and lets the numbers pick the winner.
 *
 * An earlier draft of this file asserted which path won each task in prose
 * written before the harness had ever run. Two of the three claims turned out
 * to be backwards. The verdict is computed now, so the report cannot drift
 * from its own measurements again.
 */
export function verdictFor(t: TaskResult): string {
  // A failed call has coverage 0, which used to fall straight through into
  // "the agent returned fewer, hiring loses on both axes" — a confident
  // measurement sentence describing a request that errored. That is worse
  // than reporting nothing: it puts a false claim about a named agent into a
  // document meant as evidence. Seen for real when a 1 MB response cap broke
  // the Aster call and the report blamed the agent.
  if (!t.hired.ok || !t.manual.ok) {
    const failed = !t.hired.ok ? "hired" : "manual";
    const detail = (!t.hired.ok ? t.hired.output : t.manual.output).slice(0, 120);
    return (
      `No verdict: the ${failed} path failed on this run (${detail}). ` +
      `Timings and counts below describe the attempt, not the agent.`
    );
  }

  const timeRatio = t.hired.ms / Math.max(t.manual.ms, 1);

  const timeSentence =
    timeRatio <= 1
      ? `Hiring was ${(1 / timeRatio).toFixed(1)}x faster`
      : `Doing it yourself was ${timeRatio.toFixed(1)}x faster`;

  const width = coverage(t);

  if (width === "breadth") {
    return (
      `${timeSentence}, but the agent returned ${t.hired.coverage.count} ` +
      `${t.hired.coverage.unit} against ${t.manual.coverage.count}. ` +
      `Hiring wins: matching that breadth by hand is many more calls, not one.`
    );
  }
  if (width === "shortfall") {
    return (
      `${timeSentence}, and it returned more: ${t.manual.coverage.count} ` +
      `${t.manual.coverage.unit} against the agent's ${t.hired.coverage.count}. ` +
      `Hiring loses on both axes.`
    );
  }
  return (
    `${timeSentence}; both paths returned the same ${plural(2, t.hired.coverage.unit)}. ` +
    `${timeRatio > 1 ? "Hiring buys convenience, not information." : "Hiring is the better default here."}`
  );
}
