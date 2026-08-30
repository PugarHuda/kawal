import { NextResponse } from "next/server";
import { agentCard, signAgentCard } from "@/lib/server.a2a";
import { originOf } from "@/lib/origin";
import { adminKey, hasAdminKey } from "@/lib/vault";

/**
 * Kawal's A2A agent card.
 *
 * Served at `/.well-known/agent-card.json` by a rewrite in next.config.ts —
 * the App Router does not route dot-prefixed folders, and the well-known path
 * is the one every A2A client looks at first, so the rewrite is what makes
 * Kawal discoverable rather than merely present.
 *
 * Signed with the admin key where the instance holds one, so the card and
 * the mandate wallet answer to the same secp256k1 identity. An instance
 * without the key serves the card unsigned rather than signing with a key
 * that means nothing; the reader on the other side reports "unsigned", which
 * is the truth of it.
 *
 * The same reader Kawal points at every other agent's card is run against
 * this one in the offline suite. A card that Kawal could not verify would be
 * the claim it refuses to make about anyone else.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const card = agentCard(originOf(request));
  return NextResponse.json(hasAdminKey() ? await signAgentCard(card, adminKey()) : card, {
    headers: { "cache-control": "public, max-age=300" },
  });
}
