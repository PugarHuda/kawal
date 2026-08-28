import { NextResponse } from "next/server";
import { agentCard } from "@/lib/server.a2a";
import { originOf } from "@/lib/origin";

/**
 * Kawal's A2A agent card.
 *
 * Served at `/.well-known/agent-card.json` by a rewrite in next.config.ts —
 * the App Router does not route dot-prefixed folders, and the well-known path
 * is the one every A2A client looks at first, so the rewrite is what makes
 * Kawal discoverable rather than merely present.
 *
 * The same reader Kawal points at every other agent's card is run against
 * this one in the offline suite. A card that Kawal could not verify would be
 * the claim it refuses to make about anyone else.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json(agentCard(originOf(request)), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
