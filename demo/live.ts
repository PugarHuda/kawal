/**
 * Records a short live walkthrough of the production site for the Demo Day
 * slide, and writes subtitles timed to what was on screen when.
 *
 * Run: npm run live          -> out/live/raw.webm + out/live/live.srt
 * Then burn the subtitles and drop the page loads (run in out/live):
 *   ffmpeg -i raw.webm -vf "fps=30,select='not($(cat cuts.txt))',setpts=N/30/TB,subtitles=live.srt" -an -c:v libx264 -pix_fmt yuv420p ../kawal-live-demo.mp4
 *
 * A real recording, not stills: the point of this clip is that the site is live.
 */

import { chromium, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SITE = process.env.SITE ?? "https://kawal-three.vercel.app";
const W = 1600, H = 900;
const dir = fileURLToPath(new URL("./out/live/", import.meta.url));
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir, size: { width: W, height: H } } });
const page = await ctx.newPage();
const t0 = Date.now();
const cues: { from: number; to?: number; text: string }[] = [];
// Page loads are cut out of the clip; each cut is [start, end) seconds from t0.
const cuts: [number, number][] = [];
const clock = () => (Date.now() - t0) / 1000;
const say = (text: string) => {
  const now = (Date.now() - t0) / 1000;
  const last = cues.at(-1);
  if (last && last.to === undefined) last.to = now;
  cues.push({ from: now, text });
};

async function open(path: string) {
  const from = clock();
  await page.goto(SITE + path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  cuts.push([from, clock()]);
}
// Eased scroll so the recording reads as someone using the page, not a jump cut.
async function glide(page: Page, to: number | string, ms: number) {
  await page.evaluate(
    ([to, ms]) =>
      new Promise<void>((done) => {
        const target = typeof to === "number" ? to : (document.querySelector(to as string)?.getBoundingClientRect().top ?? 0) + scrollY - 140;
        const from = scrollY, start = performance.now();
        const step = (now: number) => {
          const k = Math.min(1, (now - start) / (ms as number));
          scrollTo(0, from + (target - from) * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2));
          k < 1 ? requestAnimationFrame(step) : done();
        };
        requestAnimationFrame(step);
      }),
    [to, ms] as const,
  );
}
const hold = (ms: number) => page.waitForTimeout(ms);

// Load before the first cue so the clip opens on a finished page, not a blank tab.
await open("/");
say("Live on BSC mainnet: kawal-three.vercel.app");
await hold(2500);
say("Form K-1 reads the ERC-8004 registry on BSC as it stands today.");
await glide(page, 520, 2200);
await hold(1800);

await open("/agents");
say("Form K-2: an agent gets a stamp only after Kawal called its endpoint.");
await hold(1200);
await glide(page, 700, 3000);
await hold(800);

await open("/agents/56/43129");
say("One agent's inspection sheet. The verdict comes from a call Kawal made, not from the registry.");
await hold(4200);
say("Every call is kept. Answered calls are punched; silent ones stay blank.");
await glide(page, ".tally", 1800);
await hold(2600);

await open("/mandate");
say("Form K-5: a hired agent gets a seat with a spend cap, an allowlist and an expiry.");
await hold(1500);
await glide(page, 600, 2500);
say("Each seat was an Altana session key on BSC mainnet, and could be revoked with one click.");
await hold(4200);
say("Check before you trust.");
await hold(2200);
cues.at(-1)!.to = (Date.now() - t0) / 1000;

await ctx.close();
await browser.close();
const webm = readdirSync(dir).find((f) => f.endsWith(".webm") && f !== "raw.webm")!;
renameSync(dir + webm, dir + "raw.webm");

// Map recording time to clip time: everything before the first cue and every page load is cut.
cuts[0]![0] = 0;
const clipTime = (t: number) => t - cuts.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(t, b) - a), 0);
const ts = (s: number) => {
  const ms = Math.round(clipTime(s) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
writeFileSync(dir + "live.srt", cues.map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(c.to!)}\n${c.text}\n`).join("\n"));
writeFileSync(dir + "cuts.txt", cuts.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+"));
console.log(`clip ${clipTime(cues.at(-1)!.to!).toFixed(1)}s, ${cuts.length} cuts`);
