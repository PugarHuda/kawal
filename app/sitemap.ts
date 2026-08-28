import type { MetadataRoute } from "next";
import { browse } from "@/lib/catalog";
import { CATEGORIES } from "@/lib/taxonomy";

const SITE = "https://kawal-three.vercel.app";

/**
 * The forms, the seats, and the strongest agents on the roster.
 *
 * Agent pages are the ones worth indexing: a search for an agent's name
 * should land on the inspection sheet Kawal filled in about it, not on
 * the registry's raw record. The roster read is the same one the manifest
 * makes; if the registry is down the sitemap still lists the forms rather
 * than failing the whole file.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const forms: MetadataRoute.Sitemap = [
    { url: `${SITE}/`, changeFrequency: "daily", priority: 1 },
    { url: `${SITE}/agents`, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE}/mandate`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE}/advantage`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${SITE}/owner`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${SITE}/compare`, changeFrequency: "monthly", priority: 0.3 },
    ...CATEGORIES.map((c) => ({
      url: `${SITE}/agents?category=${c.id}`,
      changeFrequency: "daily" as const,
      priority: 0.8,
    })),
  ];

  const agents = await browse({ limit: 60 })
    .then((r) =>
      r.listings.map((l) => ({
        url: `${SITE}/agents/${l.agent.chain_id}/${l.agent.token_id}`,
        lastModified: l.agent.updated_at ? new Date(l.agent.updated_at) : undefined,
        changeFrequency: "daily" as const,
        priority: 0.6,
      })),
    )
    .catch(() => []);

  return [...forms, ...agents];
}
