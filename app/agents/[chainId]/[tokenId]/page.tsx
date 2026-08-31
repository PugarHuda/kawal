import { Fragment, Suspense } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  getAgent,
  getQuality,
  getScoreHistory,
  getScoreV5,
  type ScanAgentDetail,
  type AgentQuality,
  type ServiceHealth,
  type RiskFlag,
  type ScoreHistory,
  type ScoreV5,
} from "@/lib/scan";
import { registeredOn } from "@/lib/unindexed";
import { proveAgent, type EndpointProof, type ProbedTool } from "@/lib/probe";
import { uptimeFor, observedFor, type Uptime } from "@/lib/uptime";
import { checkX402Cached, networkName, type X402Check } from "@/lib/x402";
import { getReputationCached, CAPTURED_SHARE, type Reputation } from "@/lib/reputation";
import { diagnose, failureLabel } from "@/lib/failure";
import { rpcOutcomeLabel } from "@/lib/a2a";
import { classify, type Classification } from "@/lib/taxonomy";
import { assess, tierLabel, v5Rows, type Assessment, type Tier } from "@/lib/signals";
import { categoryLabel, seatColor, Stamp, Tally, Legend, tierInk } from "@/components/listing";
import { AgentWalletRows } from "@/components/wallet";

/*
 * Form K-3: the inspection sheet for one agent.
 *
 * Every section is a block of the same form. The registry's entries are
 * typed into cells and labelled as the registry's; Kawal's own findings are
 * stamped, with the count behind each stamp printed in it and its blind spot
 * printed under it.
 *
 * The registry's entries arrive with the sheet. Kawal's own findings — the
 * call, the payment question, the feedback read — each sit in their own
 * Suspense boundary and stream in as they finish, so the name and the
 * description are on screen while a slow endpoint is still being called.
 */

/**
 * Resolves the agent before anything streams.
 *
 * There is a `loading.tsx` above this route, so Next flushes the shell with a
 * 200 the moment the navigation starts. By the time the page component runs
 * and calls `notFound()`, the status line is already on the wire: a missing
 * agent rendered the right 404 page under a 200, which is a lie to every
 * crawler and uptime check that reads it.
 *
 * Metadata is generated before the stream opens, so the same lookup here
 * fails the request honestly. The fetch is shared with the page body through
 * the 5-minute cache, so this costs no extra upstream call. The Suspense
 * boundaries below do not change this: they open inside the page's own
 * output, after `notFound()` has had its chance.
 */
export async function generateMetadata({ params }: PageProps<"/agents/[chainId]/[tokenId]">) {
  const { chainId, tokenId } = await params;
  const agent = await getAgent(Number(chainId), tokenId).catch(() => null);
  if (!agent) notFound();

  return {
    title: agent.name,
    description:
      agent.description?.trim().slice(0, 160) ||
      `ERC-8004 agent ${agent.agent_id} on BNB Smart Chain.`,
  };
}

/** The registry's slower readings, one call each, awaited where they are drawn. */
type RegistryReadings = {
  quality: Promise<AgentQuality | null>;
  history: Promise<ScoreHistory | null>;
  v5: Promise<ScoreV5 | null>;
};

/** The promises the streamed sections share. Each upstream is called once. */
type Findings = {
  proof: Promise<EndpointProof | null>;
  uptime: Promise<Uptime | null>;
  payment: Promise<X402Check | null>;
  reputation: Promise<Reputation | null>;
};

export default async function AgentPage({ params }: PageProps<"/agents/[chainId]/[tokenId]">) {
  const { chainId, tokenId } = await params;

  const agent = await getAgent(Number(chainId), tokenId).catch(() => null);
  if (!agent) notFound();

  // The registry's other readings — the health check, the score's history,
  // its v5 breakdown — are started here and awaited under their own
  // boundary. The name and the description are what a visitor came for,
  // and they were waiting on three more registry calls before the largest
  // paint could happen; measured at 5.4 s on a phone before this split.
  const registry: RegistryReadings = {
    quality: getQuality(Number(chainId), tokenId),
    history: getScoreHistory(Number(chainId), tokenId),
    v5: getScoreV5(Number(chainId), tokenId),
  };

  // The nonce the proxy minted for this request, so the JSON-LD block below
  // passes the same policy as every other script on the page.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  // Knock on the door ourselves. 8004scan's report is a reading from some
  // earlier moment; this one is from now, from here, and it is the only check
  // that catches a registration whose MCP endpoint is an image file. Started
  // here and awaited inside the boundaries, so the header does not wait on
  // it; every consumer reads the same promise, so it is one call.
  const proof = proveAgent(agent).catch(() => null);
  const findings: Findings = {
    proof,
    uptime: proof.then((p) => (p ? uptimeFor(p.endpoint) : null)).catch(() => null),
    // Only asked of agents that claim to charge, and only here — the listing
    // shows many agents and must not make a second round of requests to other
    // people's servers to decorate rows nobody has chosen yet.
    payment: proof
      .then((p) => (agent.x402_supported === true && p?.endpoint ? checkX402Cached(p.endpoint) : null))
      .catch(() => null),
    // Read here rather than on the listing: this is one request per agent, and
    // decorating fifty rows nobody has chosen yet would be fifty of them.
    reputation: getReputationCached(Number(chainId), tokenId, agent).catch(() => null),
  };

  const classification = classify(agent.name, agent.description);
  const seat = seatColor(classification.category);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-8 pb-4">
      <p>
        <Link href="/agents" className="counterfoil counterfoil--quiet">
          ← All agents
        </Link>
      </p>

      <article className="sheet sheet--carbon mt-4">
        {/* Serial strip */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-3 · inspection sheet</span>
          <span className="serial text-[0.85rem]">No. {agent.chain_id}:{agent.token_id}</span>
          <Suspense fallback={<span className="cap">Inspected · …</span>}>
            <CheckedAt proof={findings.proof} />
          </Suspense>
        </div>

        {/* The index had never heard of this token, so everything below was
            read off the chain. Said before the entry rather than after it:
            somebody reading a thin sheet needs to know why it is thin. */}
        {agent.indexed === false && (
          <p className="typed border-b-[1.5px] border-rule bg-paper-pink px-5 py-4 text-[0.9rem] text-carbon-2">
            <span className="cap">Not in the index</span>
            <br />
            8004scan has no entry for {agent.chain_id}:{agent.token_id}. The Identity Registry at{" "}
            <span className="serial">{agent.contract_address}</span> does: it names the owner below and points at
            the registration document this sheet was built from. No score, no feedback count and no rank is
            printed, because those are the index&rsquo;s numbers and the index does not have this agent. The
            endpoint is still called, and that part is Kawal&rsquo;s own measurement either way.
          </p>
        )}

        {/* ------------------------------------------------- the entry --- */}
        <header className="grid grid-cols-[minmax(0,1fr)] gap-x-5 border-b-[1.5px] px-5 py-6 sm:grid-cols-[minmax(0,1fr)_auto]" style={{ borderColor: seat }}>
          <div className="min-w-0">
            <span className="cap" style={{ color: seat }}>
              {categoryLabel(classification.category)} · {Math.round(classification.confidence * 100)}% confidence
            </span>
            <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem] mt-2">{agent.name}</h1>
            <p className="typed mt-3 max-w-[64ch] text-carbon-2">
              {agent.description?.trim() || "No description registered."}
            </p>
          </div>
          <div className="col-start-1 mt-4 sm:col-start-2 sm:mt-1 sm:pl-4">
            {/* No stamp until the call comes back: a verdict pressed before
                the evidence is the thing this form exists not to do. */}
            <Suspense fallback={<span className="cap">Calling the endpoint…</span>}>
              <HeaderStamp agent={agent} findings={findings} />
            </Suspense>
          </div>
        </header>

        <Suspense fallback={<Pending>Weighing the registration against the call…</Pending>}>
          <HireSection agent={agent} classification={classification} findings={findings} nonce={nonce} />
        </Suspense>

        <Suspense fallback={<Pending>Calling the endpoint…</Pending>}>
          <ProbeSection findings={findings} quality={registry.quality} />
        </Suspense>

        <Suspense fallback={null}>
          <PaymentSection findings={findings} />
        </Suspense>

        <Suspense fallback={null}>
          <TrackRecordSection findings={findings} />
        </Suspense>

        <Suspense fallback={null}>
          <RegistrySections registry={registry} />
        </Suspense>

        <section className="px-5 py-6">
          <h2 className="cap">Registration · the registry&rsquo;s entries</h2>
          <dl className="cells mt-3 sm:grid-cols-2">
            <Row label="Identity">{agent.agent_id}</Row>
            <Row label="Owner">{agent.owner_ens ?? agent.owner_address}</Row>
            <Row label="Agent wallet">{agent.agent_wallet ?? "not published"}</Row>
            {/* Which wallet the chain says it is, and what that wallet has
                actually been paid by 8004scan's on-chain accounting — the
                first payment evidence on this sheet that is not a claim the
                registration made. */}
            <Suspense fallback={null}>
              <AgentWalletRows chainId={agent.chain_id} tokenId={agent.token_id} indexed={agent.agent_wallet} />
            </Suspense>
            <Row label="Registered">{registeredOn(agent.created_at)}</Row>
            <Row label="Protocols">{agent.supported_protocols.join(", ").toUpperCase() || "none declared"}</Row>
            <Row label="Reputation">
              {agent.indexed === false
                ? "not scored — the index has no entry to score"
                : `score ${agent.total_score.toFixed(2)} · ${agent.total_feedbacks} feedbacks · ${agent.star_count} stars`}
            </Row>
          </dl>
          {classification.matched.length > 0 && (
            <p className="cap mt-4">Classified from: {classification.matched.join(", ")}</p>
          )}
        </section>
      </article>

      <div className="mt-6">
        <Legend
          items={[
            { mark: <Stamp ink="stamp-violet" size="sm" flat>Hireable</Stamp>, means: "Kawal's own mark; the ink prints darker with more probes behind it" },
            { mark: <Stamp ink="stamp-red" size="sm" flat>Does not answer</Stamp>, means: "called at least three times, never answered" },
            { mark: <Stamp ink="stamp-grey" size="sm" flat>Registered only</Stamp>, means: "declares nothing Kawal can call" },
            { mark: <span aria-hidden className="tally"><i className="on" /><i /><i className="new" /></span>, means: "tally strip: punched = answered, blank = silent, outlined = newest" },
          ]}
        />
      </div>
    </div>
  );
}

/**
 * The registry's four slower blocks, drawn once all three readings are in.
 *
 * One boundary rather than three: the sections sit in a fixed order on the
 * sheet, and three boundaries resolving in whatever order the registry
 * answers would have them appear out of sequence under a reader.
 */
async function RegistrySections({ registry }: { registry: RegistryReadings }) {
  const [quality, history, v5] = await Promise.all([registry.quality, registry.history, registry.v5]);
  return (
    <>
      {quality?.endpoint_health && (
          <section className="border-b-[1.5px] border-rule px-5 py-6">
            <h2 className="cap">Is it answering right now · 8004scan&rsquo;s reading</h2>
            <p className="typed mt-2 text-[1.6rem] font-bold capitalize leading-tight">
              {quality.endpoint_health.overall_status}
              {quality.endpoint_health.checked_at && (
                <span className="ml-3 text-[0.85rem] font-normal text-carbon-3">
                  checked {new Date(quality.endpoint_health.checked_at).toISOString().replace("T", " ").slice(0, 16)}
                </span>
              )}
            </p>
            <div className="cells mt-4 sm:grid-cols-2">
              {quality.endpoint_health.services
                .filter((s) => s.status !== "skipped")
                .map((s) => (
                  <ServiceCell key={s.key} service={s} />
                ))}
            </div>
          </section>
        )}

        {quality && quality.risk_flags.length > 0 && (
          <section className="border-b-[1.5px] border-rule px-5 py-6">
            <h2 className="cap">What to weigh against it</h2>
            <ul className="mt-3 divide-y divide-rule-soft">
              {quality.risk_flags.map((f) => (
                <RiskRow key={f.id} flag={f} />
              ))}
            </ul>
          </section>
        )}

        {history && <Trajectory history={history} />}

        {/* The v5 breakdown where the registry has one; the Quality
            Center's older dimensions otherwise. Never both: they are two
            readings of the same number. */}
        {v5Rows(v5).length > 0 ? (
          <ScoreV5Block v5={v5!} />
        ) : (
          quality && quality.score.dimensions.length > 0 && <ScoreBreakdown score={quality.score} />
        )}
    </>
  );
}

/** A section's ruled space while its finding is still on the way. */
function Pending({ children }: { children: React.ReactNode }) {
  return (
    <section className="border-b-[1.5px] border-rule px-5 py-6" aria-busy="true">
      <span className="cap">{children}</span>
    </section>
  );
}

/** The date in the serial strip: when Kawal called, not when the page was built. */
async function CheckedAt({ proof }: { proof: Promise<EndpointProof | null> }) {
  const p = await proof;
  return (
    <span className="cap">
      {p ? `Inspected · ${p.checkedAt.slice(0, 10)}` : "Not inspected"}
    </span>
  );
}

/**
 * The registry's claim, reconciled with what Kawal has actually seen.
 *
 * An endpoint called repeatedly and never reached is not hireable, whatever
 * the registration says — but an agent that published a stdio route or a
 * repository answered us, so it is not the silent case either. Both the
 * header stamp and the hire section need this, and both read the same
 * promises, so the second call costs nothing upstream.
 */
async function assessFrom(agent: ScanAgentDetail, findings: Findings): Promise<Assessment> {
  const [proof, payment, reputation] = await Promise.all([findings.proof, findings.payment, findings.reputation]);
  const observed = await observedFor(proof?.endpoint);
  return assess(
    agent,
    undefined,
    observed && { ...observed, reachedAnotherWay: proof?.descriptor != null },
    payment ? { demanded: payment.demanded } : undefined,
    reputation,
  );
}

async function HeaderStamp({ agent, findings }: { agent: ScanAgentDetail; findings: Findings }) {
  const [assessment, uptime] = await Promise.all([assessFrom(agent, findings), findings.uptime]);
  return (
    <Stamp ink={tierInk(assessment.tier)} evidence={uptime?.checks ?? null} size="lg">
      {tierLabel(assessment.tier)}
    </Stamp>
  );
}

/**
 * The verdict, and where the journey goes from it.
 *
 * A form that ends in a verdict and no stub is a dead end. The hire stub
 * opens the mandate with this seat first and this agent typed into it; it is
 * only offered when the tier earned it. The compare stub is always there,
 * because the next honest question after "can I hire it" is "against what".
 */
async function HireSection({
  agent,
  classification,
  findings,
  nonce,
}: {
  agent: ScanAgentDetail;
  classification: Classification;
  findings: Findings;
  nonce: string | undefined;
}) {
  const [assessment, payment] = await Promise.all([assessFrom(agent, findings), findings.payment]);
  const ref = `${agent.chain_id}:${agent.token_id}`;
  const hireable = assessment.tier === "hireable";
  const hireHref = `/mandate?${classification.category ? `seat=${classification.category}&` : ""}agent=${ref}`;

  // What a machine reader gets: the registration as a SoftwareApplication
  // and the hire as an Offer, with the price only where the server quoted
  // one. The tier decides availability, so a stamp Kawal pressed is what the
  // structured data says too.
  const quote = payment?.demanded ? payment.accepts[0] : undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: agent.name,
    description: agent.description?.trim() || undefined,
    applicationCategory: categoryLabel(classification.category),
    identifier: agent.agent_id,
    operatingSystem: "BNB Smart Chain",
    offers: {
      "@type": "Offer",
      availability: hireable ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: hireHref,
      ...(quote ? { price: quote.amount, priceCurrency: quote.asset } : {}),
    },
  };

  return (
    <section className="border-b-[1.5px] border-rule px-5 py-6">
      {/* The name and description are a stranger's text. JSON.stringify
          escapes quotes but not `</script>`, so `<` is written as its escape
          and the block cannot be closed early by a registration. */}
      <script
        type="application/ld+json"
        nonce={nonce}
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <h2 className="cap">Can you hire it</h2>
      <p className="typed mt-2 text-[1.6rem] font-bold leading-tight">{tierLabel(assessment.tier)}</p>
      <dl className="cells mt-4 sm:grid-cols-2 lg:grid-cols-3">
        {assessment.signals.map((s) => (
          <div key={s.key} className="cell">
            <dt className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-[9px] w-[9px] border border-rule"
                style={{ background: s.pass ? "var(--carbon)" : "transparent" }}
              />
              <span className="cap !mb-0">{s.label}</span>
            </dt>
            <dd className="typed mt-1.5 text-[0.88rem] text-carbon-2">{s.detail}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-5 flex flex-wrap items-center gap-3">
        {hireable && (
          <Link href={hireHref} className="counterfoil">
            Hire under a cap →
          </Link>
        )}
        <Link href={`/compare?ids=${ref}`} className="counterfoil counterfoil--quiet">
          Compare with another
        </Link>
        {!hireable && (
          <span className="stamp-note max-w-[40ch]">
            No hire stub: a seat is only offered to an agent that answered in its declared protocol.
          </span>
        )}
      </p>
    </section>
  );
}

async function ProbeSection({
  findings,
  quality,
}: {
  findings: Findings;
  quality: Promise<AgentQuality | null>;
}) {
  const [proof, uptime, scan] = await Promise.all([findings.proof, findings.uptime, quality.then((q) => q?.endpoint_health ?? null)]);
  if (!proof) {
    // Printed rather than omitted. A form with no "we called it" block reads
    // as a form Kawal forgot to fill in; this one says why there is nothing
    // to fill.
    return (
      <section className="border-b-[1.5px] border-rule px-5 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="cap">We just called it</h2>
            <p className="typed mt-2 text-[1.6rem] font-bold leading-tight">
              <span>Nothing to call</span>
            </p>
          </div>
          <Stamp ink="stamp-grey">Registered only</Stamp>
        </div>
        <p className="typed mt-3 max-w-[64ch] text-[0.9rem] text-carbon-2">
          This registration declares no MCP or A2A endpoint, so there was nothing to call.
        </p>
      </section>
    );
  }
  return <LiveProbe proof={proof} uptime={uptime} scan={scan} />;
}

async function PaymentSection({ findings }: { findings: Findings }) {
  const payment = await findings.payment;
  return payment ? <PaymentTerms check={payment} /> : null;
}

async function TrackRecordSection({ findings }: { findings: Findings }) {
  const reputation = await findings.reputation;
  // `sampled`, not `total`. A 200 carrying a total and no readable items — a
  // shape change upstream, a truncated response — would otherwise render
  // "every record was written without a mark" about records Kawal never
  // read. Saying nothing is the honest output of reading nothing.
  return reputation && reputation.sampled > 0 ? <TrackRecord r={reputation} /> : null;
}

function LiveProbe({
  proof,
  uptime,
  scan,
}: {
  proof: EndpointProof;
  uptime: Uptime | null;
  scan: AgentQuality["endpoint_health"] | null;
}) {
  const good = proof.answered;
  const desc = proof.descriptor;
  const a2a = proof.protocol === "a2a";

  /*
   * Three outcomes, not two. An endpoint that fails the handshake is usually
   * broken, but sometimes it is software that was never meant to be called
   * over HTTP — a stdio server published with an install command, or a source
   * repository. Filing those under "No answer" was Kawal saying an agent could
   * not be hired when it plainly can, which is the same failure as trusting
   * the registry, pointed the other way.
   */
  const headline = good
    ? a2a
      ? "Answers A2A"
      : "Answers MCP"
    : desc?.kind === "service-descriptor"
      ? "Runs locally, not hosted"
      : desc?.kind === "source-repository"
        ? "Published as source"
        : proof.reachable
          ? a2a
            ? "Responds, but not as an A2A agent"
            : "Responds, but not MCP"
          : "No answer";

  // The same words a tier is stamped with, from the same source: this
  // verdict is about one call rather than the whole record, but a reader who
  // has learnt the stamps should not have to learn a second vocabulary.
  const stampTier: Tier = good ? "hireable" : desc || proof.reachable ? "reachable" : "unreachable";
  const failure = !desc && proof.error ? diagnose(proof.error) : null;

  return (
    <section className="border-b-[1.5px] border-rule px-5 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="cap">We just called it</h2>
          <p className="typed mt-2 text-[1.6rem] font-bold leading-tight">
            <span>{headline}</span>
            <span className="ml-3 text-[0.85rem] font-normal text-carbon-3">{proof.latencyMs} ms</span>
          </p>
        </div>
        <Stamp ink={tierInk(stampTier)} evidence={uptime?.checks ?? null}>
          {tierLabel(stampTier)}
        </Stamp>
      </div>

      {desc && (
        <p className="typed mt-3 max-w-[64ch] text-[0.9rem] text-carbon-2">
          {desc.kind === "service-descriptor"
            ? `This URL is not a server. It publishes an ERC-8004 service descriptor: the agent is real and its tools are listed below, but it is spoken to over ${desc.transport ?? "another transport"} after you install it — not over the network. A spend cap cannot be enforced on a call Kawal never carries, so this agent is listed and not seated.`
            : "The registration points at a source repository rather than a running endpoint. The code is real and installable; there is nothing at this address to call, so Kawal makes no claim about uptime."}
        </p>
      )}

      <dl className="cells mt-4 sm:grid-cols-2">
        <Row label="Endpoint">{proof.endpoint}</Row>
        {proof.serverName && <Row label="Server">{proof.serverName}</Row>}
        {proof.protocolVersion && <Row label="Protocol">{proof.protocolVersion}</Row>}
        {proof.toolCount !== null && (
          <Row label={a2a ? "Skills offered" : "Tools offered"}>{String(proof.toolCount)}</Row>
        )}
        {/* An A2A probe is two calls: the card, and a harmless JSON-RPC
            question to the URL the card names. A card can be a static file
            in front of a dead server, so the second answer is the one that
            counts and it is shown on its own line. */}
        {proof.a2a && proof.a2a.rpcUrl && proof.a2a.rpcUrl !== proof.endpoint && (
          <Row label="Spoken to at">{proof.a2a.rpcUrl}</Row>
        )}
        {proof.a2a && (
          <Row label="JSON-RPC">
            {rpcOutcomeLabel(proof.a2a.rpc)}
            {proof.a2a.rpcStatus > 0 && <span className="text-carbon-3"> (HTTP {proof.a2a.rpcStatus})</span>}
          </Row>
        )}
        {/* A2A 0.3 lets a card carry a JWS over itself. A card that checks
            out against the key it names is the agent's own; one that fails
            is worse than one carrying none. Every BSC card read so far is
            unsigned, and the line says so rather than leaving the reader to
            assume a check was made. */}
        {proof.a2a?.signature != null && (
          <Row label="Card signed by its wallet">
            {proof.a2a.signature === "valid"
              ? "valid — the card's own signature checks out"
              : proof.a2a.signature === "invalid"
                ? "invalid — the card carries a signature that does not check out"
                : proof.a2a.signature === "unsupported"
                  ? "signed with an algorithm this reader cannot check"
                  : "unsigned"}
          </Row>
        )}
        {desc?.transport && <Row label="Transport">{desc.transport}</Row>}
        {/* Quoted, never run. Kawal executes nothing it finds in a
            registration, and the wording has to make that obvious. */}
        {desc?.install && <Row label="Install">{desc.install}</Row>}
        {proof.error && !desc && <Row label="Failure">{proof.error}</Row>}
      </dl>

      {/* "Does not answer" is one word covering at least four situations, and
          they are not the same proposition to somebody about to grant a spend
          cap. A vanished domain is an abandonment; a 502 is a bad afternoon.
          The 404 is the one worth naming: the host answered *about* this agent
          to say it does not have it, which is a deregistration recorded
          nowhere, because ERC-8004 has no way to write one down. */}
      {failure && failure.failure !== "unknown" && (
        <p className="typed mt-4 max-w-[64ch] border-[1.5px] border-stamp-red bg-paper-pink px-3 py-2 text-[0.88rem]">
          <span className="form-face font-700 uppercase tracking-[0.06em] text-stamp-red">{failureLabel(failure.failure)}.</span>{" "}
          <span className="text-carbon-2">{failure.summary}</span>
          {failure.transient && <span className="text-carbon-3"> A later check may pass.</span>}
        </p>
      )}

      {/* Says "at most a minute" rather than "live" because proofs are reused
          for 60s. Suppressed for a descriptor even when rows exist: they were
          written before Kawal could tell a non-server from a dead one, and
          "0 of 4 answered" beside "runs locally" reads as unreliability rather
          than as a category error on our side. */}
      {uptime && uptime.checks > 1 && !desc && (
        <div className="mt-5 flex flex-col gap-3">
          <Tally answered={uptime.answered} checks={uptime.checks} newestAnswered={uptime.lastAnswered} />
          <p className="typed text-[0.9rem]">
            <span className="font-bold">
              {uptime.answered} of {uptime.checks}
            </span>{" "}
            checks answered since {new Date(uptime.since * 1000).toISOString().slice(0, 10)}
            {uptime.medianMs !== null && (
              <span className="text-carbon-3">
                {" "}
                · median {uptime.medianMs} ms
                {uptime.worstMs !== null && uptime.worstMs > uptime.medianMs ? `, slowest ${uptime.worstMs} ms` : ""}
              </span>
            )}
            {/* What this measurement cannot see. GEBO, the uptime agent
                writing into the same registry, publishes the identical defect
                about itself; a reliability figure with no stated blind spot
                is asking to be over-trusted. */}
            {uptime.answered < uptime.checks && (
              <span className="stamp-note mt-1 block">
                Measured from a single vantage point. A missed check means Kawal could not reach it from
                here, which is not the same as the agent being down.
              </span>
            )}
          </p>
        </div>
      )}

      {scan && !desc && <Agreement proof={proof} uptime={uptime} scan={scan} />}

      {proof.tools.length > 0 && (
        <ToolTable tools={proof.tools} total={proof.toolCount ?? 0} unit={a2a ? "skill" : "tool"} />
      )}

      {/* The limit of Kawal's own claim, stated where the claim is made.
          `hireable` means the endpoint completed an MCP handshake and listed
          its tools. It does not mean any of those tools work. Kawal is strict
          about everyone else's unverified claims, and this is its own — so it
          says so rather than deepening the probe by running strangers' tools
          uninvited, which could cost them money or have side effects. */}
      {proof.answered && (
        <p className="stamp-note mt-4 max-w-[64ch]">
          {a2a
            ? "Kawal read the agent card and asked its JSON-RPC endpoint the one A2A question with no effect. It sent no message — that would start work on a stranger’s server. So this is evidence the agent answers, not that it works."
            : "Kawal completed the handshake and read the tool list. It did not run any of them — executing a stranger’s tool uninvited can cost them money or move something. So this is evidence the agent answers, not that it works."}
        </p>
      )}

      <p className="cap mt-4">
        {desc?.kind === "source-repository"
          ? `Read from the registration at ${proof.checkedAt.replace("T", " ").slice(0, 19)} UTC · no request was sent to a repository host`
          : `Kawal called this endpoint at ${proof.checkedAt.replace("T", " ").slice(0, 19)} UTC`}
        {desc?.kind !== "source-repository" && " · at most a minute old, never from the registry’s cache"}
      </p>
    </section>
  );
}

/**
 * Two readings of the same door, side by side.
 *
 * 8004scan publishes a cached health check; Kawal has its own calls. When
 * they agree, a reader has two sources. When they disagree, the difference
 * is worth more than either: one of the two is stale, and the timestamps say
 * which. Printed as a sentence with both dates rather than as a verdict.
 */
function Agreement({
  proof,
  uptime,
  scan,
}: {
  proof: EndpointProof;
  uptime: Uptime | null;
  scan: NonNullable<AgentQuality["endpoint_health"]>;
}) {
  const scanUp = scan.overall_status === "healthy" ? true : scan.overall_status === "unhealthy" ? false : null;
  const kawalUp = proof.answered;
  const scanAt = scan.checked_at ? new Date(scan.checked_at).toISOString().slice(0, 16).replace("T", " ") : null;
  const kawal = uptime && uptime.checks > 1 ? `${uptime.answered} of ${uptime.checks} calls answered, the latest ${kawalUp ? "answered" : "did not"}` : `the latest call ${kawalUp ? "answered" : "did not answer"}`;

  return (
    <p className="typed mt-4 max-w-[64ch] text-[0.88rem] text-carbon-2">
      <span className="cap mr-2">Two readings</span>
      8004scan read this endpoint as <span className="font-bold">{scan.overall_status}</span>
      {scanAt && ` at ${scanAt} UTC`}. Kawal&rsquo;s own: {kawal}.{" "}
      {scanUp === null
        ? "8004scan's reading is inconclusive, so there is nothing to agree or disagree with."
        : scanUp === kawalUp
          ? "The two agree."
          : `The two disagree; 8004scan's reading is a cached check and Kawal's is from ${proof.checkedAt.replace("T", " ").slice(0, 16)} UTC, so one of them is out of date.`}
    </p>
  );
}

/**
 * What the registration says about payment, next to what the server said.
 *
 * `x402_supported` is a flag a registration sets about itself, and the whole
 * of BSC treats it as fact — including, until now, this page. A sweep of 200
 * registrations found 75 claiming it and none of the reachable ones asking to
 * be paid; `npm run x402` re-runs that count. The claim is not called a lie:
 * an agent may take payment by a route this request cannot see.
 */
function PaymentTerms({ check }: { check: X402Check }) {
  const charged = check.demanded;
  return (
    <section className="border-b-[1.5px] border-rule px-5 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="cap">We asked it to charge us</h2>
          <p className="typed mt-2 text-[1.6rem] font-bold leading-tight">{charged ? "Quotes a price" : "Claims x402, asked for nothing"}</p>
        </div>
        <Stamp ink={charged ? "stamp-green" : "stamp-grey"}>
          {charged ? "Charged" : "No charge"}
        </Stamp>
      </div>

      <p className="typed mt-3 max-w-[64ch] text-[0.9rem] text-carbon-2">
        {charged
          ? "Kawal sent the request an x402 client sends first — no payment header — and the server answered 402 with terms. Kawal read them and paid nothing."
          : "This registration sets the x402 flag. Kawal sent the opening request of the protocol and the server answered without demanding payment, so the flag is unverified here. It may still charge by a route this request cannot see."}
      </p>

      <dl className="cells mt-4 sm:grid-cols-2">
        <Row label="Endpoint">{check.endpoint}</Row>
        <Row label="Answered">HTTP {check.status || "—"}</Row>
        {check.serviceName && <Row label="Service">{check.serviceName}</Row>}
        {check.quote && <Row label="In its own words">{check.quote}</Row>}
        {check.x402Version !== null && <Row label="x402 version">{String(check.x402Version)}</Row>}
        {check.accepts.map((a, i) => (
          <Fragment key={`${a.network}-${a.asset}-${i}`}>
            <Row label="Network">{networkName(a.network)}</Row>
            <Row label="Asset">{a.asset}</Row>
            <Row label="Amount">{a.amount} atomic units</Row>
            <Row label="Pays to">{a.payTo}</Row>
            {a.maxTimeoutSeconds !== null && <Row label="Settle within">{a.maxTimeoutSeconds} s</Row>}
          </Fragment>
        ))}
        {!charged && check.error && <Row label="Result">{check.error}</Row>}
      </dl>

      <p className="cap mt-4">
        Asked at {check.checkedAt.replace("T", " ").slice(0, 19)} UTC · Kawal never settles a payment on a visitor&rsquo;s behalf
      </p>
    </section>
  );
}

/**
 * Who wrote this agent's track record.
 *
 * `total_feedbacks` and `average_score` are counts the registry keeps without
 * asking who wrote the records. Reading 1,200 of them across BSC found a mark
 * on every one — a graded register, not an empty one — but only 53 addresses
 * behind the lot, one of which wrote 265 of the oldest 600 under the tag
 * `get top 1 rank >`. An average over that turns one party's opinion into a
 * consensus. Concentration is reported, not judged, and the address is shown
 * so the reader can go and tell an uptime prober from an owner.
 */
function TrackRecord({ r }: { r: Reputation }) {
  const unmarked = r.valued === 0;
  const captured = r.raters === 1 || r.topRaterShare >= CAPTURED_SHARE;
  const headline = unmarked
    ? "Records carrying no mark"
    : captured
      ? "Feedback from almost one source"
      : "Marked by several addresses";

  return (
    <section className="border-b-[1.5px] border-rule px-5 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="cap">We read the feedback</h2>
          <p className="typed mt-2 text-[1.6rem] font-bold leading-tight">
            <span>{headline}</span>
          </p>
        </div>
        <Stamp ink={unmarked || captured ? "stamp-grey" : "stamp-violet"} evidence={r.sampled}>
          {unmarked ? "Empty" : captured ? "One source" : "Several sources"}
        </Stamp>
      </div>

      <p className="typed mt-3 max-w-[64ch] text-[0.9rem] text-carbon-2">
        {unmarked
          ? "Every record on this agent was written without a mark. There is nothing here to judge on, whatever number the registry prints beside it."
          : captured
            ? "One address wrote most of what is here. That is not proof of anything — a scheduled uptime prober looks exactly like this — but it is one party's opinion rather than a market's, and it is worth knowing which before granting a spend cap."
            : "Several separate addresses marked this agent. That is as close to a track record as ERC-8004 currently gets on BSC."}
      </p>

      <dl className="cells mt-4 sm:grid-cols-2 lg:grid-cols-3">
        <Row label="Records held">{r.total.toLocaleString()}</Row>
        <Row label="Carrying a mark">
          {r.valued} of {r.sampled} read
        </Row>
        {/* 8004scan's own normalised field, which is what an `average_score`
            is computed from. Null on 1,192 of 1,200 sampled chain-wide, so the
            gap between this row and the one above is the gap between the marks
            that exist and the marks the ecosystem averages. */}
        <Row label="In the registry's score field">
          {r.scored} of {r.sampled}
        </Row>
        <Row label="Carrying a comment">{r.commented}</Row>
        <Row label="Distinct writers">{r.raters}</Row>
        {/* The registry lets any address call giveFeedback, the agent's
            own included. Counted and named, not subtracted: a reader should
            see that it was done. */}
        <Row label="Self-rated">
          {r.selfRated} of {r.sampled} ratings were written by the agent&rsquo;s own wallet, owner or minter
          {r.selfRaters.length > 0 && (
            <span className="text-carbon-3"> · {r.selfRaters.map((a) => `${a.slice(0, 10)}…`).join(", ")}</span>
          )}
        </Row>
        {r.revoked > 0 && <Row label="Withdrawn">{r.revoked}</Row>}
        {r.topRater && (
          <Row label="Busiest writer">
            <a
              href={`https://bscscan.com/address/${r.topRater}`}
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              {r.topRater.slice(0, 10)}…{r.topRater.slice(-6)}
            </a>
            <span className="ml-2 text-carbon-3">{Math.round(r.topRaterShare * 100)}%</span>
          </Row>
        )}
        {/* What the busiest address wrote under. A wall of one tag is a
            scheduled prober; a spread of several is a person. */}
        {r.topRaterTags.length > 0 && (
          <Row label="Busiest writer's tags">
            {r.topRaterTags.map((t, i) => (
              <span key={t.tag}>
                {i > 0 && ", "}
                <code>{t.tag}</code> ×{t.count}
              </span>
            ))}
          </Row>
        )}
        {/* The owner answering on-chain is the one signal here that cannot
            be bought from a prober: someone is running this agent. */}
        <Row label="Owner replies">
          {r.replies.length === 0
            ? "none in the sample"
            : r.replies.map((reply, i) => (
                <span key={reply.feedbackId}>
                  {i > 0 && " · "}
                  {reply.uri ? (
                    <a href={reply.uri} target="_blank" rel="noreferrer noopener" className="underline">
                      {reply.by.slice(0, 10)}…
                    </a>
                  ) : (
                    `${reply.by.slice(0, 10)}…`
                  )}
                  {reply.at ? ` on ${reply.at.slice(0, 10)}` : ""}
                </span>
              ))}
        </Row>
      </dl>

      {r.recentComments.length > 0 && (
        <ul className="mt-4 max-w-[64ch] space-y-2">
          {r.recentComments.map((c, i) => (
            <li key={`${c.by}-${i}`} className="typed border-l-[1.5px] border-rule-soft pl-3 text-[0.88rem] text-carbon-2">
              &ldquo;{c.comment.length > 240 ? `${c.comment.slice(0, 240)}…` : c.comment}&rdquo;
              <span className="block text-[0.78rem] text-carbon-3">
                {c.by.slice(0, 10)}…{c.at ? ` · ${c.at.slice(0, 10)}` : ""}
                {c.tag ? ` · ${c.tag}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Which way the score has been going, which a snapshot cannot show.
 *
 * A 30 that has been climbing and a 30 that has been sliding are different
 * propositions, and the registry only ever displays the number. Most BSC
 * registrations have no history at all — thousands arrive daily — so "not
 * enough history yet" is the common answer and a signal in itself.
 */
function Trajectory({ history }: { history: ScoreHistory }) {
  const points = [...history.history].reverse();
  const change = history.score_change;

  const direction =
    change === null || points.length < 2
      ? null
      : change > 0.5
        ? { label: "rising", ink: "var(--stamp-green)" }
        : change < -0.5
          ? { label: "falling", ink: "var(--stamp-red)" }
          : { label: "flat", ink: "var(--carbon-3)" };

  return (
    <section className="border-b-[1.5px] border-rule px-5 py-6">
      <h2 className="cap">Which way it is going · 8004scan&rsquo;s score over time</h2>

      {points.length < 2 ? (
        <p className="typed mt-3 max-w-[64ch] text-carbon-2">
          Not enough history yet — 8004scan has scored this agent on {history.data_points} day
          {history.data_points === 1 ? "" : "s"}. New registrations arrive on BSC by the thousand, so
          most have no record to read.
        </p>
      ) : (
        <>
          <p className="typed mt-2 text-[1.6rem] font-bold leading-tight" style={{ color: direction?.ink }}>
            {direction?.label}
            <span className="ml-3 text-[0.85rem] font-normal text-carbon-3">
              {change! >= 0 ? "+" : ""}
              {change!.toFixed(2)} over {history.period_days} days · {history.data_points} readings
            </span>
          </p>
          <Sparkline values={points.map((p) => p.total_score)} />
          <p className="cap mt-2">
            {points.at(0)?.scored_at.slice(0, 10)} → {points.at(-1)?.scored_at.slice(0, 10)}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * 8004scan's v5 score, the five weighted parts behind the one number.
 *
 * Engagement 30, service 25, publisher 20, compliance 15, momentum 10 — the
 * weights are the registry's and printed with each part, so a reader can
 * see that a low momentum costs little and a low engagement costs much.
 * Each cell carries its own 0-100 scale under the bar, because a bar with
 * no axis is decoration; the date is the registry's `last_scored_at`.
 */
function ScoreV5Block({ v5 }: { v5: ScoreV5 }) {
  const rows = v5Rows(v5);
  // The registry publishes its headline separately from the parts, and the
  // two do not reconcile: 43129 totalled 30.47 against parts of 45.62 on
  // 2026-08-30, 45381 30.45 against 44.87. Whatever `v5_leaderboard_policy`
  // does to the headline it does not show its working, so the page prints
  // both numbers and says they disagree. Silently printing five parts under
  // a total they do not add up to would leave the arithmetic to the reader
  // and let them conclude Kawal had got it wrong.
  const parts = rows.reduce((sum, r) => sum + r.dimension.weighted_score, 0);
  const reconciles = Math.abs(parts - v5.total_score) < 0.05;
  return (
    <section className="border-b-[1.5px] border-rule px-5 py-6">
      <h2 className="cap">
        How 8004scan scores it · {v5.total_score.toFixed(2)} total · v5
      </h2>
      <p className="cap mt-1 !text-carbon-2">
        Each part 0–100, then × weight; the weights sum to 100
        {!reconciles && rows.length > 0 && ` · the parts come to ${parts.toFixed(2)}, which the registry’s own total does not match`}
        {v5.last_scored_at && ` · scored ${new Date(v5.last_scored_at).toISOString().replace("T", " ").slice(0, 16)} UTC`}
      </p>
      <dl className="cells mt-3 sm:grid-cols-2 lg:grid-cols-5">
        {rows.map(({ key, label, dimension: d, weightPct }) => (
          <div key={key} className="cell">
            <dt className="cap">
              {label} · {d.score.toFixed(0)} / 100 × {weightPct}
            </dt>
            <dd className="typed text-[1.3rem] font-bold leading-tight">
              {d.weighted_score.toFixed(1)}
              <span className="ml-2 text-[0.78rem] font-normal text-carbon-3">of {weightPct}</span>
            </dd>
            <dd className="mt-2 h-[10px] border border-rule bg-paper-white" aria-hidden>
              <span className="block h-full bg-carbon" style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }} />
            </dd>
            <dd className="cap mt-1 flex justify-between !text-carbon-3" aria-hidden>
              <span>0</span>
              <span>100</span>
            </dd>
            {d.explanation && (
              <dd className="typed mt-1.5 text-[0.78rem] text-carbon-3">
                {d.explanation.length > 140 ? `${d.explanation.slice(0, 140)}…` : d.explanation}
              </dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * 8004scan's older score, dimension by dimension, for agents the registry
 * has not scored under v5.
 *
 * Each bar is one dimension on a 0–100 scale, weighted as the registry
 * weights it; the scale is printed because a bar with no axis is decoration.
 * The date is the registry's own `last_scored_at`, not the page's.
 */
function ScoreBreakdown({ score }: { score: AgentQuality["score"] }) {
  return (
    <section className="border-b-[1.5px] border-rule px-5 py-6">
      <h2 className="cap">
        How 8004scan scores it · {score.total_score.toFixed(2)} total
        {score.version && ` · v${score.version}`}
      </h2>
      <p className="cap mt-1 !text-carbon-2">
        Each bar 0–100, then × weight
        {score.last_scored_at && ` · scored ${new Date(score.last_scored_at).toISOString().slice(0, 10)}`}
      </p>
      <dl className="mt-3 space-y-3 sm:space-y-2">
        {score.dimensions.map((d) => (
          <div key={d.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[7rem_minmax(0,1fr)_7rem]">
            <dt className="cap !mb-0">{d.label}</dt>
            {/* Full width under the caption on a phone; the middle column
                from `sm`. A 7rem caption column left a bar 60px wide at
                360px, which is a line, not a measurement. */}
            <dd className="order-last col-span-2 h-[10px] border border-rule bg-paper-white sm:order-none sm:col-span-1" aria-hidden>
              <span className="block h-full bg-carbon" style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }} />
            </dd>
            <dd className="typed text-right text-[0.8rem] text-carbon-3">
              {d.score.toFixed(1)} × {d.weight}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * A score line, drawn as SVG rather than pulled from a charting library.
 *
 * Thirty numbers and one path element do not justify a dependency, and an
 * inline SVG renders on the server with no client JavaScript at all. Drawn as
 * a pen trace on the form's ruled paper.
 */
function Sparkline({ values }: { values: number[] }) {
  const width = 320;
  const height = 44;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = max - min === 0;

  const d = values
    .map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * width;
      // An unchanged score is the common case, and dividing by a zero span
      // pinned it to y = height - 2: a line hugging the floor, which reads as
      // "bottomed out" rather than "steady". Draw it down the middle instead.
      const y = flat ? height / 2 : height - ((v - min) / (max - min)) * (height - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      className="mt-4 w-full max-w-sm border border-rule bg-paper-white"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Score from ${min.toFixed(2)} to ${max.toFixed(2)} over ${values.length} readings`}
    >
      {[11, 22, 33].map((y) => (
        <line key={y} x1="0" x2={width} y1={y} y2={y} stroke="var(--rule-faint)" strokeWidth="1" />
      ))}
      <path d={d} fill="none" stroke="var(--stamp-violet)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * What this agent will actually do, and what it says that costs.
 *
 * 8004scan has no price field anywhere, and price is the first question
 * anyone deciding whether to hire has. Agents put it in the tool description
 * themselves — "Free.", "Paid (0.2 BNB on BSC)" — so the listing reads it
 * back rather than pretending the question does not exist. Labelled
 * "declares" throughout: the agent is making the claim, Kawal is only
 * refusing to hide it.
 */
function ToolTable({ tools, total, unit = "tool" }: { tools: ProbedTool[]; total: number; unit?: string }) {
  const priced = tools.filter((t) => t.declaredPrice);

  return (
    <div className="mt-5">
      <h3 className="cap">
        What you can ask it · {total} {unit}
        {total === 1 ? "" : "s"}
        {priced.length > 0 && ` · ${priced.length} declares a price`}
      </h3>

      {/* Tool names are whatever the server chose, and some are one
          unbroken token longer than a phone is wide. Wrapped where they can
          be, scrolled inside the box where they cannot. */}
      <div className="overflow-x-auto">
        <ul className="mt-2 border-y-[1.5px] border-rule">
          {tools.map((t) => (
            <li key={t.name} className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-rule-soft py-2 last:border-b-0 sm:grid-cols-[14rem_auto_minmax(0,1fr)]">
              <span className="typed break-all text-[0.9rem] font-bold">{t.name}</span>
              <span>
                {t.declaredPrice ? (
                  <Stamp ink="stamp-green" size="sm" flat>
                    declares {t.declaredPrice.amount} {t.declaredPrice.token}
                  </Stamp>
                ) : t.declaredFree ? (
                  <span className="cap">declares free</span>
                ) : null}
              </span>
              {t.description && (
                <span className="typed min-w-0 break-words text-[0.85rem] text-carbon-3">
                  {t.description.length > 110 ? `${t.description.slice(0, 110)}…` : t.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {total > tools.length && (
        <p className="cap mt-2">
          showing {tools.length} of {total}
        </p>
      )}
    </div>
  );
}

const STATUS_INK: Record<string, string> = {
  healthy: "var(--stamp-green)",
  degraded: "var(--stamp-blue)",
  unhealthy: "var(--stamp-red)",
  unknown: "var(--carbon-3)",
};

function ServiceCell({ service }: { service: ServiceHealth }) {
  return (
    <div className="cell">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-[9px] w-[9px] border border-rule"
          style={{ background: STATUS_INK[service.status] ?? "var(--carbon-3)" }}
        />
        <span className="cap !mb-0">{service.label}</span>
        {service.latency_ms !== null && (
          <span className="typed ml-auto text-[0.8rem] text-carbon-3">{Math.round(service.latency_ms)} ms</span>
        )}
      </div>
      {service.message && <p className="typed mt-1.5 text-[0.85rem] text-carbon-2">{service.message}</p>}
      {service.domain && (
        <p className="typed mt-2 break-all text-[0.8rem] text-carbon-3">
          {service.domain}
          {/* Answering and being provably yours are different claims, and a
              user hiring an agent deserves to see the second one fail. */}
          {service.domain_verified ? (
            <span className="ml-2 text-carbon-2">domain verified</span>
          ) : (
            <span className="ml-2 text-stamp-red">
              domain unverified
              {service.verification_error ? ` (${service.verification_error})` : ""}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function RiskRow({ flag }: { flag: RiskFlag }) {
  const ink =
    flag.severity === "critical" || flag.severity === "high"
      ? "var(--stamp-red)"
      : flag.severity === "medium"
        ? "var(--stamp-blue)"
        : "var(--carbon-3)";
  return (
    <li className="py-3">
      <div>
        <p className="typed text-[0.92rem] font-bold">
          {flag.title}
          <span className="cap ml-2" style={{ color: ink }}>{flag.severity}</span>
        </p>
        <p className="typed text-[0.88rem] text-carbon-2">{flag.description}</p>
      </div>
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cell">
      <dt className="cap">{label}</dt>
      <dd className="typed break-all text-[0.88rem] text-carbon-2">{children}</dd>
    </div>
  );
}
