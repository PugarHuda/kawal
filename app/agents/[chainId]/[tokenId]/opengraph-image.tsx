import { ImageResponse } from "next/og";
import { getAgent } from "@/lib/scan";
import { proveAgent } from "@/lib/probe";
import { uptimeFor } from "@/lib/uptime";
import { checkX402Cached } from "@/lib/x402";
import { assess, tierLabel, type Tier } from "@/lib/signals";
import { classify } from "@/lib/taxonomy";
import { categoryLabel } from "@/components/listing";
import { fonts } from "@/lib/og";

/**
 * One agent's inspection sheet as a share card.
 *
 * A link to an agent pasted into X or a Telegram group shows the stamp Kawal
 * pressed and the tally behind it, not a logo. The verdict is reached the way
 * the page reaches it — the same memoised probe, the same x402 check, the
 * same `assess` — so the card and the sheet cannot disagree. A crawler that
 * fetches this has already fetched the page, which made the same calls.
 */
export const dynamic = "force-dynamic";
export const alt = "Kawal — Form K-3, one agent's inspection sheet";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK: Record<Tier, string> = {
  hireable: "#4a2a7d",
  reachable: "#1f4e9c",
  unreachable: "#b5271f",
  registered: "#5a5850",
};

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

export default async function Image({ params }: { params: Promise<{ chainId: string; tokenId: string }> }) {
  const { chainId, tokenId } = await params;
  const [agent, loaded] = await Promise.all([getAgent(Number(chainId), tokenId).catch(() => null), fonts()]);
  const typed = loaded.some((f) => f.name === "Courier Prime") ? "Courier Prime" : "monospace";
  const form = loaded.some((f) => f.name === "Barlow Condensed") ? "Barlow Condensed" : "sans-serif";
  const cap = { fontFamily: form, fontSize: 20, letterSpacing: 2, color: "#66604f" } as const;

  let tier: Tier = "registered";
  let tally: string | null = null;
  let tallyNote = "declares nothing Kawal can call";
  if (agent) {
    const proof = await proveAgent(agent).catch(() => null);
    const [uptime, payment] = await Promise.all([
      proof ? uptimeFor(proof.endpoint).catch(() => null) : null,
      proof && agent.x402_supported === true ? checkX402Cached(proof.endpoint).catch(() => null) : null,
    ]);
    tier = assess(
      agent,
      undefined,
      uptime ? { checks: uptime.checks, answered: uptime.answered, reachedAnotherWay: proof?.descriptor != null } : undefined,
      payment ? { demanded: payment.demanded } : undefined,
    ).tier;
    if (uptime) {
      tally = `${uptime.answered} of ${uptime.checks}`;
      tallyNote = `calls answered since ${new Date(uptime.since * 1000).toISOString().slice(0, 10)}`;
    } else if (proof) {
      tally = proof.answered ? "answered" : "no answer";
      tallyNote = "first call placed by Kawal";
    }
  }
  const ink = INK[tier];
  const category = agent ? categoryLabel(classify(agent.name, agent.description).category) : "Unknown agent";

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#f1eadb", padding: 40 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, background: "#fbf8f0", border: "3px solid #1f1c17" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              borderBottom: "2px solid #1f1c17",
              padding: "10px 24px",
              fontFamily: form,
              fontSize: 22,
              letterSpacing: 2,
              color: "#4a453b",
            }}
          >
            <span>FORM K-3 · INSPECTION SHEET</span>
            <span style={{ color: "#b5271f", fontFamily: typed }}>
              No. {chainId}:{tokenId}
            </span>
          </div>
          <div style={{ display: "flex", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", flex: 1.4, padding: "32px 24px" }}>
              <span style={{ ...cap, color: "#b5271f" }}>{category.toUpperCase()}</span>
              <span style={{ fontFamily: typed, fontSize: 60, fontWeight: 700, lineHeight: 1.05, color: "#1f1c17", marginTop: 14 }}>
                {clip(agent?.name?.trim() || `Agent ${tokenId}`, 48)}
              </span>
              <span style={{ fontFamily: typed, fontSize: 24, color: "#4a453b", marginTop: 20, lineHeight: 1.4 }}>
                {clip(agent?.description?.trim() || "No description registered.", 150)}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                background: "#f2dc8e",
                borderLeft: "2px solid #1f1c17",
                padding: "32px 24px",
                position: "relative",
              }}
            >
              <span style={cap}>INSPECTED BY KAWAL</span>
              <span style={{ fontFamily: typed, fontSize: tally && tally.length > 9 ? 64 : 84, fontWeight: 700, color: "#1f1c17", marginTop: 8 }}>
                {tally ?? "—"}
              </span>
              <span style={{ fontFamily: typed, fontSize: 22, color: "#4a453b" }}>{tallyNote}</span>
              <div
                style={{
                  position: "absolute",
                  right: 28,
                  bottom: 36,
                  display: "flex",
                  padding: 3,
                  border: `2px solid ${ink}`,
                  transform: "rotate(-8deg)",
                  opacity: 0.9,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    padding: "8px 18px",
                    border: `2px solid ${ink}`,
                    color: ink,
                    fontFamily: form,
                    fontSize: 36,
                    letterSpacing: 4,
                  }}
                >
                  {tierLabel(tier).toUpperCase()}
                </div>
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              borderTop: "2px solid #1f1c17",
              padding: "10px 24px",
              fontFamily: form,
              fontSize: 20,
              letterSpacing: 2,
              color: "#4a453b",
            }}
          >
            KAWAL · BNB SMART CHAIN · ERC-8004 · A STAMP IS PRESSED ONLY AFTER KAWAL CALLED
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: loaded },
  );
}
