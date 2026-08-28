import Link from "next/link";
import { listAgents } from "@/lib/scan";
import { proveAgent } from "@/lib/probe";
import { getAgent } from "@/lib/scan";
import { uptimeFor } from "@/lib/uptime";
import { diagnose, failureLabel } from "@/lib/failure";
import { mapLimit } from "@/lib/concurrency";
import { BSC_MAINNET } from "@/lib/chains";

/**
 * The other half of the market.
 *
 * Everything else here is built for somebody deciding whether to hire. But a
 * registration is minted by someone, and that someone has no way to find out
 * their agent stopped working — 8004scan publishes a cached health check with
 * no history, and nothing on BSC tells an owner their endpoint went dark.
 *
 * Kawal already knows. `syenite.ai` failed to resolve on 62 separate probes
 * from this instance; the registry still lists that agent as declaring an
 * interface, and its owner almost certainly has no idea. That is a whole
 * audience the product was ignoring while sitting on the answer.
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
    <div className="mx-auto w-full max-w-4xl px-6 py-12">
      <p className="label">For the other side of the listing</p>
      <h1 className="mt-4 max-w-2xl text-4xl font-bold leading-[1.08] tracking-[-0.03em]">
        Is your agent still answering?
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-2">
        Nothing on BNB Smart Chain tells an owner their endpoint went dark. The
        registry keeps listing it. Kawal has been calling these endpoints and
        keeping every result, so paste the address that minted them and see what
        it found.
      </p>

      <form method="get" className="mt-8 flex flex-wrap gap-3">
        <label htmlFor="address" className="sr-only">
          Wallet address
        </label>
        <input
          id="address"
          name="address"
          defaultValue={asked}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          className="tnum w-full max-w-md rounded-sm border border-rule-2 bg-surface px-4 py-2.5 text-sm focus-visible:border-brass sm:w-auto"
        />
        <button
          type="submit"
          className="rounded-sm bg-ink px-5 py-2.5 text-sm font-medium text-ground hover:opacity-90"
        >
          Look it up
        </button>
      </form>

      {asked !== "" && address === null && (
        <p className="mt-6 max-w-2xl text-ink-2">
          That is not a wallet address. It should be <code className="text-sm">0x</code> followed by
          forty hexadecimal characters.
        </p>
      )}

      {address && <Results address={address} />}

      {!address && (
        <p className="mt-10 max-w-2xl text-sm text-ink-3">
          Nothing here is private. An ERC-8004 registration names its owner
          on-chain, and every observation shown is a call Kawal made to an
          endpoint the registration published — so there is nothing to sign in
          to and nothing to prove.
        </p>
      )}
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
      <section className="mt-10 border-t border-rule pt-8">
        <p className="text-ink-2">
          The registry holds no agents for this address on BNB Smart Chain. If you
          minted on another chain, Kawal only reads BSC.
        </p>
      </section>
    );
  }

  // The probe is what makes this worth loading. Reading the registry back to
  // an owner would just be showing them what they already filled in.
  const rows = await mapLimit(agents, CONCURRENCY, async (a) => {
    try {
      const detail = await getAgent(a.chain_id, a.token_id);
      const proof = await proveAgent(detail);
      return {
        agent: a,
        proof,
        uptime: proof?.endpoint ? await uptimeFor(proof.endpoint) : null,
      };
    } catch {
      return { agent: a, proof: null, uptime: null };
    }
  });

  const broken = rows.filter((r) => r.proof && !r.proof.answered && !r.proof.descriptor);

  return (
    <section className="mt-10 border-t border-rule pt-8">
      <p className="label">
        {total} registration{total === 1 ? "" : "s"} on BSC
        {total > agents.length && ` · showing the first ${agents.length}`}
      </p>

      {broken.length > 0 ? (
        <p className="mt-4 max-w-2xl text-lg leading-relaxed">
          <span className="font-semibold" style={{ color: "var(--seat-health)" }}>
            {broken.length} of these did not answer when Kawal called.
          </span>{" "}
          <span className="text-ink-2">
            The registry still lists them exactly as you registered them.
          </span>
        </p>
      ) : (
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-2">
          Everything Kawal could call, answered.
        </p>
      )}

      <div className="mt-8 grid gap-px bg-rule">
        {rows.map(({ agent, proof, uptime }) => {
          const d = proof?.error ? diagnose(proof.error) : null;
          const answering = proof?.answered === true;
          const descriptor = proof?.descriptor != null;

          return (
            <article key={`${agent.chain_id}:${agent.token_id}`} className="bg-surface p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <Link
                  href={`/agents/${agent.chain_id}/${agent.token_id}`}
                  className="font-semibold tracking-tight hover:text-brass"
                >
                  {agent.name}
                </Link>
                <span
                  className="label"
                  style={{
                    color: answering || descriptor ? "var(--seat-yield)" : "var(--seat-health)",
                  }}
                >
                  {answering
                    ? "Answering"
                    : descriptor
                      ? "Runs locally"
                      : d
                        ? failureLabel(d.failure)
                        : "No endpoint"}
                </span>
              </div>

              {proof?.endpoint && (
                <p className="tnum mt-2 break-all text-sm text-ink-3">{proof.endpoint}</p>
              )}

              {d && !descriptor && (
                <p className="mt-3 max-w-2xl text-sm text-ink-2">{d.summary}</p>
              )}

              {uptime && uptime.checks > 1 && (
                <p className="mt-3 text-sm text-ink-3">
                  <span className="tnum">
                    {uptime.answered} of {uptime.checks}
                  </span>{" "}
                  call{uptime.checks === 1 ? "" : "s"} answered since{" "}
                  {new Date(uptime.since * 1000).toISOString().slice(0, 10)}
                  {uptime.medianMs !== null && ` · median ${uptime.medianMs} ms`}
                </p>
              )}
            </article>
          );
        })}
      </div>

      <p className="mt-6 max-w-2xl text-sm text-ink-3">
        Measured from a single vantage point. An endpoint that geo-blocks or
        ASN-blocks this prober looks identical to one that is down, so a failure
        here is a reason to check, not a verdict.
      </p>
    </section>
  );
}
