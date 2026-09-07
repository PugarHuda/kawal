import { AbsoluteFill, Easing, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

const VIOLET = "#4a2a7d";
const TYPED = "'Courier Prime', 'Courier New', monospace";
const FORM = "'Barlow Condensed', 'Arial Narrow', sans-serif";

type Box = { x: number; y: number; width: number; height: number };
type Word = { t: number; d: number; w: string };

/** The caption on screen at second `t`: the line of the narration being spoken. */
function captionAt(words: Word[], t: number): string {
  // Lines of at most ~46 characters, cut at word boundaries; a line stays up
  // from its first word's start until the next line's first word.
  const lines: { start: number; text: string }[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) lines.push({ start: cur[0].t, text: cur.map((w) => w.w).join(" ") });
    cur = [];
  };
  for (const w of words) {
    const len = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
    if (len > 46) flush();
    cur.push(w);
  }
  flush();
  let text = "";
  for (const l of lines) if (t + 0.15 >= l.start) text = l.text;
  return text;
}

const Caption = ({ words }: { words: Word[] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const text = captionAt(words, frame / fps);
  if (!text) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 56, display: "flex", justifyContent: "center" }}>
      <div
        style={{
          background: "#fbf8f0",
          border: "2px solid #2a2620",
          borderLeft: "2px dashed #2a2620",
          padding: "12px 26px 14px",
          fontFamily: TYPED,
          fontSize: 34,
          lineHeight: 1.25,
          color: "#1c1913",
          maxWidth: 1500,
          textAlign: "center",
        }}
      >
        {text}
      </div>
    </div>
  );
};

const Cursor = ({ x, y }: { x: number; y: number }) => (
  <svg
    width="44"
    height="52"
    viewBox="0 0 22 26"
    style={{ position: "absolute", left: x - 4, top: y - 3, filter: "drop-shadow(0 1px 1px rgba(0,0,0,.35))" }}
  >
    <path
      d="M2 1.5 L2 20 L7 15.5 L10.5 23.5 L14 22 L10.5 14.5 L17 14.5 Z"
      fill="#fbf8f0"
      stroke="#1c1913"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </svg>
);

/** A still of the page, the cursor gliding to the target, and a ring pressed around it. */
export const Scene = ({
  shot,
  box,
  cursorFrom,
  words,
}: {
  shot: string;
  box: Box | null;
  cursorFrom: { x: number; y: number } | null;
  words: Word[];
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();

  const fade = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  // A slow push-in over the whole scene, toward the target when there is one.
  const zoom = interpolate(frame, [0, durationInFrames], [1, 1.045]);
  const ox = box ? box.x + box.width / 2 : width / 2;
  const oy = box ? box.y + box.height / 2 : height / 2;

  const move = spring({ frame: frame - 8, fps, config: { damping: 26, stiffness: 70, mass: 1.1 } });
  const start = cursorFrom ?? { x: width * 0.55, y: height * 0.9 };
  const end = box ? { x: box.x + box.width * 0.62, y: box.y + box.height * 0.6 } : start;
  const cx = interpolate(move, [0, 1], [start.x, end.x]);
  const cy = interpolate(move, [0, 1], [start.y, end.y]);

  // The ring is pressed once the cursor arrives: a quick scale-in like the stamp.
  const press = spring({ frame: frame - 30, fps, config: { damping: 14, stiffness: 160 } });
  const pad = 10;

  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <div style={{ position: "absolute", inset: 0, transform: `scale(${zoom})`, transformOrigin: `${ox}px ${oy}px` }}>
        <Img src={shot} style={{ width, height, display: "block" }} />
        {box && (
          <div
            style={{
              position: "absolute",
              left: box.x - pad,
              top: box.y - pad,
              width: box.width + pad * 2,
              height: box.height + pad * 2,
              border: `4px double ${VIOLET}`,
              borderRadius: 3,
              transform: `scale(${interpolate(press, [0, 1], [1.18, 1])})`,
              opacity: press,
              boxShadow: `0 0 0 9999px rgba(28,25,19,${interpolate(press, [0, 1], [0, 0.16])})`,
            }}
          />
        )}
        {box && <Cursor x={cx} y={cy} />}
      </div>
      <Caption words={words} />
    </AbsoluteFill>
  );
};

/** The cover and the last frame: the mark, the name, and the line under it. */
export const Card = ({ kind, words }: { kind: "intro" | "outro"; words: Word[] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const press = spring({ frame: frame - 6, fps, config: { damping: 13, stiffness: 150 } });
  const scale = interpolate(press, [0, 1], [1.5, 1]);
  const typed = interpolate(frame, [20, 60], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.quad) });
  const line = kind === "intro" ? "Agents you can hire, limits they can't cross." : "kawal-three.vercel.app · github.com/PugarHuda/kawal";
  const shown = line.slice(0, Math.round(typed * line.length));
  const foot =
    kind === "intro"
      ? "Form K-1 · an agent marketplace for BNB Smart Chain"
      : "Built for Build the Era · BNB Chain · ERC-8004 · Altana · TermiX · PancakeSwap · AltLayer";
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", background: "#f1eadb" }}>
      <div
        style={{
          background: "#fbf8f0",
          border: "3px solid #2a2620",
          padding: "70px 110px 64px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 26,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
          <svg viewBox="0 0 64 64" width="150" height="150" style={{ transform: `scale(${scale})`, opacity: press }}>
            <g transform="rotate(-8 32 32)" fill="none" stroke={VIOLET}>
              <rect x="5.5" y="5.5" width="53" height="53" rx="3" strokeWidth="3.5" />
              <rect x="12" y="12" width="40" height="40" rx="1.5" strokeWidth="1.8" />
              <path d="M24 19v26M24 34l15-15M28.5 29.5L40 45" strokeWidth="6" strokeLinecap="square" />
            </g>
          </svg>
          <div style={{ fontFamily: FORM, fontWeight: 700, fontSize: 150, lineHeight: 1, letterSpacing: -2, color: "#1c1913" }}>
            Kawal
          </div>
        </div>
        <div style={{ fontFamily: TYPED, fontSize: 40, color: "#1c1913", minHeight: 50 }}>
          {shown}
          <span style={{ opacity: frame % 20 < 10 ? 1 : 0 }}>▍</span>
        </div>
        <div style={{ fontFamily: FORM, fontWeight: 600, fontSize: 22, letterSpacing: 2.5, textTransform: "uppercase", color: "#66604f" }}>
          {foot}
        </div>
      </div>
      <Caption words={words} />
    </AbsoluteFill>
  );
};
