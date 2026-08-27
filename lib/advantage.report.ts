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

export type Run = {
  path: "hired" | "manual";
  label: string;
  ms: number;
  ok: boolean;
  /** What came back, verbatim. Long payloads are also written to OUT_DIR. */
  output: string;
  /** Fastest-to-slowest of the samples, so the reader can see the noise. */
  spread: string;
  /** Money that actually left a wallet for this run, in USD. */
  costUsd: number;
  /**
   * How much of the question this path actually answered. Wall clock alone
   * would score a one-market lookup as beating a fourteen-vault survey.
   */
  coverage: { count: number; unit: string };
  note?: string;
};

export type TaskResult = {
  id: string;
  title: string;
  category: string;
  question: string;
  hired: Run;
  manual: Run;
  verdict: string;
};

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
  const coverRatio = t.hired.coverage.count / Math.max(t.manual.coverage.count, 1);

  const timeSentence =
    timeRatio <= 1
      ? `Hiring was ${(1 / timeRatio).toFixed(1)}x faster`
      : `Doing it yourself was ${timeRatio.toFixed(1)}x faster`;

  // Coverage only decides anything when the gap is wide enough to be about the
  // answer rather than about noise.
  if (coverRatio >= 2) {
    return (
      `${timeSentence}, but the agent returned ${t.hired.coverage.count} ` +
      `${t.hired.coverage.unit} against ${t.manual.coverage.count}. ` +
      `Hiring wins: matching that breadth by hand is many more calls, not one.`
    );
  }
  if (coverRatio <= 0.5) {
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
