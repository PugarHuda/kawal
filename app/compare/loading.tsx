import { BlankSheet } from "@/components/blank-rows";

/**
 * Form K-4 before its columns are called: a blank manifest, in the same
 * style as the listing's, so the wait looks like the form it is waiting for.
 */
export default function Loading() {
  return <BlankSheet form="Form K-4 · comparison" note="Calling each agent…" />;
}
