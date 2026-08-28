/**
 * Scoped to the listing by the (list) route group on purpose.
 *
 * A loading.tsx directly under app/agents/ also covers the agent detail
 * route, and a route-level loading boundary flushes the response shell with a
 * 200 before the page body runs. A missing agent then rendered the correct
 * 404 page under a 200 status — right for a human, a lie to every crawler and
 * uptime check. The group keeps the skeleton here and lets the detail route
 * answer honestly.
 *
 * The skeleton is a blank manifest: the ruled lines are printed, the entries
 * are not typed yet.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-8 pb-4">
      <div className="sheet" aria-busy="true">
        <div className="flex items-baseline justify-between border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-2 · manifes agen</span>
          <span className="cap">Reading the registry…</span>
        </div>
        <div className="px-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="manifest-row grid grid-cols-[6px_minmax(0,1fr)] gap-x-4 py-5">
              <span className="self-stretch bg-rule-faint" />
              <div>
                <div className="h-5 w-56 bg-rule-faint" />
                <div className="mt-3 h-3 w-full max-w-xl bg-rule-faint opacity-70" />
                <div className="mt-2 h-3 w-72 bg-rule-faint opacity-50" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
