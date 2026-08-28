import { NextResponse, type NextRequest } from "next/server";
import { takeDurable, groupOf, LIMITS } from "./lib/ratelimit";

/**
 * A Content-Security-Policy with a fresh nonce on every request.
 *
 * Kawal renders strangers' text — agent names and descriptions come from
 * registrations anyone can mint — so the value of a CSP here is not
 * theoretical. React escapes what it interpolates, which is why nothing has
 * gone wrong; this is what bounds the damage the day something does.
 *
 * Lives in `proxy.ts` rather than `next.config.ts` because a nonce is only
 * unpredictable if it is generated per request, and static config headers are
 * computed once at build time.
 *
 * Two deliberate loosenings, both narrower than they look:
 *
 *   `style-src-attr 'unsafe-inline'` — this interface colours seats, health
 *   states and score bars through `style={{ … }}` attributes, dozens of them,
 *   all from a fixed palette. Blocking those would render the product
 *   colourless. Scoping the exception to `-attr` keeps `<style>` elements and
 *   external stylesheets locked down, which is where injected CSS actually
 *   does harm.
 *
 *   `'unsafe-eval'` in development only — React uses `eval` to rebuild server
 *   stack traces in the browser. Production never gets it.
 */
export async function proxy(request: NextRequest) {
  // Before anything else, for the routes that fetch on a caller's behalf. A
  // 429 needs no nonce and no policy: it carries no script and no page.
  //
  // The bucket lives in the shared database when there is one: Proxy runs on
  // the Node runtime in Next 16, so the libSQL client works here, and Vercel
  // runs more than one instance, so a per-process bucket was N ceilings.
  const group = groupOf(request.nextUrl.pathname);
  if (group) {
    // The first forwarded address is the caller; the rest are proxies. With
    // no forwarding header there is one caller, whoever is on the socket.
    const caller = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "direct";
    const decision = await takeDurable(`${group}:${caller}`, LIMITS[group]);
    if (!decision.ok) {
      return NextResponse.json(
        { error: "rate limited", retryAfterSeconds: decision.retryAfterSeconds },
        {
          status: 429,
          headers: { "retry-after": String(decision.retryAfterSeconds), "cache-control": "no-store" },
        },
      );
    }
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    // Agent avatars are served from the registry's blob host and IPFS
    // gateways. `data:` covers the inline SVG sparkline.
    "img-src 'self' blob: data: https:",
    // next/font/google self-hosts the files at build time, so no font CDN
    // needs allowing.
    "font-src 'self'",
    // Nothing in this app is fetched from the browser to a third party: the
    // registry, the chain and every agent endpoint are called server-side.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only outside development: the test suite and local runs speak plain
    // HTTP, and upgrading those would make every request fail.
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  // Next reads the nonce off the request header and stamps it onto the scripts
  // it injects. Without this the policy would block the framework's own
  // bootstrap and the page would render but never hydrate — a site that looks
  // fine and does nothing.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except the paths that neither need nor benefit from a policy:
     * build output, the favicon, and prefetches. A nonce on a prefetch is
     * wasted work on every hover.
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
