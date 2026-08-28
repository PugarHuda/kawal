import { NextResponse } from "next/server";
import { originOf } from "@/lib/origin";
import { TOOLS, SERVER_VERSION, PROTOCOL_VERSION, SUPPORTED_VERSIONS } from "@/lib/server.mcp";
import { payTo, PRICE_WEI } from "@/lib/x402.terms";
import { formatEther } from "viem";

/**
 * Kawal's own ERC-8004 registration document.
 *
 * Served at `/.well-known/agent-registration.json` by a rewrite, which is
 * where the registrations Kawal has read put theirs ("Domain proof" points
 * at that path on the agent's own host). The Identity Registry stores only a
 * URI; this is what the URI resolves to, and what 8004scan parses into the
 * `services` block every listing here is built from.
 *
 * The shape is `registration-v1` as read off a live BSC registration — not the
 * specification's example — with one rule about its contents: nothing is
 * declared that Kawal's own prober would not verify. `x402Support` is true
 * because `/api/report` really issues a challenge; the MCP and A2A services
 * really answer; and the checks that make those claims are the same code
 * that checks everybody else. A registration this project could not verify
 * would be the thing it exists to catch.
 *
 * `active` is false when the instance holds no wallet and therefore charges
 * for nothing — the flag is the registry's word for "open for business", and
 * a Kawal that cannot be paid is a directory, not a business.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = originOf(request);
  const to = payTo();

  const document = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Kawal",
    description:
      "Evidence about ERC-8004 agents on BNB Smart Chain, gathered by calling them. " +
      "Kawal dials a declared endpoint (MCP handshake, or A2A card plus a harmless JSON-RPC question) " +
      "and reports whether it answered; asks an agent that claims x402 whether it really charges; " +
      "reads who wrote its feedback rather than how much there is; and keeps every probe it has made, " +
      "so a single reading becomes a history. It writes those measurements back into the Reputation " +
      "Registry with the method and the defects of the method stated. The one paid skill is a deep " +
      `report on one agent, ${formatEther(PRICE_WEI)} BNB, settled by a plain transfer Kawal verifies on-chain.`,
    image: `${origin}/favicon.ico`,
    active: to !== null,
    x402Support: to !== null,
    supportedTrust: ["reputation"],
    services: [
      {
        name: "mcp",
        description:
          `Model Context Protocol, streamable HTTP, revisions ${SUPPORTED_VERSIONS.join(", ")}. ` +
          `${TOOLS.length} tools: ${TOOLS.map((t) => t.name).join(", ")}. Resources and one prompt.`,
        endpoint: `${origin}/api/mcp`,
        // The revision a handshake gets when it asks for none: the same
        // constant the server answers with, so the document cannot say one
        // thing and the endpoint another.
        version: PROTOCOL_VERSION,
      },
      {
        name: "a2a",
        description: "A2A 0.3 JSON-RPC, message/send and message/stream (SSE). Send a data part naming a skill, or plain text with a token id in it.",
        endpoint: `${origin}/.well-known/agent-card.json`,
        version: "0.3.0",
      },
      {
        name: "web",
        description: "The catalogue, the evidence pages, and the control room.",
        endpoint: origin,
      },
    ],
    attributes: [
      { trait_type: "Category", value: "verification" },
      { trait_type: "Chain", value: "BNB Smart Chain" },
      { trait_type: "Domain proof", value: `${origin}/.well-known/agent-registration.json` },
      { trait_type: "Payment", value: to ? `native BNB transfer to ${to}, receipt read on-chain` : "none on this instance" },
      { trait_type: "Version", value: SERVER_VERSION },
    ],
  };

  return NextResponse.json(document, { headers: { "cache-control": "public, max-age=300" } });
}
