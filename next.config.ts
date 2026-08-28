import type { NextConfig } from "next";

/**
 * Headers every response carries, regardless of route.
 *
 * Kawal renders text that strangers wrote: an agent's name and description
 * come from an ERC-8004 registration anyone can mint for a few cents, and its
 * endpoint URL is fetched by the server. React escapes what it interpolates,
 * so this is defence in depth rather than the only line — but "the framework
 * escapes it" is a bet, and these headers are what limits the damage if the
 * bet is ever wrong.
 *
 * The Content-Security-Policy is not here: it needs a fresh nonce per request,
 * which only runs at request time. See `proxy.ts`.
 */
const securityHeaders = [
  // Browsers that sniff a response's type can be tricked into executing a
  // registration's description as script. They should not sniff.
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Referrers leak the page someone was on. An agent page's URL names the
  // agent they were considering hiring, which is nobody else's business.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // Nothing here needs a camera, a microphone or a location, so nothing here
  // may ask for one.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },

  // Legacy clickjacking control for browsers predating frame-ancestors, which
  // the CSP in proxy.ts also sets. Both, because the control room has a button
  // that permanently destroys a session key and framing it is exactly how you
  // would trick someone into pressing it.
  { key: "X-Frame-Options", value: "DENY" },

  // Two years, subdomains included. Only meaningful over HTTPS; browsers
  // ignore it on the plain-HTTP origins the test suite uses.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

/**
 * The machine-facing routes are read by clients on other origins: an MCP
 * client running in a browser, a directory's scanner, an A2A agent fetching
 * the card. They carry no cookies and take no key, so there is nothing an
 * origin could be granted that it does not already have, and "*" is the
 * honest value. The exposed header is the one the MCP transport echoes; the
 * allowed ones are the mirrored request headers the 2026-07-28 revision
 * requires clients to send.
 */
const corsHeaders = [
  { key: "Access-Control-Allow-Origin", value: "*" },
  { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
  { key: "Access-Control-Allow-Headers", value: "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID" },
  { key: "Access-Control-Expose-Headers", value: "MCP-Protocol-Version" },
  { key: "Access-Control-Max-Age", value: "86400" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/mcp", headers: corsHeaders },
      { source: "/api/a2a", headers: corsHeaders },
      { source: "/.well-known/:path*", headers: corsHeaders },
    ];
  },
  async rewrites() {
    return [
      // The App Router does not route dot-prefixed folders, and the well-known
      // path is where every A2A client looks first. Without this Kawal would
      // have a card and no address for it — present but undiscoverable, which
      // for an agent is the same as absent.
      { source: "/.well-known/agent-card.json", destination: "/api/agent-card" },
      // The ERC-8004 registration document, at the path other registrations
      // on BSC use for theirs ("Domain proof" points here on their hosts).
      { source: "/.well-known/agent-registration.json", destination: "/api/agent-registration" },
      // The MCP server card directories scan for. It is the endpoint's own
      // GET description, so the card is built from the tool list it serves.
      { source: "/.well-known/mcp/server-card.json", destination: "/api/mcp" },
    ];
  },
};

export default nextConfig;
