/**
 * Collapses concurrent identical work into one call, and remembers the answer
 * for a while.
 *
 * Measured, not guessed: the Playwright suite passes at four workers and
 * fails at the default (one per core). Every category page fans out to twelve
 * upstream calls — three probes against semantic search plus three probes
 * across three callable protocols — and Next's fetch cache only helps once an
 * answer has landed. Twenty-two cold requests arriving together therefore
 * issued twelve upstream calls *each*, and the pile-up is what broke.
 *
 * Two mechanisms, and the first is the one that fixed it:
 *
 *   singleflight — while a key is in flight, every other caller awaits the
 *                  same promise instead of starting its own fan-out. This is
 *                  the pattern Go ships as golang.org/x/sync/singleflight.
 *   ttl          — once it resolves, the value is served from memory until it
 *                  goes stale, so the second visitor pays nothing at all.
 *
 * Deliberately in-process. A shared cache (Redis, or Next's
 * `use cache: remote`) is what a multi-instance deployment needs, and this
 * would then be the per-instance layer in front of it rather than a thing to
 * replace. Enabling `cacheComponents` for `use cache` was the alternative
 * considered; it changes rendering semantics app-wide, which is a large blast
 * radius for a problem that is really about deduplicating a burst.
 */

type Entry<T> = {
  /** Set while the work is running, so concurrent callers can join it. */
  inflight: Promise<T> | null;
  value: T | null;
  /** Unix ms after which `value` is stale. */
  expiresAt: number;
};

const store = new Map<string, Entry<unknown>>();

/** How many resolved entries to keep before evicting the oldest. */
const MAX_ENTRIES = 200;

function evictIfNeeded() {
  if (store.size <= MAX_ENTRIES) return;
  // Oldest insertion first: a Map iterates in insertion order, and anything
  // still in flight is young by definition.
  for (const key of store.keys()) {
    if (store.size <= MAX_ENTRIES) break;
    const entry = store.get(key);
    if (entry && !entry.inflight) store.delete(key);
  }
}

/**
 * Runs `work` for `key`, joining any call already in progress and serving a
 * fresh cached value when there is one.
 *
 * A rejection is never cached: the entry is cleared so the next caller
 * retries. Caching a failure for five minutes would turn one upstream blip
 * into five minutes of an empty category page.
 */
export function memo<T>(key: string, ttlMs: number, work: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = store.get(key) as Entry<T> | undefined;

  if (existing?.inflight) return existing.inflight;
  if (existing && existing.value !== null && existing.expiresAt > now) {
    return Promise.resolve(existing.value);
  }

  const inflight = work()
    .then((value) => {
      store.set(key, { inflight: null, value, expiresAt: Date.now() + ttlMs });
      evictIfNeeded();
      return value;
    })
    .catch((err) => {
      store.delete(key);
      throw err;
    });

  store.set(key, { inflight, value: null, expiresAt: 0 });
  return inflight;
}

/** Drops everything. Only used by tests that need a cold start. */
export function clearMemo() {
  store.clear();
}

/** Entry count, split by state. Used by the self-check. */
export function memoStats() {
  let inflight = 0;
  for (const entry of store.values()) if (entry.inflight) inflight++;
  return { total: store.size, inflight };
}
