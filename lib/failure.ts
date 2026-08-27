/**
 * How an endpoint is dead, not just that it is.
 *
 * Kawal files every unreachable agent under one tier and one word: "does not
 * answer". Its own probe log says that word is covering at least four
 * different situations, and they are not the same proposition to somebody
 * about to grant a spend cap.
 *
 * From 669 probes kept on this instance:
 *
 *   62  could not resolve syenite.ai        the domain itself is gone
 *   61  HTTP 404 {"error":"agent not found"} the host is alive; this agent is not
 *   38  HTTP 502 (Cloudflare)                the origin is down right now
 *    5  timed out after 6000ms               something is there and not talking
 *
 * A vanished domain is an abandonment: nobody is coming back to fix it, and
 * the registration will point at nothing forever. A 502 is a bad afternoon.
 * The 404 is the interesting one — the host answered *about* the agent to say
 * it does not have it, which is a deregistration that exists nowhere in the
 * registry, because ERC-8004 has no way to record one.
 *
 * Reported, never guessed. Anything that does not match a known shape comes
 * back as `unknown` with the original text, because inventing a diagnosis is
 * worse than showing the error.
 */

export type Failure =
  /** DNS does not resolve, or the host refused the connection outright. */
  | "gone"
  /** The host answered, and said it has no such agent. */
  | "delisted"
  /** The host or its proxy is failing right now. */
  | "down"
  /** Something is listening and would not complete the exchange. */
  | "refusing"
  /** Kawal's own guard stopped the call before it left. */
  | "blocked"
  | "unknown";

export type Diagnosis = {
  failure: Failure;
  /** One line a person can act on. */
  summary: string;
  /** Whether waiting is likely to help. */
  transient: boolean;
  /** The prober's own words, always carried. */
  raw: string;
};

const NOT_FOUND = /\bagent not found\b|\bno such agent\b/i;

/**
 * Classifies one probe error.
 *
 * Order matters. "blocked: could not resolve x" is both a guard message and a
 * DNS failure, and the DNS reading is the one worth showing: the guard did not
 * refuse the host on policy, it could not find it.
 */
export function diagnose(error: string | null | undefined): Diagnosis | null {
  if (!error) return null;
  const raw = error;
  const e = error.toLowerCase();

  if (/could not resolve|enotfound|dns/.test(e)) {
    return {
      failure: "gone",
      summary: "The domain in this registration does not resolve. Nobody is running this any more.",
      transient: false,
      raw,
    };
  }

  if (/econnrefused|refused the connection/.test(e)) {
    return {
      failure: "gone",
      summary: "The host exists but nothing is listening on it.",
      transient: false,
      raw,
    };
  }

  // Checked before the general 4xx rule: a host that answers *about* the agent
  // is a different thing from one that does not recognise the request.
  if (NOT_FOUND.test(e)) {
    return {
      failure: "delisted",
      summary:
        "The host is alive and says it does not have this agent. It was taken down where the registry cannot see — ERC-8004 has no way to record a deregistration.",
      transient: false,
      raw,
    };
  }

  const status = e.match(/http (\d{3})/);
  if (status) {
    const code = Number(status[1]);
    if (code >= 500) {
      return {
        failure: "down",
        summary: `The host answered ${code}. Its origin is failing right now; this one may pass on a later check.`,
        transient: true,
        raw,
      };
    }
    if (code === 404 || code === 410) {
      return {
        failure: "delisted",
        summary: `The host answered ${code}. There is nothing at this path any more.`,
        transient: false,
        raw,
      };
    }
    return {
      failure: "refusing",
      summary: `The host answered ${code} to the opening MCP call. Something is there and will not speak this protocol.`,
      transient: false,
      raw,
    };
  }

  if (/timed out|timeout|aborted/.test(e)) {
    return {
      failure: "refusing",
      summary: "Nothing came back before the deadline. Overloaded, or not answering us specifically.",
      transient: true,
      raw,
    };
  }

  if (/^blocked:/.test(e)) {
    return {
      failure: "blocked",
      summary: "Kawal's own guard stopped this call before it left. The address is not one we will dial.",
      transient: false,
      raw,
    };
  }

  return {
    failure: "unknown",
    summary: "The call failed in a way Kawal does not have a name for.",
    transient: false,
    raw,
  };
}

const LABEL: Record<Failure, string> = {
  gone: "Abandoned",
  delisted: "Delisted by its host",
  down: "Down right now",
  refusing: "Not speaking",
  blocked: "Not dialled",
  unknown: "Failed",
};

export function failureLabel(f: Failure) {
  return LABEL[f];
}
