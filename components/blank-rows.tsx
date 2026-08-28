/**
 * A blank manifest: the ruled lines are printed, the entries are not typed
 * yet. The skeleton every streamed or loading listing surface shows.
 */
export function BlankRows({ count = 6 }: { count?: number }) {
  return (
    <div className="px-5" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
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
  );
}

/** A whole sheet of blank rows, captioned as the form it stands in for. */
export function BlankSheet({ form, note }: { form: string; note: string }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-8 pb-4">
      <div className="sheet">
        <div className="flex items-baseline justify-between border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">{form}</span>
          <span className="cap">{note}</span>
        </div>
        <BlankRows />
      </div>
    </div>
  );
}
