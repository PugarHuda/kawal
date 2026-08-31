/**
 * What Kawal keeps about the reputation records it has written.
 *
 * Its own bookkeeping, not the chain's: `recent()` in `scripts/publish-feedback.ts`
 * reads the `at` here to decide an agent was written about in the last day and
 * must not be written about again. Get that wrong in the direction of "not
 * written" and the register fills with duplicates about the same endpoint —
 * which is precisely the thing `npm run reputation` measured other writers
 * doing, and the reason Kawal publishes at all.
 */

export type PublishedRecord = {
  txHash: string;
  at: string;
  checks: number;
  responseTimeTx?: string;
  revokedTx?: string[];
  /** `ipfs://{cid}` when the evidence was pinned; absent for the data: URI records. */
  evidence?: string;
  responseTimeEvidence?: string;
};

/**
 * Folds one written record into what is already known about that agent.
 *
 * The `responseTime` branch used to spread the previous entry *after* the
 * fields it was setting, so `at` and `checks` were overwritten by the very
 * values they were meant to replace. An agent whose responseTime record was
 * written without an uptime record beside it therefore kept a stale `at`,
 * stayed due on every subsequent run, and had another record written about it
 * each time.
 *
 * Measured on 2026-08-31: 102 records stood on-chain against the 92 this file
 * named — ten agents carrying exactly one duplicate apiece, and about
 * 0.0001 BNB of gas spent saying the same thing twice.
 *
 * The previous entry goes first, always. Everything after it is this write.
 */
export function noteWrite(
  prev: PublishedRecord | undefined,
  kind: "uptime" | "responseTime",
  hash: string,
  checks: number,
  evidence: string | null,
  now: () => string = () => new Date().toISOString(),
): PublishedRecord {
  const at = now();
  if (kind === "uptime") {
    return { ...prev, txHash: hash, at, checks, ...(evidence ? { evidence } : {}) };
  }
  return {
    ...prev,
    txHash: prev?.txHash ?? hash,
    at,
    checks,
    responseTimeTx: hash,
    ...(evidence ? { responseTimeEvidence: evidence } : {}),
  };
}
