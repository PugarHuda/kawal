/**
 * Fonts for the share cards, shared by the cover sheet's and each agent's.
 *
 * Google's CSS endpoint serves a TTF to a UA that cannot take woff2; the
 * files are fetched once per instance and shared across renders. An empty
 * list on failure: the card falls back to generic faces rather than failing.
 */
const FONT_CSS =
  "https://fonts.googleapis.com/css2?family=Courier+Prime:wght@700&family=Barlow+Condensed:wght@600&display=swap";

export type Font = { name: string; data: ArrayBuffer; weight: 600 | 700; style: "normal" };
let fontsPromise: Promise<Font[]> | null = null;

export async function fonts(): Promise<Font[]> {
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

