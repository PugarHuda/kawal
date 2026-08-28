import { ImageResponse } from "next/og";
import { getStats, bscStats } from "@/lib/scan";
import { observedTotals } from "@/lib/uptime";

/**
 * The cover sheet as a share card: the same numbers the form prints, on
 * the same paper, so a link pasted into a chat shows the count and the
 * stamp rather than a logo on a gradient.
 *
 * Rendered per request because the count is live; the registry and the
 * probe history are read with the same tolerance as the form itself —
 * absent, the card still prints the sheet.
 */
export const alt = "Kawal — Form K-1, the cover sheet";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Google's CSS endpoint serves a TTF to a UA that cannot take woff2; the
// files are fetched once per instance and shared across renders.
const FONT_CSS =
  "https://fonts.googleapis.com/css2?family=Courier+Prime:wght@700&family=Barlow+Condensed:wght@600&display=swap";

type Font = { name: string; data: ArrayBuffer; weight: 600 | 700; style: "normal" };
let fontsPromise: Promise<Font[]> | null = null;

async function fonts(): Promise<Font[]> {
  fontsPromise ??= (async (): Promise<Font[]> => {
    try {
      const css = await fetch(FONT_CSS, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 6.1)" } }).then((r) =>
        r.text(),
      );
      const faces = [...css.matchAll(/font-family: '([^']+)';[\s\S]*?src: url\(([^)]+)\) format\('truetype'\)/g)]
        .map((m) => ({ name: m[1] ?? "", url: m[2] ?? "" }))
        .filter((f) => f.name && f.url);
      return await Promise.all(
        faces.map(async (f): Promise<Font> => ({
          name: f.name,
          weight: f.name === "Courier Prime" ? 700 : 600,
          style: "normal",
          data: await fetch(f.url).then((r) => r.arrayBuffer()),
        })),
      );
    } catch {
      return [];
    }
  })();
  return fontsPromise;
}

export default async function Image() {
  const [stats, observed, loaded] = await Promise.all([
    getStats()
      .then(bscStats)
      .catch(() => null),
    observedTotals().catch(() => null),
    fonts(),
  ]);
  const registered = stats?.total_agents ?? null;
  const typed = loaded.some((f) => f.name === "Courier Prime") ? "Courier Prime" : "monospace";
  const form = loaded.some((f) => f.name === "Barlow Condensed") ? "Barlow Condensed" : "sans-serif";
  const cap = { fontFamily: form, fontSize: 20, letterSpacing: 2, color: "#66604f" } as const;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#f1eadb", padding: 40 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            background: "#fbf8f0",
            border: "3px solid #1f1c17",
          }}
        >
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
            <span>FORM K-1 · SURAT JALAN AGEN · COVER SHEET</span>
            <span style={{ color: "#b5271f", fontFamily: typed }}>
              {registered !== null ? `No. K1-${registered}` : "No. —"}
            </span>
          </div>
          <div style={{ display: "flex", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", flex: 1.3, padding: "32px 24px" }}>
              <span style={cap}>KETERANGAN · WHAT THIS FORM IS FOR</span>
              <span
                style={{
                  fontFamily: typed,
                  fontSize: 68,
                  fontWeight: 700,
                  lineHeight: 1.05,
                  color: "#1f1c17",
                  marginTop: 16,
                }}
              >
                Most agents on BSC cannot be hired.
              </span>
              <span style={{ fontFamily: typed, fontSize: 24, color: "#4a453b", marginTop: 24, lineHeight: 1.4 }}>
                Kawal calls every agent itself before it lists one, stamps what answered, and lets you hire under
                limits it cannot cross.
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
              <span style={cap}>DIPERIKSA OLEH · INSPECTED BY KAWAL</span>
              <span style={{ fontFamily: typed, fontSize: 96, fontWeight: 700, color: "#1f1c17", marginTop: 8 }}>
                {observed ? observed.checks.toLocaleString("en-US") : "—"}
              </span>
              <span style={{ fontFamily: typed, fontSize: 22, color: "#4a453b" }}>
                {observed
                  ? `calls placed to ${observed.endpoints} declared endpoints`
                  : "no calls recorded on this instance"}
              </span>
              <div
                style={{
                  position: "absolute",
                  right: 28,
                  bottom: 36,
                  display: "flex",
                  padding: "10px 22px",
                  border: "5px double #4a2a7d",
                  color: "#4a2a7d",
                  fontFamily: form,
                  fontSize: 40,
                  letterSpacing: 4,
                  transform: "rotate(-8deg)",
                  opacity: 0.9,
                }}
              >
                TELAH DIPERIKSA
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
            KAWAL · BNB SMART CHAIN · ERC-8004 · MCP AT /API/MCP · A2A AT /.WELL-KNOWN/AGENT-CARD.JSON
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: loaded },
  );
}
