import Link from "next/link";
import { listAgents } from "@/lib/scan";
import { proveAgent } from "@/lib/probe";
import { getAgent } from "@/lib/scan";
import { uptimeFor } from "@/lib/uptime";
import { diagnose, failureLabel } from "@/lib/failure";
import { mapLimit } from "@/lib/concurrency";
import { BSC_MAINNET } from "@/lib/chains";
import { Stamp, Tally } from "@/components/listing";

/**
 * Form K-6: the other half of the market.
 *
 * Everything else here is built for somebody deciding whether to hire. But a
 * registration is minted by someone, and that someone has no way to find out
 * their agent stopped working — 8004scan publishes a cached health check with
 * no history, and nothing on BSC tells an owner their endpoint went dark.
 *
 * Kawal already knows. `syenite.ai` failed to resolve on 62 separate probes
 * from this instance; the registry still lists that agent as declaring an
 * interface, and its owner almost certainly has no idea.
 *
 * Deliberately not a dashboard. No sign-in, no claiming, no settings — an
 * address is public and so is everything shown against it, so asking someone
 * to prove they own it would add a login to a page that reads nothing private.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Is my agent still answering? — Kawal",
  description:
    "Paste a wallet address and see what Kawal has actually observed about the agents registered to it on BNB Smart Chain.",
};

/** Enough to cover any real owner; the roster's busiest hold a handful. */
const MAX_AGENTS = 24;
/** Other people's servers, so this stays gentle even for a large owner. */
const CONCURRENCY = 4;

function normalise(input: string | undefined): string | null {
  const raw = (input ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
}

export default async function OwnerPage({ searchParams }: PageProps<"/owner">) {
  const params = await searchParams;
  const asked = typeof params.address === "string" ? params.address : "";
  const address = normalise(asked);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-8 pb-4">
      <section className="sheet sheet--carbon">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-6 · surat pemilik · for the other side of the listing</span>
          <span className="serial text-[0.85rem]">{address ? `Pemilik ${address.slice(0, 10)}…` : "No. —"}</span>
        </div>

        <div className="px-5 py-6">
          <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem] max-w-[18ch]">Is your agent still answering?</h1>
          <p className="typed mt-3 max-w-[62ch] text-carbon-2">
            Nothing on BNB Smart Chain tells an owner their endpoint went dark. The registry keeps
            listing it. Kawal has been calling these endpoints and keeping every result, so paste the
            address that minted them and see what it found.
          </p>

          <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="cap">Alamat dompet · wallet address</span>
              <input
                id="address"
                name="address"
                defaultValue={asked}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                className="field w-full sm:w-[26rem]"
              />
            </label>
            <button type="submit" className="counterfoil">
              Look it up
            </button>
          </form>

          {asked !== "" && address === null && (
            <p className="typed mt-4 max-w-[60ch] border-[1.5px] border-stamp-red bg-paper-pink px-3 py-2 text-[0.9rem]">
              That is not a wallet address. It should be <code className="font-bold">0x</code> followed by
              forty hexadecimal characters.
            </p>
          )}

          {!address && (
            <p className="stamp-note mt-6 max-w-[62ch]">
              Nothing here is private. An ERC-8004 registration names its owner on-chain, and every
              observation shown is a call Kawal made to an endpoint the registration published — so
              there is nothing to sign in to and nothing to prove.
            </p>
          )}
        </div>

        {address && <Results address={address} />}
      </section>
    </div>
  );
}

async function Results({ address }: { address: string }) {
  const { agents, total } = await listAgents({
    chainId: BSC_MAINNET,
    ownerAddress: address,
    limit: MAX_AGENTS,
  });

  if (agents.length === 0) {
    return (
      <p className="typed border-t-[1.5px] border-rule px-5 py-6 text-carbon-2">
        The registry holds no agents for this address on BNB Smart Chain. If you minted on another
        chain, Kawal only reads BSC.
      </p>
    );
  }

  // The probe is what makes this worth loading. Reading the registry back to
  // an owner would just be showing them what they already filled in.
  const rows = await mapLimit(agents, CONCURRENCY, async (a) => {
    try {
      const detail = await getAgent(a.chain_id, a.token_id);
      const proof = await proveAgent(detail);
      return { agent: a, proof, uptime: proof?.endpoint ? await uptimeFor(proof.endpoint) : null };
    } catch {
      return { agent: a, proof: null, uptime: null };
    }
  });

  const broken = rows.filter((r) => r.proof && !r.proof.answered && !r.proof.descriptor);

  return (
    <div className="border-t-[1.5px] border-rule">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5">
        <div>
          <span className="cap">
            {total} registration{total === 1 ? "" : "s"} on BSC
            {total > agents.length && ` · showing the first ${agents.length}`}
          </span>
          {broken.length > 0 ? (
            <p className="heading mt-2 max-w-[24ch] text-[1.7rem] text-stamp-red">
              {broken.length} of these did not answer when Kawal called.
            </p>
          ) : (
            <p className="heading mt-2 text-[1.7rem]">Everything Kawal could call, answered.</p>
          )}
          {broken.length > 0 && (
            <p className="typed mt-1 text-[0.9rem] text-carbon-2">
              The registry still lists them exactly as you registered them.
            </p>
          )}
        </div>
        <Stamp ink={broken.length > 0 ? "stamp-red" : "stamp-violet"} size="lg" evidence={rows.length * 10}>
          {broken.length > 0 ? "Perlu perbaikan" : "Semua menjawab"}
        </Stamp>
      </div>

      <ol className="border-t-[1.5px] border-rule px-5">
        {rows.map(({ agent, proof, uptime }, i) => {
          const d = proof?.error ? diagnose(proof.error) : null;
          const answering = proof?.answered === true;
          const descriptor = proof?.descriptor != null;
          const ink = answering || descriptor ? "stamp-violet" : "stamp-red";
          const verdict = answering
            ? "Answering"
            : descriptor
              ? "Runs locally"
              : d
                ? failureLabel(d.failure)
                : "No endpoint";

          return (
            <li
              key={`${agent.chain_id}:${agent.token_id}`}
              className="manifest-row grid grid-cols-[3rem_minmax(0,1fr)] gap-x-4 py-4 last:border-b-0 sm:grid-cols-[3rem_minmax(0,1fr)_auto]"
            >
              <span className="serial pt-1 text-[0.85rem]">{String(i + 1).padStart(2, "0")}</span>
              <article className="min-w-0">
                <h2 className="heading text-[1.35rem]">
                  <Link href={`/agents/${agent.chain_id}/${agent.token_id}`} className="no-underline hover:underline">
                    {agent.name}
                  </Link>
                </h2>
                {proof?.endpoint && (
                  <p className="typed mt-1 break-all text-[0.82rem] text-carbon-3">{proof.endpoint}</p>
                )}
                {d && !descriptor && (
                  <p className="typed mt-2 max-w-[60ch] text-[0.88rem] text-carbon-2">{d.summary}</p>
                )}
                {uptime && uptime.checks > 1 && (
                  <div className="mt-3 flex flex-col gap-2">
                    <Tally answered={uptime.answered} checks={uptime.checks} cap={40} />
                    <p className="typed text-[0.85rem] text-carbon-2">
                      {uptime.answered} of {uptime.checks} call{uptime.checks === 1 ? "" : "s"} answered since{" "}
                      {new Date(uptime.since * 1000).toISOString().slice(0, 10)}
                      {uptime.medianMs !== null && ` · median ${uptime.medianMs} ms`}
                    </p>
                  </div>
                )}
              </article>
              <div className="col-start-2 mt-2 sm:col-start-3 sm:mt-0">
                <Stamp ink={ink} size="sm" flat evidence={uptime?.checks ?? null}>
                  {verdict}
                </Stamp>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="stamp-note max-w-none border-t-[1.5px] border-rule px-5 py-4">
        Measured from a single vantage point. An endpoint that geo-blocks or ASN-blocks this prober
        looks identical to one that is down, so a failure here is a reason to check, not a verdict.
      </p>
    </div>
  );
}
