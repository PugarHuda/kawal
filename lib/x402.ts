/**
 * Does an agent that says it takes payment actually ask for any?
 *
 * `x402_supported` is a boolean 8004scan copies out of a registration, and
 * Kawal has been repeating it as fact — the same mistake the MCP probe exists
 * to correct, made about money instead of about calls. It matters more here:
 * `assess` requires `payable` before it will call an agent hireable, so an
 * unbacked flag is currently helping registrations to the top of the page.
 *
 * A sweep of 200 BSC registrations found 75 claiming x402 and, of the 25 with
 * a reachable endpoint, zero that answered with a payment challenge. Run
 * `npm run x402` for today's count rather than trusting that one.
 *
 * The check is the same one an x402 client makes on its first request: ask
 * without a payment header and see whether the server demands one. A server
 * that wants paying answers 402 and describes the price; a server that does
 * not, does not.
 *
 * Kawal never pays. Reading a challenge is free and tells a visitor what an
 * agent costs; paying it would move a stranger's money on a network Kawal has
 * no mandate over. The price is quoted in the server's own words for the same
 * reason a descriptor's install command is: so nobody has to trust our
 * arithmetic about somebody else's token decimals.
 */

import { guardedFetch, readCapped, BlockedUrlError } from "./ssrf.ts";
import { memo } from "./memo.ts";

/**
 * A payment challenge is a short document. The shared 1 MB cap is sized for
 * tool listings; anything approaching it here is not a price.
 */
const CHALLENGE_BYTES = 64_000;

/** One way a server is willing to be paid, as it described it. */
export type PaymentOption = {
  scheme: string;
  /** CAIP-2, e.g. "eip155:8453". Left verbatim — we do not own this namespace. */
  network: string;
  asset: string;
  /** Atomic units, as a string. Decimals are not in the challenge. */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number | null;
};

export type X402Check = {
  endpoint: string;
  /** The server answered with a payment challenge we could read. */
  demanded: boolean;
  x402Version: number | null;
  accepts: PaymentOption[];
  /** The server's own sentence about the price. Quoted, never recomputed. */
  quote: string | null;
  serviceName: string | null;
  status: number;
  error: string | null;
  checkedAt: string;
};

function option(raw: unknown): PaymentOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  // scheme, network and amount are what make a challenge actionable. Without
  // all three this is a fragment, and a half-read price is worse than none.
  if (typeof o.scheme !== "string" || typeof o.network !== "string") return null;
  const amount = typeof o.amount === "string" ? o.amount : typeof o.amount === "number" ? String(o.amount) : null;
  if (amount === null) return null;
  return {
    scheme: o.scheme,
    network: o.network,
    asset: typeof o.asset === "string" ? o.asset : "",
    amount,
    payTo: typeof o.payTo === "string" ? o.payTo : "",
    maxTimeoutSeconds: typeof o.maxTimeoutSeconds === "number" ? o.maxTimeoutSeconds : null,
  };
}

/**
 * Reads a challenge out of a parsed body.
 *
 * Exported so the offline suite can exercise the shapes without a network:
 * the parser is where a malformed challenge turns into a wrong price, and
 * that is worth checking against fixtures rather than against whatever the
 * internet happens to be serving today.
 */
export function readChallenge(body: unknown): Pick<X402Check, "x402Version" | "accepts" | "quote" | "serviceName"> | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const accepts = Array.isArray(b.accepts)
    ? b.accepts.map(option).filter((o): o is PaymentOption => o !== null)
    : [];
  // A 402 with nothing payable in it is a refusal, not a price.
  if (accepts.length === 0) return null;

  const resource = (typeof b.resource === "object" && b.resource !== null ? b.resource : {}) as Record<string, unknown>;
  return {
    x402Version: typeof b.x402Version === "number" ? b.x402Version : null,
    accepts,
    quote: typeof b.error === "string" ? b.error : null,
    serviceName: typeof resource.serviceName === "string" ? resource.serviceName : null,
  };
}

/**
 * Asks an endpoint for payment terms without offering payment.
 *
 * A GET with no payment header is what every x402 client sends first, so this
 * is not a probe the server has to tolerate specially — it is the protocol's
 * own opening move.
 */
export async function checkX402(endpoint: string, opts: { timeoutMs?: number } = {}): Promise<X402Check> {
  const base: X402Check = {
    endpoint,
    demanded: false,
    x402Version: null,
    accepts: [],
    quote: null,
    serviceName: null,
    status: 0,
    error: null,
    checkedAt: new Date().toISOString(),
  };

  try {
    const res = await guardedFetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });

    const header = res.headers.get("payment-required");
    if (res.status !== 402 && !header) {
      return { ...base, status: res.status, error: "answered without asking to be paid" };
    }

    // Two carriers for the same document. q402 sends both; the header is the
    // one a proxy can act on without reading a body, so it is tried first.
    let parsed: ReturnType<typeof readChallenge> = null;
    if (header) {
      try {
        parsed = readChallenge(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      try {
        parsed = readChallenge(JSON.parse(await readCapped(res, CHALLENGE_BYTES)));
      } catch {
        parsed = null;
      }
    }

    if (!parsed) {
      return { ...base, status: res.status, error: "answered 402 with no readable payment terms" };
    }
    return { ...base, ...parsed, demanded: true, status: res.status };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      error: e instanceof BlockedUrlError ? `blocked: ${message}` : message,
    };
  }
}

/** CAIP-2 rendered for a person, without pretending to know every chain. */
export function networkName(caip2: string) {
  const known: Record<string, string> = {
    "eip155:56": "BNB Smart Chain",
    "eip155:97": "BSC testnet",
    "eip155:8453": "Base",
    "eip155:1": "Ethereum",
    "eip155:137": "Polygon",
    "eip155:42161": "Arbitrum",
  };
  return known[caip2] ?? caip2;
}

/**
 * How long a payment quote is reused.
 *
 * Longer than a liveness proof: what an agent charges changes far less often
 * than whether it is up, and every one of these is a request to somebody
 * else's server.
 */
const QUOTE_TTL_MS = 300_000;

/** `checkX402`, shared across concurrent callers and reused while fresh. */
export function checkX402Cached(endpoint: string, opts: { timeoutMs?: number } = {}) {
  return memo(`x402:${endpoint}`, QUOTE_TTL_MS, () => checkX402(endpoint, opts));
}
