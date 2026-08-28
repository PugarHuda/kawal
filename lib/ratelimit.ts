/**
 * A token bucket per caller, for the endpoints that fetch on a caller's
 * behalf.
 *
 * `/api/mcp`, `/api/a2a` and `/api/report` each turn one inbound request into
 * outbound calls at other people's servers, and `/owner` turns one into as
 * many as two dozen. Without a ceiling, anyone can point a loop at Kawal and
 * have it dial the whole roster on their behalf — an amplifier with Kawal's
 * name on the traffic. The memo layer blunts this for repeated targets and
 * does nothing for a caller who varies them.
 *
 * ponytail: in memory, per process. A second instance keeps its own buckets,
 * so the effective ceiling is N times this. Move to a shared store the day
 * Kawal runs on more than one — until then a store would be a dependency
 * guarding against a deployment that does not exist.
 */

export type Limit = {
  /** Requests a caller may make in a burst. */
  capacity: number;
  /** Requests per second the bucket refills at. */
  perSecond: number;
};

export const LIMITS: Record<"api" | "owner", Limit> = {
  // One a second with a minute's burst: more than any client needs and far
  // less than a loop wants.
  api: { capacity: 60, perSecond: 1 },
  // Each lookup fans out to every agent an owner holds, so this is tighter.
  owner: { capacity: 20, perSecond: 1 / 3 },
};

type Bucket = { tokens: number; at: number };

const buckets = new Map<string, Bucket>();

/**
 * Buckets are dropped wholesale past this many rather than expired one by
 * one. A caller who has not been seen since the map filled is back to a full
 * bucket, which is the generous direction to fail in.
 */
const MAX_BUCKETS = 10_000;

export type Decision = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Takes one token for `key` under `limit`, or says how long until one exists.
 *
 * `now` is a parameter so the offline suite can move time rather than wait.
 */
export function take(key: string, limit: Limit, now = Date.now()): Decision {
  if (buckets.size >= MAX_BUCKETS) buckets.clear();

  const b = buckets.get(key) ?? { tokens: limit.capacity, at: now };
  const elapsed = Math.max(0, now - b.at) / 1000;
  const tokens = Math.min(limit.capacity, b.tokens + elapsed * limit.perSecond);

  if (tokens < 1) {
    buckets.set(key, { tokens, at: now });
    return { ok: false, retryAfterSeconds: Math.ceil((1 - tokens) / limit.perSecond) };
  }

  buckets.set(key, { tokens: tokens - 1, at: now });
  return { ok: true };
}

/** Which ceiling a path sits under, or none. */
export function groupOf(pathname: string): keyof typeof LIMITS | null {
  if (pathname.startsWith("/api/mcp") || pathname.startsWith("/api/a2a") || pathname.startsWith("/api/report")) {
    return "api";
  }
  if (pathname === "/owner" || pathname === "/owner/") return "owner";
  return null;
}

/** Only for the offline suite: a fresh map between cases. */
export function resetForTests() {
  buckets.clear();
}
