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

import { chromium } from "@playwright/test";
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
// Recording time minus every cut that has finished by then: where `t` lands in the clip.
const clipTime = (t: number) => t - cuts.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(t, b) - a), 0);
/** A cue stays up long enough to read: half a second plus fifteen characters a second, on screen. */
const readable = (text: string) => 0.5 + text.length / 15;
async function say(text: string) {
  const last = cues.at(-1);
  if (last) {
    const shown = clipTime(clock()) - clipTime(last.from);
    if (shown < readable(last.text)) await page.waitForTimeout((readable(last.text) - shown) * 1000);
    last.to = clock();
  }
  cues.push({ from: clock(), text });
}

// A drawn cursor: headless recordings show no pointer, and a demo of clicks
// with no visible pointer reads as a slideshow. The ring pulses on press.
await ctx.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(91,46,140,.25);border:2px solid #5b2e8c;z-index:2147483647;pointer-events:none;transition:transform .12s;display:none";
    document.body.append(c);
    addEventListener("mousemove", (e) => { c.style.display = "block"; c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => (c.style.transform = "scale(.6)"), true);
    addEventListener("mouseup", () => (c.style.transform = ""), true);
  });
});

let at = { x: W / 2, y: H / 2 };
async function settle() {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(at.x, at.y); // the cursor element is new on every page
  await page.waitForTimeout(400);
}
async function open(path: string) {
  const from = clock();
  await page.goto(SITE + path, { waitUntil: "networkidle" });
  await settle();
  cuts.push([from, clock()]);
}
/** Glides the pointer to an element, scrolling it into view first. */
async function point(selector: string) {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  const to = { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 };
  await page.mouse.move(to.x, to.y, { steps: 24 });
  at = to;
  await page.waitForTimeout(250);
  return el;
}
async function click(selector: string) {
  await point(selector);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
}
/** A click that leaves the page: the press stays in the clip, the load is cut. */
async function follow(selector: string) {
  const before = page.url();
  await click(selector);
  await page.waitForTimeout(300);
  const from = clock();
  await page.waitForURL((u) => u.href !== before, { timeout: 60_000 });
  await settle();
  cuts.push([from, clock()]);
}
async function type(selector: string, text: string) {
  await click(selector);
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text, { delay: 110 });
}
const hold = (ms: number) => page.waitForTimeout(ms);

// Load before the first cue so the clip opens on a finished page, not a blank tab.
await open("/");
await say("Live on BSC mainnet: kawal-three.vercel.app");
await hold(1800);
await say("Kawal calls every agent itself. Let's find one to hire.");
await point("a:has-text('Browse agents')");
await hold(400);
await follow("a:has-text('Browse agents')");

await say("Search the registry in plain words.");
await type("input[name=q]", "lending");
await hold(300);
await follow("button:has-text('Search')");

await say("Every stamp was pressed after Kawal called the endpoint. Tick two to compare.");
await hold(900);
await click("input[name=ids] >> nth=0");
await hold(400);
await click("input[name=ids] >> nth=1");
await hold(500);
await follow("form[action='/compare'] button[type=submit]");

await say("Side by side: what each agent claims, against what answered when called.");
await hold(2600);
await follow("main a[href^='/agents/56/']");

await say("One agent's inspection sheet. This verdict is a call Kawal just made.");
await hold(2200);
await page.mouse.wheel(0, 700);
await hold(1600);
await say("Hire it under a cap.");
await follow("a:has-text('Hire under a cap')");

await say("Set the capital and how long. Kawal plans the seat: spend cap, allowlist, expiry.");
await type("input[name=capital]", "500");
await hold(250);
await type("input[name=days]", "7");
await hold(300);
await follow("button:has-text('Plan mandate')");
// The reload lands at the top; bring the plan just made back into view.
await page.locator("input[name=capital]").evaluate((e) => e.scrollIntoView({ block: "start" }));
await page.mouse.wheel(0, -60);
await point("text=committed");
await hold(2400);
await say("Granted, each seat becomes an Altana session key on BSC, revocable in one click.");
await hold(2600);
await say("Check before you trust.");
await hold(1800);
await say("");
cues.pop();

await ctx.close();
await browser.close();
const webm = readdirSync(dir).find((f) => f.endsWith(".webm") && f !== "raw.webm")!;
renameSync(dir + webm, dir + "raw.webm");

// Map recording time to clip time: everything before the first cue and every page load is cut.
cuts[0]![0] = 0;
const ts = (s: number) => {
  const ms = Math.round(clipTime(s) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
writeFileSync(dir + "live.srt", cues.map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(c.to!)}\n${c.text}\n`).join("\n"));
writeFileSync(dir + "cuts.txt", cuts.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+"));
console.log(`clip ${clipTime(cues.at(-1)!.to!).toFixed(1)}s, ${cuts.length} cuts`);
