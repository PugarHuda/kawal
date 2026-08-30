import { BlankSheet } from "@/components/blank-rows";

/**
 * Scoped to the listing by the (list) route group on purpose.
 *
 * A loading.tsx directly under app/agents/ also covers the agent detail
 * route, and a route-level loading boundary flushes the response shell with a
 * 200 before the page body runs. A missing agent then rendered the correct
 * 404 page under a 200 status — right for a human, a lie to every crawler and
 * uptime check. The group keeps the skeleton here and lets the detail route
 * answer honestly.
 */
export default function Loading() {
  return <BlankSheet form="Form K-2 · agent manifest" note="Reading the registry…" />;
}
