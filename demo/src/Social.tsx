import { AbsoluteFill } from "remotion";

const VIOLET = "#4a2a7d";
const TYPED = "'Courier Prime', 'Courier New', monospace";
const FORM = "'Barlow Condensed', 'Arial Narrow', sans-serif";

const cap = { fontFamily: FORM, fontWeight: 600, fontSize: 19, letterSpacing: 2, textTransform: "uppercase", color: "#66604f" } as const;

/** The share card for the post: the cover sheet with the mark on it. Render: `remotion still src/index.ts Social out/social.png`. */
export const Social = ({ registered, calls, endpoints, answered, seats }: { registered: string; calls: string; endpoints: string; answered: string; seats: string }) => (
  <AbsoluteFill style={{ background: "#f1eadb", padding: 34 }}>
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#fbf8f0", border: "3px solid #1f1c17" }}>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "14px 26px", borderBottom: "3px solid #1f1c17" }}>
        <span style={cap}>Form K-1 · cover sheet</span>
        <span style={cap}>Build the Era · BNB Chain hackathon</span>
        <span style={{ fontFamily: TYPED, fontSize: 20, letterSpacing: 1, color: "#b5271f" }}>No. K1-{registered}</span>
      </div>
      <div style={{ flex: 1, display: "flex" }}>
        <div style={{ flex: 1.25, padding: "26px 30px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <svg viewBox="0 0 64 64" width="64" height="64">
              <g transform="rotate(-8 32 32)" fill="none" stroke={VIOLET}>
                <rect x="5.5" y="5.5" width="53" height="53" rx="3" strokeWidth="3.5" />
                <rect x="12" y="12" width="40" height="40" rx="1.5" strokeWidth="1.8" />
                <path d="M24 19v26M24 34l15-15M28.5 29.5L40 45" strokeWidth="6" strokeLinecap="square" />
              </g>
            </svg>
            <span style={{ fontFamily: FORM, fontWeight: 700, fontSize: 62, lineHeight: 1, letterSpacing: -1, color: "#1c1913" }}>Kawal</span>
            <span style={{ ...cap, marginLeft: 8, marginTop: 8 }}>agent marketplace · BNB Smart Chain</span>
          </div>
          <div style={{ fontFamily: TYPED, fontWeight: 700, fontSize: 60, lineHeight: 1.08, color: "#1c1913", maxWidth: 620 }}>
            Most agents on BSC cannot be hired.
          </div>
          <div style={{ fontFamily: TYPED, fontSize: 23, lineHeight: 1.45, color: "#1c1913", maxWidth: 640 }}>
            Kawal calls every agent itself before it lists one, stamps what answered, and lets you hire under limits it cannot cross — spend
            cap, allowlist, expiry, revocable.
          </div>
        </div>
        <div style={{ flex: 0.85, background: "#f2dc8e", borderLeft: "3px solid #1f1c17", padding: "26px 30px", display: "flex", flexDirection: "column", position: "relative" }}>
          <span style={cap}>Inspected by Kawal itself</span>
          <div style={{ fontFamily: TYPED, fontWeight: 700, fontSize: 88, lineHeight: 1.05, color: "#1c1913", marginTop: 6 }}>{calls}</div>
          <div style={{ fontFamily: TYPED, fontSize: 21, lineHeight: 1.4, color: "#1c1913" }}>
            calls placed to {endpoints} declared endpoints
            <br />
            {answered} answered · {seats} seats live on BSC mainnet
          </div>
          <div
            style={{
              position: "absolute",
              right: 34,
              bottom: 34,
              transform: "rotate(-8deg)",
              border: `5px double ${VIOLET}`,
              borderRadius: 3,
              padding: "8px 22px 6px",
              fontFamily: FORM,
              fontWeight: 800,
              fontSize: 46,
              letterSpacing: 4,
              textTransform: "uppercase",
              color: VIOLET,
              opacity: 0.92,
            }}
          >
            Hireable
          </div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "14px 26px", borderTop: "3px solid #1f1c17" }}>
        <span style={cap}>kawal-three.vercel.app · github.com/PugarHuda/kawal</span>
        <span style={cap}>ERC-8004 · MCP · A2A · Altana session keys · TermiX · PancakeSwap · AltLayer</span>
      </div>
    </div>
  </AbsoluteFill>
);
