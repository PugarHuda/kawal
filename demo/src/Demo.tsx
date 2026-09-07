import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { loadFont as loadTyped } from "@remotion/google-fonts/CourierPrime";
import { loadFont as loadForm } from "@remotion/google-fonts/BarlowCondensed";
import scenes from "../scenes.json";
import capture from "./gen/capture.json";
import voice from "./gen/voice.json";
import { Scene, Card } from "./Scene";

loadTyped("normal", { weights: ["400", "700"] });
loadForm("normal", { weights: ["600", "700", "800"] });

export const FPS = 30;
/** Silence after each line, so the picture rests before the next one. */
const REST = 0.7;

type SceneDef = (typeof scenes)[number];
type Box = { x: number; y: number; width: number; height: number };
type Voice = { seconds: number; words: { t: number; d: number; w: string }[] };

const voices = voice as Record<string, Voice>;
const boxes = capture.boxes as Record<string, Box | null>;

const frames = (s: SceneDef) => Math.ceil((voices[s.id].seconds + REST) * FPS);
export const totalFrames = () => scenes.reduce((n, s) => n + frames(s), 0);

export const Demo = () => {
  let from = 0;
  let prev: { x: number; y: number } | null = null;
  return (
    <AbsoluteFill style={{ background: "#f1eadb" }}>
      {scenes.map((s) => {
        const start = from;
        const len = frames(s);
        from += len;
        const box = boxes[s.id] ?? null;
        const cursorFrom = prev;
        if (box) prev = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.6 };
        const kind = "kind" in s ? (s.kind as "intro" | "outro") : null;
        return (
          <Sequence key={s.id} from={start} durationInFrames={len} name={s.id}>
            <Audio src={staticFile(`audio/${s.id}.mp3`)} />
            {kind ? (
              <Card kind={kind} words={voices[s.id].words} />
            ) : (
              <Scene shot={staticFile(`shots/${s.id}.png`)} box={box} cursorFrom={cursorFrom} words={voices[s.id].words} />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
