/**
 * Bounded parallelism, in one place.
 *
 * Written twice before this existed — once in `liveness.ts` for the listing
 * probes and once in `sweep.ts` for the audit — with the same body and no
 * shared tests. Two copies of a scheduler is two chances to get the exit
 * condition wrong, and the failure mode is a hung page rather than a loud
 * error.
 *
 * `Promise.all` over a mapped array is the obvious alternative and the wrong
 * one here: every item starts at once, so probing twenty agents opens twenty
 * sockets to other people's servers simultaneously. The point of this module
 * is the ceiling.
 */

/**
 * Runs `work` over `items`, never more than `limit` at a time.
 *
 * Results keep the input order regardless of completion order, so a caller
 * can zip them back against what it passed in.
 *
 * A rejection propagates: callers that want per-item tolerance catch inside
 * `work` and return a failure value, which is what both current callers do.
 * Swallowing here would hide a systematic failure as a page that quietly
 * shows less.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      // The bounds check above makes this safe; naming it makes that provable
      // rather than something a reader has to reconstruct.
      if (item === undefined) continue;
      results[index] = await work(item, index);
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
