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
  /**
   * Every record ever written about this agent, oldest first.
   *
   * The four fields above hold only the newest of each kind, so a second
   * uptime record overwrote the first and the register ended up holding ten
   * records this file could no longer name. `--revoke` works from a hash, so
   * a forgotten hash is a record Kawal wrote and cannot take back. The ten
   * already lost stay lost — the chain has them, this file does not — but
   * nothing written from here on joins them.
   */
  history?: Array<{ tag: "uptime" | "responseTime"; txHash: string; at: string; evidence?: string }>;
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
 * No duplicate was ever traced to it — the 102-against-92 gap that prompted
 * the look turned out to be earlier rounds this file no longer names, one hash
 * being kept per kind per agent. The bug is real all the same, and the window
 * it opens is a day wide: `at` is the only thing standing between a
 * measurement and being published a second time.
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
  // Appended before the overwriting fields are set, so the hash survives even
  // though the slot it used to occupy does not.
  const history = [
    ...(prev?.history ?? []),
    { tag: kind, txHash: hash, at, ...(evidence ? { evidence } : {}) },
  ];
  if (kind === "uptime") {
    return { ...prev, txHash: hash, at, checks, history, ...(evidence ? { evidence } : {}) };
  }
  return {
    ...prev,
    txHash: prev?.txHash ?? hash,
    at,
    checks,
    history,
    responseTimeTx: hash,
    ...(evidence ? { responseTimeEvidence: evidence } : {}),
  };
}

/**
 * Every transaction this file can still name for one agent, newest first.
 *
 * The two slots and the history are merged rather than one replacing the
 * other: entries written before `history` existed live only in the slots, and
 * dropping them would lose exactly what this was added to stop losing.
 */
export function everyHash(rec: PublishedRecord | undefined): string[] {
  if (!rec) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of [rec.txHash, rec.responseTimeTx, ...(rec.history ?? []).map((e) => e.txHash)]) {
    if (typeof h !== "string" || seen.has(h.toLowerCase())) continue;
    seen.add(h.toLowerCase());
    out.push(h);
  }
  return out;
}
