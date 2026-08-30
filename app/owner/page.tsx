import { Suspense } from "react";
import Link from "next/link";
import { listAgents, getAgent, getWalletMetrics, type ScanAgent, type WalletMetrics } from "@/lib/scan";
import { proveAgent, type EndpointProof } from "@/lib/probe";
import { uptimeFor, type Uptime } from "@/lib/uptime";
import { ownerOfAgent } from "@/lib/feedback";
import { diagnose, failureLabel } from "@/lib/failure";
import { mapLimit } from "@/lib/concurrency";
import { BSC_MAINNET } from "@/lib/chains";
import { Stamp, Tally } from "@/components/listing";
import { WalletStrip } from "@/components/wallet";

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
  title: "Is my agent still answering?",
  description:
    "Paste a wallet address and see what Kawal has actually observed about the agents registered to it on BNB Smart Chain.",
};

/** Enough to cover any real owner; the roster's busiest hold a handful. */
const MAX_AGENTS = 24;
/** Other people's servers, so this stays gentle even for a large owner. */
const CONCURRENCY = 6;
/**
 * Shorter than the agent page's patience. One owner can hold two dozen
 * registrations, and a page that waits the full default on each dead host
 * would take longer to arrive than most people wait for anything.
 */
const PROBE_TIMEOUT_MS = 6_000;

function normalise(input: string | undefined): string | null {
  const raw = (input ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
}

function short(hex: string) {
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

export default async function OwnerPage({ searchParams }: PageProps<"/owner">) {
  const params = await searchParams;
  const asked = typeof params.address === "string" ? params.address : "";
  const address = normalise(asked);
  const invalid = asked !== "" && address === null;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-8 pb-4">
      <section className="sheet sheet--carbon">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-6 · owner sheet · for the other side of the listing</span>
          <span className="serial text-[0.85rem]">{address ? `Owner ${address.slice(0, 10)}…` : "No. —"}</span>
        </div>

        <div className="px-5 py-6">
          <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem] max-w-[18ch]">Is your agent still answering?</h1>
          <p className="typed mt-3 max-w-[62ch] text-carbon-2">
            Nothing on BNB Smart Chain tells an owner their endpoint went dark. The registry keeps
            listing it. Kawal has been calling these endpoints and keeping every result, so paste the
            address that minted them and see what it found.
          </p>

          <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
            {/* Full row on a phone so the field is as wide as the sheet and no
                wider; the 26rem width only applies once there is room. */}
            <label className="flex w-full min-w-0 flex-col gap-1.5 sm:w-auto">
              <span className="cap">wallet address</span>
              <input
                id="address"
                name="address"
                defaultValue={asked}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? "address-error" : undefined}
                className="field w-full max-w-full sm:w-[26rem]"
              />
            </label>
            <button type="submit" className="counterfoil">
              Look it up
            </button>
          </form>

          {invalid && (
            <p
              id="address-error"
              role="alert"
              className="typed mt-4 max-w-[60ch] border-[1.5px] border-stamp-red bg-paper-pink px-3 py-2 text-[0.9rem]"
            >
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

        {/* The form flushes first; the registry read and the fan-out of calls
            to other people's servers stream in beneath it. */}
        {address && (
          <Suspense fallback={<Calling />}>
            <Results address={address} />
          </Suspense>
        )}
      </section>
    </div>
  );
}

/** The blank lines under the form while the endpoints are being called. */
function Calling() {
  return (
    <div className="border-t-[1.5px] border-rule px-5 py-5" aria-busy="true">
      <span className="cap">Reading the registry, then calling every endpoint it lists…</span>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="manifest-row grid grid-cols-[3rem_minmax(0,1fr)] gap-x-4 py-4 last:border-b-0">
          <span className="h-4 w-6 bg-rule-faint" />
          <div>
            <div className="h-5 w-56 bg-rule-faint" />
            <div className="mt-3 h-3 w-full max-w-xl bg-rule-faint opacity-70" />
          </div>
        </div>
      ))}
    </div>
  );
}

type OwnedRow = {
  agent: ScanAgent;
  proof: EndpointProof | null;
  uptime: Uptime | null;
  /** The Identity Registry's answer to `ownerOf`, or null when it gave none. */
  onchainOwner: string | null;
};

async function Results({ address }: { address: string }) {
  let agents: ScanAgent[];
  let total: number;
  let wallet: WalletMetrics | null;
  try {
    // The wallet's own ledger rides along with the roster read: what 8004scan
    // has booked against this address on-chain, which is the owner's side of
    // the payment story the agent pages tell. Null when never indexed.
    [{ agents, total }, wallet] = await Promise.all([
      listAgents({ chainId: BSC_MAINNET, ownerAddress: address, limit: MAX_AGENTS }),
      getWalletMetrics(address),
    ]);
  } catch {
    // The same sentence the manifest prints. A registry outage is not this
    // owner's fault and must not read as "no agents".
    return (
      <p className="typed border-t-[1.5px] border-rule bg-paper-pink px-5 py-6 text-carbon-2">
        The 8004scan registry did not respond. Nothing here is cached yet, so the lookup is empty
        until it comes back.
      </p>
    );
  }

  if (agents.length === 0) {
    return (
      <>
        {wallet && <WalletStrip wallet={wallet} />}
        <div className="flex flex-wrap items-start justify-between gap-4 border-t-[1.5px] border-rule px-5 py-6">
        <div>
          <h2 className="heading text-[1.7rem]">No registrations under this address.</h2>
          <p className="typed mt-2 max-w-[60ch] text-[0.9rem] text-carbon-2">
            The registry holds no agents for {short(address)} on BNB Smart Chain. If you minted on
            another chain, Kawal only reads BSC; if you minted from a different key, look that one up
            instead. Nothing was called.
          </p>
        </div>
        <Stamp ink="stamp-grey" size="lg">
          Empty
        </Stamp>
        </div>
      </>
    );
  }

  // The probe is what makes this worth loading. Reading the registry back to
  // an owner would just be showing them what they already filled in. The
  // Identity Registry is asked who owns each token at the same time: 8004scan
  // indexed an owner once, the chain says who holds it now.
  const rows: OwnedRow[] = await mapLimit(agents, CONCURRENCY, async (agent) => {
    const onchain = ownerOfAgent(agent.chain_id, agent.token_id);
    try {
      const detail = await getAgent(agent.chain_id, agent.token_id);
      const proof = await proveAgent(detail, { timeoutMs: PROBE_TIMEOUT_MS });
      const uptime = proof?.endpoint ? await uptimeFor(proof.endpoint) : null;
      return { agent, proof, uptime, onchainOwner: await onchain };
    } catch {
      return { agent, proof: null, uptime: null, onchainOwner: await onchain };
    }
  });

  const broken = rows.filter((r) => r.proof && !r.proof.answered && !r.proof.descriptor);
  const chainAnswered = rows.filter((r) => r.onchainOwner !== null);
  const chainAgrees = chainAnswered.filter((r) => r.onchainOwner!.toLowerCase() === address);

  return (
    <div className="border-t-[1.5px] border-rule">
      {wallet && <WalletStrip wallet={wallet} />}
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
          <p className="typed mt-2 text-[0.85rem] text-carbon-2">
            {chainAnswered.length === 0
              ? "The Identity Registry did not answer ownerOf for any of these, so the owner shown is 8004scan's index alone."
              : chainAgrees.length === chainAnswered.length
                ? `The Identity Registry names this address as the holder of ${chainAgrees.length === 1 ? "the token" : `all ${chainAgrees.length} tokens`} it answered for; 8004scan's index agrees.`
                : `The Identity Registry disagrees with 8004scan on ${chainAnswered.length - chainAgrees.length} of ${chainAnswered.length} tokens — the index is stale or the token moved.`}
          </p>
        </div>
        <Stamp ink={broken.length > 0 ? "stamp-red" : "stamp-violet"} size="lg" evidence={rows.length * 10}>
          {broken.length > 0 ? "Needs repair" : "All answered"}
        </Stamp>
      </div>

      <ol className="border-t-[1.5px] border-rule px-5">
        {rows.map(({ agent, proof, uptime, onchainOwner }, i) => {
          const d = proof?.error ? diagnose(proof.error) : null;
          const answering = proof?.answered === true;
          const descriptor = proof?.descriptor != null;
          const silent = proof !== null && !answering && !descriptor;
          const ink = answering || descriptor ? "stamp-violet" : "stamp-red";
          const verdict = answering
            ? "Answering"
            : descriptor
              ? "Runs locally"
              : d
                ? failureLabel(d.failure)
                : "No endpoint";
          const ownership =
            onchainOwner === null
              ? "chain did not answer ownerOf"
              : onchainOwner.toLowerCase() === address
                ? "Identity Registry agrees: this address holds the token"
                : `Identity Registry names ${short(onchainOwner)} as holder, not this address`;

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
                <p className="typed mt-1 text-[0.8rem] text-carbon-3">
                  No. {agent.token_id} · {ownership}
                </p>
                {d && !descriptor && (
                  <p className="typed mt-2 max-w-[60ch] text-[0.88rem] text-carbon-2">{d.summary}</p>
                )}
                {uptime && uptime.checks > 1 && (
                  <div className="mt-3 flex flex-col gap-2">
                    <Tally answered={uptime.answered} checks={uptime.checks} cap={40} newestAnswered={uptime.lastAnswered} />
                    <p className="typed text-[0.85rem] text-carbon-2">
                      {uptime.answered} of {uptime.checks} call{uptime.checks === 1 ? "" : "s"} answered since{" "}
                      {new Date(uptime.since * 1000).toISOString().slice(0, 10)}
                      {uptime.medianMs !== null && ` · median ${uptime.medianMs} ms`}
                    </p>
                  </div>
                )}
                {/* What to do about it, on the row that needs it. The three
                    links are the three places the fix and the re-check live:
                    the registration as 8004scan indexed it, the standard that
                    says what the endpoint field must hold, and Kawal's own
                    tool that will call it again on request. */}
                {silent && (
                  <p className="stamp-note mt-3 max-w-[64ch]">
                    Next: check the endpoint in{" "}
                    <a
                      href={`https://8004scan.io/agents/${agent.chain_id}/${agent.token_id}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline"
                    >
                      your registration on 8004scan
                    </a>{" "}
                    against{" "}
                    <a href="https://eips.ethereum.org/EIPS/eip-8004" target="_blank" rel="noreferrer noopener" className="underline">
                      the ERC-8004 registration format
                    </a>
                    , fix or re-host it, then ask <code className="font-bold">verify_agent</code> on{" "}
                    <a href="/api/mcp" className="underline">
                      /api/mcp
                    </a>{" "}
                    to call it again — the tally above only moves when someone does.
                  </p>
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
        Measured from a single vantage point, with {PROBE_TIMEOUT_MS / 1000} seconds&rsquo; patience per
        call. An endpoint that geo-blocks or ASN-blocks this prober looks identical to one that is
        down, so a failure here is a reason to check, not a verdict.
      </p>
    </div>
  );
}
