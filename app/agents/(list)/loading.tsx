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
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12">
      <p className="label">Reading the registry…</p>
      <div className="mt-10 space-y-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="border-b border-rule pb-6">
            <div className="h-4 w-56 rounded-sm bg-rule" />
            <div className="mt-3 h-3 w-full max-w-xl rounded-sm bg-rule opacity-60" />
            <div className="mt-2 h-3 w-72 rounded-sm bg-rule opacity-40" />
          </div>
        ))}
      </div>
    </div>
  );
}
