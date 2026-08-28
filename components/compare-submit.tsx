"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The counterfoil that posts ticked rows to Form K-4.
 *
 * Disabled until two boxes are ticked, and says so, rather than vanishing:
 * an affordance that appears only once you have done the right thing cannot
 * teach you what the right thing was. The count is read off the enclosing
 * form on every change, so this needs no state of its own beyond a number.
 *
 * Server-rendered disabled (nothing is ticked before the page arrives) and
 * only enabled by script; a submit with fewer than two ids lands on K-4's
 * empty state, which explains itself, so nothing is lost without hydration.
 */
export function CompareSubmit({ max }: { max: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [ticked, setTicked] = useState(0);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    // Hidden ids are the ones the form arrived with; they count as ticked.
    const count = () =>
      setTicked(
        form.querySelectorAll<HTMLInputElement>('input[name="ids"]:checked, input[name="ids"][type="hidden"]').length,
      );
    count();
    form.addEventListener("change", count);
    return () => form.removeEventListener("change", count);
  }, []);

  const enough = ticked >= 2;
  return (
    <button type="submit" className="counterfoil counterfoil--quiet" disabled={!enough}>
      {enough
        ? `Compare the ${Math.min(ticked, max)} ticked${ticked > max ? ` (first ${max})` : ""} →`
        : ticked === 1
          ? "tick one more to compare"
          : "select two agents to compare"}
    </button>
  );
}
