/**
 * Screenshots every scene in scenes.json off the live site and records where
 * the thing the narration points at sits in that frame.
 *
 * Run: npm run capture            (prod)
 *      SITE=http://127.0.0.1:3000 npm run capture
 *
 * Stills, not a screen recording: the cursor and the highlight are drawn by
 * Remotion over the still, so the motion is interpolated rather than jittery.
 */

import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Scene = { id: string; url?: string; target?: string; scope?: string; kind?: string; say: string };
type Box = { x: number; y: number; width: number; height: number };

const SITE = process.env.SITE ?? "https://kawal-three.vercel.app";
const W = 1920, H = 1080;
const scenes: Scene[] = JSON.parse(readFileSync(new URL("./scenes.json", import.meta.url), "utf8"));

mkdirSync(new URL("./public/shots", import.meta.url), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.mouse.move(0, 0);

const boxes: Record<string, Box | null> = {};
let at = "";
for (const s of scenes) {
  if (!s.url) continue;
  if (s.url !== at) {
    await page.goto(SITE + s.url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    at = s.url;
  }
  let box: Box | null = null;
  if (s.target) {
    let el = page.locator(s.target).first();
    if (s.scope) el = el.locator(`xpath=ancestor::${s.scope}[1]`);
    await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(700); // the stamp press is 380ms
    box = await el.boundingBox();
    // A section taller than the frame is ringed where it shows, not off-screen.
    if (box) {
      const x = Math.max(box.x, 16), y = Math.max(box.y, 16);
      box = { x, y, width: Math.min(box.x + box.width, W - 16) - x, height: Math.min(box.y + box.height, H - 16) - y };
    }
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: fileURLToPath(new URL(`./public/shots/${s.id}.png`, import.meta.url)) });
  boxes[s.id] = box;
  console.log(`${s.id.padEnd(10)} ${s.url.padEnd(20)} ${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : "(no target)"}`);
}
await browser.close();
mkdirSync(new URL("./src/gen", import.meta.url), { recursive: true });
writeFileSync(new URL("./src/gen/capture.json", import.meta.url), JSON.stringify({ width: W, height: H, boxes }, null, 1));
