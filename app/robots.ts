import type { MetadataRoute } from "next";

/**
 * Crawlers may read every form. The API routes are for agents, not indexes:
 * /api/mcp and /api/a2a answer JSON-RPC, /api/report costs money to call,
 * and the cron endpoint is secret-gated — none of them belong in a search
 * result.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/"] },
    sitemap: "https://kawal-three.vercel.app/sitemap.xml",
  };
}
