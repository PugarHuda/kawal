/**
 * Guards outbound requests to URLs that strangers control.
 *
 * Every `endpoint` field Kawal probes comes out of an ERC-8004 registration,
 * and anyone can mint one of those for a few cents. Fetching it server-side
 * without a guard turns Kawal into a port scanner that attackers can aim at
 * whatever network the app is deployed into: probe results already
 * distinguish "connection refused" from "405 Method Not Allowed" from "not
 * MCP", which is enough to map internal services one registration at a time.
 *
 * Verified against the running app before this existed — `http://[::1]:3141/`
 * came back reachable with a 405.
 *
 * The blocked ranges follow the same list the BNB agent SDK documents for its
 * own `parseAgentUri` guard: cloud metadata, loopback, private, link-local,
 * CGNAT and reserved space, plus no redirects and a response cap. That SDK is
 * no longer a dependency here — nothing imported it — but the range list was
 * the right one and is kept.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BlockedUrlError extends Error {}

/** Hostnames that resolve to infrastructure rather than to a service. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/**
 * Parsed into named octets rather than destructured out of an array.
 *
 * The array form was safe — the length check ran first — but only a human
 * could see that, and this is the module that decides whether a stranger's
 * URL gets fetched from inside the network. Under the strictest type checking
 * the old shape produced nineteen "possibly undefined" errors here alone;
 * silencing those with assertions would have removed the warning and kept the
 * doubt. This way the guard the compiler checks is the guard that runs.
 */
function octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  const [a, b, c, d] = parts.map(Number);
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;

  return [a, b, c, d];
}

function ipv4Blocked(ip: string): string | null {
  const parsed = octets(ip);
  if (!parsed) return "malformed IPv4 address";
  const [a, b] = parsed;
  if (a === 0) return "unspecified 0.0.0.0/8";
  if (a === 10) return "private 10.0.0.0/8";
  if (a === 127) return "loopback 127.0.0.0/8";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT 100.64.0.0/10";
  // 169.254.169.254 is the cloud instance metadata address on AWS, GCP and
  // Azure alike. It is the single most valuable target of an SSRF.
  if (a === 169 && b === 254) return "link-local 169.254.0.0/16 (cloud metadata)";
  if (a === 172 && b >= 16 && b <= 31) return "private 172.16.0.0/12";
  if (a === 192 && b === 0) return "IETF protocol assignments 192.0.0.0/24";
  if (a === 192 && b === 168) return "private 192.168.0.0/16";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking 198.18.0.0/15";
  if (a >= 224 && a <= 239) return "multicast 224.0.0.0/4";
  if (a >= 240) return "reserved 240.0.0.0/4";
  return null;
}

/**
 * Expands any IPv6 spelling to its eight 16-bit words.
 *
 * Needed because the shorthands are not cosmetic. `new URL()` rewrites
 * `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a check that only recognised
 * the dotted-quad form let IPv4-mapped loopback through — verified against
 * this guard before it was fixed. Reading the words directly makes every
 * spelling of the same address collapse to the same answer.
 */
function ipv6Words(ip: string): number[] | null {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");

  // A trailing dotted quad ("::ffff:127.0.0.1") is two more words.
  const dotted = lower.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let head = lower;
  const tail: number[] = [];
  if (dotted?.[1] !== undefined && dotted[2] !== undefined) {
    const quad = octets(dotted[2]);
    if (!quad) return null;
    const [a, b, c, d] = quad;
    tail.push((a << 8) | b, (c << 8) | d);
    head = dotted[1].replace(/:$/, "");
    if (head === "") head = "::";
  }

  const halves = head.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));

  const left = parse(halves[0] ?? "");
  const right = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if ([...left, ...right].some(Number.isNaN)) return null;

  const words =
    halves.length === 2
      ? [...left, ...Array(Math.max(0, 8 - tail.length - left.length - right.length)).fill(0), ...right, ...tail]
      : [...left, ...tail];

  return words.length === 8 ? words : null;
}

function ipv6Blocked(ip: string): string | null {
  const w = ipv6Words(ip);
  // `ipv6Words` only ever returns exactly eight words or null, but the type
  // cannot say so from a `number[]`. Naming them makes the eight explicit and
  // removes every unchecked index from the decisions below.
  if (!w) return "unparseable IPv6 address";
  const [w0, w1, w2, w3, w4, w5, w6, w7] = w;
  if (
    w0 === undefined || w1 === undefined || w2 === undefined || w3 === undefined ||
    w4 === undefined || w5 === undefined || w6 === undefined || w7 === undefined
  ) {
    return "unparseable IPv6 address";
  }

  const head7 = [w0, w1, w2, w3, w4, w5, w6];
  if (head7.every((x) => x === 0) && w7 === 0) return "IPv6 unspecified ::";
  if (head7.every((x) => x === 0) && w7 === 1) return "IPv6 loopback ::1";

  // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 costume, in either
  // spelling. The embedded address is what actually gets connected to.
  if ([w0, w1, w2, w3, w4].every((x) => x === 0) && w5 === 0xffff) {
    const v4 = `${w6 >> 8}.${w6 & 0xff}.${w7 >> 8}.${w7 & 0xff}`;
    const reason = ipv4Blocked(v4);
    return reason ? `IPv4-mapped ${v4}: ${reason}` : null;
  }

  if ((w0 & 0xfe00) === 0xfc00) return "IPv6 unique local fc00::/7";
  if ((w0 & 0xffc0) === 0xfe80) return "IPv6 link-local fe80::/10";
  return null;
}

function addressBlocked(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) return ipv4Blocked(ip);
  if (family === 6) return ipv6Blocked(ip);
  return "not a recognisable IP address";
}

/**
 * Rejects a URL that points anywhere but the public internet.
 *
 * Resolves the hostname and checks every address it answers with, so a
 * hostname pointed at 127.0.0.1 is caught as well as a bare IP literal.
 *
 * Known limit, stated rather than papered over: this resolves once and
 * `fetch` resolves again, so a DNS entry that changes between the two calls
 * (classic rebinding) is not stopped by this check alone. Closing that needs
 * connecting to a pinned address, which `fetch` gives no hook for. The
 * remaining defences — no redirects, a short timeout, a response cap, and
 * never echoing the body back to the browser — are what bound the damage.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`refusing protocol ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    throw new BlockedUrlError(`refusing hostname ${host}`);
  }

  if (isIP(host)) {
    const reason = addressBlocked(host);
    if (reason) throw new BlockedUrlError(`refusing ${host}: ${reason}`);
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`could not resolve ${host}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`${host} resolved to nothing`);

  for (const { address } of addresses) {
    const reason = addressBlocked(address);
    if (reason) throw new BlockedUrlError(`refusing ${host} -> ${address}: ${reason}`);
  }

  return url;
}

/** Response bodies larger than this are truncated rather than buffered. */
export const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * `fetch` for URLs a stranger supplied.
 *
 * Redirects are refused rather than followed: a public URL that 302s to
 * 169.254.169.254 would otherwise walk straight through the check above.
 */
export async function guardedFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  const url = await assertPublicUrl(raw);
  return fetch(url, { ...init, redirect: "error", cache: "no-store" });
}

/** Reads a response body, refusing to buffer more than the cap. */
export async function readCapped(res: Response, cap = MAX_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > cap) throw new BlockedUrlError(`response declares ${declared} bytes, over the cap`);

  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new BlockedUrlError(`response exceeded ${cap} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const out = new Uint8Array(acc.length + c.length);
      out.set(acc);
      out.set(c, acc.length);
      return out;
    }, new Uint8Array()),
  );
}
