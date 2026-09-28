import { NextResponse } from "next/server";
import { LEDGER_ADDRESS, LEDGER_CHAIN, dayLabel, parseDay, probeLeaf, summariseDay, isDeployed } from "@/lib/anchor";
import { readAnchor, rowsOf } from "@/lib/anchor.run";

/**
 * One UTC day of Kawal's probe history, with everything needed to check it.
 *
 * `/api/anchor/2026-09-27` returns the day's rows, the root Kawal rebuilds from
 * them now, and the root KawalLedger holds for that day. If the rows had been
 * edited since they were anchored, the two roots disagree, and nobody has to
 * take this endpoint's word for which one is on-chain: `anchors(day)` on the
 * contract answers the same question. `?endpoint=` narrows to one endpoint and
 * adds, for each of its probes, the Merkle proof the contract's `verify` takes.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ day: string }> }) {
  const { day: label } = await params;
  const day = parseDay(label);
  if (day === null) return NextResponse.json({ error: "day must be YYYY-MM-DD (UTC)" }, { status: 400 });
  const endpoint = new URL(request.url).searchParams.get("endpoint") ?? undefined;

  const [rows, onChain] = await Promise.all([rowsOf(day), readAnchor(day).catch(() => undefined)]);
  if (rows === null) return NextResponse.json({ error: "the probe store could not be read" }, { status: 503 });

  const summary = rows.length ? summariseDay(rows) : null;
  const shown = endpoint ? rows.filter((r) => r.endpoint === endpoint) : rows;

  return NextResponse.json(
    {
      day: dayLabel(day),
      dayNumber: day,
      contract: isDeployed() ? { chainId: LEDGER_CHAIN, address: LEDGER_ADDRESS } : null,
      encoding: {
        leaf: "keccak256(bytes.concat(keccak256(abi.encode(string endpoint, uint64 checkedAt, bool answered, uint32 latencyMs, string protocol))))",
        tree: "sorted-pair keccak256 over the sorted, de-duplicated leaves; an odd node is carried up unchanged",
      },
      rebuilt: summary
        ? { root: summary.tree.root, probes: summary.probes, endpoints: summary.endpoints, answered: summary.answered }
        : null,
      // undefined: the chain could not be read; null: read, and nothing anchored for this day.
      anchored: onChain === undefined ? "unreadable" : onChain,
      matches: onChain && summary ? onChain.root.toLowerCase() === summary.tree.root.toLowerCase() : null,
      rows: shown.map((r) => {
        const leaf = probeLeaf(r);
        return endpoint && summary ? { ...r, leaf, proof: summary.tree.proof(leaf) } : r;
      }),
    },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}
