/**
 * The blank K-6 while the address is being read.
 *
 * Same idea as the manifest's skeleton: the ruled lines are printed, the
 * entries are not typed yet. Safe to have at route level here, unlike the
 * agent page — an owner lookup has no 404 to protect, so flushing the shell
 * early costs nothing.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-8 pb-4">
      <div className="sheet" aria-busy="true">
        <div className="flex items-baseline justify-between border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-6 · owner sheet</span>
          <span className="cap">Reading the registry…</span>
        </div>
        <div className="px-5 py-6">
          <div className="h-9 w-72 max-w-full bg-rule-faint" />
          <div className="mt-4 h-3 w-full max-w-xl bg-rule-faint opacity-70" />
          <div className="mt-2 h-3 w-80 max-w-full bg-rule-faint opacity-50" />
          <div className="mt-6 h-10 w-full max-w-[26rem] border-[1.5px] border-rule bg-paper-white" />
        </div>
        <div className="border-t-[1.5px] border-rule px-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="manifest-row grid grid-cols-[3rem_minmax(0,1fr)] gap-x-4 py-5 last:border-b-0">
              <span className="h-4 w-6 bg-rule-faint" />
              <div>
                <div className="h-5 w-56 bg-rule-faint" />
                <div className="mt-3 h-3 w-full max-w-xl bg-rule-faint opacity-70" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
