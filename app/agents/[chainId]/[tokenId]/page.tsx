import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAgent,
  getQuality,
  getScoreHistory,
  type ServiceHealth,
  type RiskFlag,
  type ScoreHistory,
} from "@/lib/scan";
import { proveAgent, type EndpointProof, type ProbedTool } from "@/lib/probe";
import { uptimeFor, observedFor, type Uptime } from "@/lib/uptime";
import { checkX402Cached, networkName, type X402Check } from "@/lib/x402";
import { getReputationCached, CAPTURED_SHARE, type Reputation } from "@/lib/reputation";
import { diagnose, failureLabel } from "@/lib/failure";
import { classify } from "@/lib/taxonomy";
import { assess, tierLabel } from "@/lib/signals";
import { categoryLabel, seatColor } from "@/components/listing";

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
 * the 5-minute cache, so this costs no extra upstream call.
 */
export async function generateMetadata({ params }: PageProps<"/agents/[chainId]/[tokenId]">) {
  const { chainId, tokenId } = await params;
  const agent = await getAgent(Number(chainId), tokenId).catch(() => null);
  if (!agent) notFound();

  return {
    title: `${agent.name} — hire on Kawal`,
    description:
      agent.description?.trim().slice(0, 160) ||
      `ERC-8004 agent ${agent.agent_id} on BNB Smart Chain.`,
  };
}

export default async function AgentPage({ params }: PageProps<"/agents/[chainId]/[tokenId]">) {
  const { chainId, tokenId } = await params;

  const [agent, quality, history, reputation] = await Promise.all([
    getAgent(Number(chainId), tokenId).catch(() => null),
    getQuality(Number(chainId), tokenId),
    getScoreHistory(Number(chainId), tokenId),
    // Read here rather than on the listing: this is one request per agent, and
    // decorating fifty rows nobody has chosen yet would be fifty of them.
    getReputationCached(Number(chainId), tokenId),
  ]);
  if (!agent) notFound();

  // Knock on the door ourselves. 8004scan's report is a reading from some
  // earlier moment; this one is from now, from here, and it is the only check
  // that catches a registration whose MCP endpoint is an image file.
  const proof = await proveAgent(agent);

  // Only asked of agents that claim to charge, and only here — the listing
  // shows many agents and must not make a second round of requests to other
  // people's servers to decorate rows nobody has chosen yet.
  const payment =
    agent.x402_supported === true && proof?.endpoint
      ? await checkX402Cached(proof.endpoint)
      : null;

  const classification = classify(agent.name, agent.description);
  // The registry's claim, reconciled with what Kawal has actually seen. An
  // endpoint called repeatedly and never reached is not hireable, whatever
  // the registration says — but an agent that published a stdio route or a
  // repository answered us, so it is not the silent case either.
  const observed = observedFor(proof?.endpoint);
  const assessment = assess(
    agent,
    undefined,
    observed && { ...observed, reachedAnotherWay: proof?.descriptor != null },
    payment ? { demanded: payment.demanded } : undefined,
    reputation,
  );
  const registered = new Date(agent.created_at);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-12">
      <Link href="/agents" className="label hover:text-ink">
        ← All agents
      </Link>

      <header className="mt-8 flex items-start gap-4 border-b border-rule pb-8">
        <span
          aria-hidden
          className="mt-2 h-9 w-[3px] flex-none rounded-sm"
          style={{ background: seatColor(classification.category) }}
        />
        <div className="min-w-0">
          <p className="label">
            {categoryLabel(classification.category)} ·{" "}
            {Math.round(classification.confidence * 100)}% confidence
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.03em]">{agent.name}</h1>
          <p className="mt-3 max-w-2xl text-ink-2">
            {agent.description?.trim() || "No description registered."}
          </p>
        </div>
      </header>

      <section className="border-b border-rule py-8">
        <h2 className="label">Can you hire it</h2>
        <p className="mt-3 text-2xl font-semibold tracking-tight">
          {tierLabel(assessment.tier)}
        </p>
        <dl className="mt-6 grid gap-px bg-rule sm:grid-cols-2">
          {assessment.signals.map((s) => (
            <div key={s.key} className="bg-surface px-4 py-3">
              <dt className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: s.pass ? "var(--seat-yield)" : "var(--rule-2)" }}
                />
                <span className="label">{s.label}</span>
              </dt>
              <dd className="mt-1 text-sm text-ink-2">{s.detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      {proof && <LiveProbe proof={proof} uptime={uptimeFor(proof.endpoint)} />}

      {payment && <PaymentTerms check={payment} />}

      {/* `sampled`, not `total`. A 200 carrying a total and no readable items
          — a shape change upstream, a truncated response — would otherwise
          render "every record was written without a mark" about records Kawal
          never read. Saying nothing is the honest output of reading nothing. */}
      {reputation && reputation.sampled > 0 && <TrackRecord r={reputation} />}

      {quality?.endpoint_health && (
        <section className="border-b border-rule py-8">
          <h2 className="label">Is it answering right now</h2>
          <p className="mt-3 text-2xl font-semibold tracking-tight capitalize">
            {quality.endpoint_health.overall_status}
            {quality.endpoint_health.checked_at && (
              <span className="ml-3 text-sm font-normal text-ink-3">
                checked {new Date(quality.endpoint_health.checked_at).toISOString().replace("T", " ").slice(0, 16)}
              </span>
            )}
          </p>

          <div className="mt-6 grid gap-px bg-rule sm:grid-cols-2">
            {quality.endpoint_health.services
              .filter((s) => s.status !== "skipped")
              .map((s) => (
                <ServiceCard key={s.key} service={s} />
              ))}
          </div>
        </section>
      )}

      {quality && quality.risk_flags.length > 0 && (
        <section className="border-b border-rule py-8">
          <h2 className="label">What to weigh against it</h2>
          <ul className="mt-4 space-y-3">
            {quality.risk_flags.map((f) => (
              <RiskRow key={f.id} flag={f} />
            ))}
          </ul>
        </section>
      )}

      {history && <Trajectory history={history} />}

      {quality && quality.score.dimensions.length > 0 && (
        <section className="border-b border-rule py-8">
          <h2 className="label">
            How 8004scan scores it · {quality.score.total_score.toFixed(2)} total
            {quality.score.version && ` · v${quality.score.version}`}
          </h2>
          <dl className="mt-5 space-y-2.5">
            {quality.score.dimensions.map((d) => (
              <div key={d.key} className="flex items-baseline gap-3">
                <dt className="label w-28 flex-none">{d.label}</dt>
                <dd className="flex flex-1 items-center gap-3">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-sm bg-rule">
                    <span
                      className="block h-full rounded-sm"
                      style={{
                        width: `${Math.max(0, Math.min(100, d.score))}%`,
                        background: "var(--brass)",
                      }}
                    />
                  </span>
                  <span className="tnum w-32 flex-none text-right font-mono text-xs text-ink-3">
                    {d.score.toFixed(1)} × {d.weight}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="py-8">
        <h2 className="label">Registration</h2>
        <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Row label="Identity">{agent.agent_id}</Row>
          <Row label="Owner">{agent.owner_ens ?? agent.owner_address}</Row>
          <Row label="Agent wallet">{agent.agent_wallet ?? "not published"}</Row>
          <Row label="Registered">{registered.toISOString().slice(0, 10)}</Row>
          <Row label="Protocols">
            {agent.supported_protocols.join(", ").toUpperCase() || "none declared"}
          </Row>
          <Row label="Reputation">
            score {agent.total_score.toFixed(2)} · {agent.total_feedbacks} feedbacks ·{" "}
            {agent.star_count} stars
          </Row>
        </dl>

        {classification.matched.length > 0 && (
          <p className="label mt-8">
            Classified from: {classification.matched.join(", ")}
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * What the registration says about payment, next to what the server said.
 *
 * `x402_supported` is a flag a registration sets about itself, and the whole
 * of BSC treats it as fact — including, until now, this page. A sweep of 200
 * registrations found 75 claiming it and none of the reachable ones asking to
 * be paid; `npm run x402` re-runs that count.
 *
 * The claim is not called a lie. An agent may take payment by a route this
 * request cannot see, and the wording has to leave room for that while
 * refusing to repeat an unverified claim as a checkmark.
 */
/**
 * Who wrote this agent's track record.
 *
 * `total_feedbacks` and `average_score` are counts the registry keeps without
 * asking who wrote the records. Reading 1,200 of them across BSC found a mark
 * on every one — a graded register, not an empty one — but only 53 addresses
 * behind the lot, one of which wrote 265 of the oldest 600 under the tag
 * `get top 1 rank >`. An average over that turns one party's opinion into a
 * consensus.
 *
 * Concentration is reported, not judged. An uptime prober writing hundreds of
 * honest records looks identical here to an owner talking about themselves,
 * and the address is shown so the reader can go and tell them apart.
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
    <section className="border-b border-rule py-8">
      <h2 className="label">We read the feedback</h2>
      <p className="mt-3 flex flex-wrap items-baseline gap-3">
        <span
          className="text-2xl font-semibold tracking-tight"
          style={{ color: unmarked || captured ? "var(--brass)" : "var(--seat-yield)" }}
        >
          {headline}
        </span>
      </p>

      <p className="mt-3 max-w-2xl text-sm text-ink-2">
        {unmarked
          ? "Every record on this agent was written without a mark. There is nothing here to judge on, whatever number the registry prints beside it."
          : captured
            ? "One address wrote most of what is here. That is not proof of anything — a scheduled uptime prober looks exactly like this — but it is one party's opinion rather than a market's, and it is worth knowing which before granting a spend cap."
            : "Several separate addresses marked this agent. That is as close to a track record as ERC-8004 currently gets on BSC."}
      </p>

      <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <Row label="Records held">
          <span className="tnum">{r.total.toLocaleString()}</span>
        </Row>
        <Row label="Carrying a mark">
          <span className="tnum">
            {r.valued} of {r.sampled} read
          </span>
        </Row>
        {/* 8004scan's own normalised field, which is what an `average_score`
            is computed from. Null on 1,192 of 1,200 sampled chain-wide, so the
            gap between this row and the one above is the gap between the marks
            that exist and the marks the ecosystem averages. */}
        <Row label="In the registry's score field">
          <span className="tnum">
            {r.scored} of {r.sampled}
          </span>
        </Row>
        <Row label="Carrying a comment">
          <span className="tnum">{r.commented}</span>
        </Row>
        <Row label="Distinct writers">
          <span className="tnum">{r.raters}</span>
        </Row>
        {r.revoked > 0 && (
          <Row label="Withdrawn">
            <span className="tnum">{r.revoked}</span>
          </Row>
        )}
        {r.topRater && (
          <Row label="Busiest writer">
            <a
              href={`https://bscscan.com/address/${r.topRater}`}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all underline hover:text-ink"
            >
              {r.topRater.slice(0, 10)}…{r.topRater.slice(-6)}
            </a>
            <span className="ml-2 tnum text-ink-3">{Math.round(r.topRaterShare * 100)}%</span>
          </Row>
        )}
      </dl>
    </section>
  );
}

function PaymentTerms({ check }: { check: X402Check }) {
  const charged = check.demanded;
  return (
    <section className="border-b border-rule py-8">
      <h2 className="label">We asked it to charge us</h2>
      <p className="mt-3 flex flex-wrap items-baseline gap-3">
        <span
          className="text-2xl font-semibold tracking-tight"
          style={{ color: charged ? "var(--seat-yield)" : "var(--brass)" }}
        >
          {charged ? "Quotes a price" : "Claims x402, asked for nothing"}
        </span>
      </p>

      <p className="mt-3 max-w-2xl text-sm text-ink-2">
        {charged
          ? "Kawal sent the request an x402 client sends first — no payment header — and the server answered 402 with terms. Kawal read them and paid nothing."
          : "This registration sets the x402 flag. Kawal sent the opening request of the protocol and the server answered without demanding payment, so the flag is unverified here. It may still charge by a route this request cannot see."}
      </p>

      {check.quote && (
        <p className="mt-4 border-l-2 pl-3 text-sm" style={{ borderColor: "var(--brass)" }}>
          {/* The server's own sentence. Kawal does not recompute a price from
              atomic units it has no decimals for. */}
          &ldquo;{check.quote}&rdquo;
        </p>
      )}

      <dl className="mt-5 grid gap-x-8 gap-y-2 sm:grid-cols-2">
        {check.serviceName && <Row label="Service">{check.serviceName}</Row>}
        {check.x402Version !== null && <Row label="x402 version">{String(check.x402Version)}</Row>}
        <Row label="Answered">HTTP {String(check.status)}</Row>
        {check.accepts.map((a, i) => (
          <Fragment key={`${a.network}-${a.asset}-${i}`}>
            <Row label="Network">{networkName(a.network)}</Row>
            <Row label="Asset">{a.asset}</Row>
            <Row label="Amount">{a.amount} atomic units</Row>
            <Row label="Pays to">{a.payTo}</Row>
            {a.maxTimeoutSeconds !== null && (
              <Row label="Settle within">{a.maxTimeoutSeconds} s</Row>
            )}
          </Fragment>
        ))}
        {!charged && check.error && <Row label="Result">{check.error}</Row>}
      </dl>

      <p className="label mt-4">
        Asked at {check.checkedAt.replace("T", " ").slice(0, 19)} UTC · Kawal never
        settles a payment on a visitor&rsquo;s behalf
      </p>
    </section>
  );
}

function LiveProbe({ proof, uptime }: { proof: EndpointProof; uptime: Uptime | null }) {
  const good = proof.isMcp;
  const desc = proof.descriptor;

  /*
   * Three outcomes, not two. An endpoint that fails the handshake is usually
   * broken, but sometimes it is software that was never meant to be called
   * over HTTP — a stdio server published with an install command, or a source
   * repository. Filing those under "No answer" was Kawal saying an agent could
   * not be hired when it plainly can, which is the same failure as trusting
   * the registry, pointed the other way.
   *
   * So they get brass rather than the failure colour: this is a fact about
   * how the agent is reached, not a verdict against it.
   */
  const headline = good
    ? "Answers MCP"
    : desc?.kind === "service-descriptor"
      ? "Runs locally, not hosted"
      : desc?.kind === "source-repository"
        ? "Published as source"
        : proof.reachable
          ? "Responds, but not MCP"
          : "No answer";

  const colour = good
    ? "var(--seat-yield)"
    : desc
      ? "var(--brass)"
      : "var(--seat-health)";

  return (
    <section className="border-b border-rule py-8">
      <h2 className="label">We just called it</h2>
      <p className="mt-3 flex flex-wrap items-baseline gap-3">
        <span className="text-2xl font-semibold tracking-tight" style={{ color: colour }}>
          {headline}
        </span>
        <span className="tnum label">{proof.latencyMs} ms</span>
      </p>

      {desc && (
        <p className="mt-3 max-w-2xl text-sm text-ink-2">
          {desc.kind === "service-descriptor"
            ? `This URL is not a server. It publishes an ERC-8004 service descriptor: the agent is real and its tools are listed below, but it is spoken to over ${desc.transport ?? "another transport"} after you install it — not over the network. A spend cap cannot be enforced on a call Kawal never carries, so this agent is listed and not seated.`
            : "The registration points at a source repository rather than a running endpoint. The code is real and installable; there is nothing at this address to call, so Kawal makes no claim about uptime."}
        </p>
      )}

      <dl className="mt-5 grid gap-x-8 gap-y-2 sm:grid-cols-2">
        <Row label="Endpoint">{proof.endpoint}</Row>
        {proof.serverName && <Row label="Server">{proof.serverName}</Row>}
        {proof.protocolVersion && <Row label="Protocol">{proof.protocolVersion}</Row>}
        {proof.toolCount !== null && (
          <Row label="Tools offered">{String(proof.toolCount)}</Row>
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
      {(() => {
        if (desc || !proof.error) return null;
        const d = diagnose(proof.error);
        if (!d || d.failure === "unknown") return null;
        return (
          <p className="mt-5 border-l-2 pl-3 text-sm" style={{ borderColor: "var(--seat-health)" }}>
            <span className="font-semibold">{failureLabel(d.failure)}.</span>{" "}
            <span className="text-ink-2">{d.summary}</span>
            {d.transient && (
              <span className="text-ink-3"> A later check may pass.</span>
            )}
          </p>
        );
      })()}

      {/* Says "at most a minute" rather than "live" because proofs are reused
          for 60s. Claiming freshness the code does not deliver would be the
          same kind of unearned confidence this page exists to strip out. */}
      {/* Suppressed for a descriptor even when rows exist: they were written
          before Kawal could tell a non-server from a dead one, and "0 of 4
          answered" beside "runs locally" reads as unreliability rather than
          as a category error on our side. */}
      {uptime && uptime.checks > 1 && !desc && (
        <p className="mt-5 border-l-2 pl-3 text-sm" style={{ borderColor: "var(--brass)" }}>
          {/* One reading says an agent answered once. This says whether it
              keeps answering, which is the question behind a spend cap.
              Nothing in the ecosystem publishes it — Kawal is already making
              the calls, so it keeps them. */}
          <span className="tnum font-semibold">
            {uptime.answered} of {uptime.checks}
          </span>{" "}
          checks answered since{" "}
          {new Date(uptime.since * 1000).toISOString().slice(0, 10)}
          {uptime.medianMs !== null && (
            <span className="text-ink-3">
              {" "}
              · median {uptime.medianMs} ms
              {uptime.worstMs !== null && uptime.worstMs > uptime.medianMs
                ? `, slowest ${uptime.worstMs} ms`
                : ""}
            </span>
          )}
        </p>
      )}

      {/* What this measurement cannot see.
          Kawal probes from one place, so it cannot tell "the agent is down"
          from "the agent is unreachable from here" — an agent that geo-blocks
          or ASN-blocks this prober is indistinguishable from one that is
          broken. GEBO, the uptime agent writing feedback into this same
          registry, publishes the identical defect about itself; borrowing the
          habit costs nothing and a reliability figure with no stated blind
          spot is asking to be over-trusted. */}
      {uptime && uptime.checks > 1 && !desc && uptime.answered < uptime.checks && (
        <p className="mt-3 max-w-2xl text-sm text-ink-3">
          Measured from a single vantage point. A missed check means Kawal could
          not reach it from here, which is not the same as the agent being down.
        </p>
      )}

      {proof.tools.length > 0 && <ToolTable tools={proof.tools} total={proof.toolCount ?? 0} />}

      {/* The limit of Kawal's own claim, stated where the claim is made.
          `hireable` means the endpoint completed an MCP handshake and listed
          its tools. It does not mean any of those tools work: an agent that
          answers `initialize`, names sixteen tools and errors on every one of
          them scores exactly like an agent that does the job. Kawal is strict
          about everyone else's unverified claims, and this is its own — so it
          says so rather than deepening the probe by running strangers' tools
          uninvited, which could cost them money or have side effects. */}
      {proof.isMcp && (
        <p className="mt-4 max-w-2xl text-sm text-ink-3">
          Kawal completed the handshake and read the tool list. It did not run
          any of them — executing a stranger&rsquo;s tool uninvited can cost them
          money or move something. So this is evidence the agent answers, not
          that it works.
        </p>
      )}

      <p className="label mt-4">
        {desc?.kind === "source-repository"
          ? `Read from the registration at ${proof.checkedAt.replace("T", " ").slice(0, 19)} UTC · no request was sent to a repository host`
          : `Kawal called this endpoint at ${proof.checkedAt.replace("T", " ").slice(0, 19)} UTC`}
        {desc?.kind !== "source-repository" &&
          " · at most a minute old, never from the registry’s cache"}
      </p>
    </section>
  );
}

/**
 * Which way the score has been going, which a snapshot cannot show.
 *
 * A 30 that has been climbing and a 30 that has been sliding are different
 * propositions, and the registry only ever displays the number. Most BSC
 * registrations have no history at all — thousands arrive daily — so "not
 * enough history yet" is the common answer and a signal in itself: nothing
 * has been observed about this agent over time.
 */
function Trajectory({ history }: { history: ScoreHistory }) {
  const points = [...history.history].reverse();
  const change = history.score_change;

  const direction =
    change === null || points.length < 2
      ? null
      : change > 0.5
        ? { label: "rising", color: "var(--seat-yield)" }
        : change < -0.5
          ? { label: "falling", color: "var(--seat-health)" }
          : { label: "flat", color: "var(--ink-3)" };

  return (
    <section className="border-b border-rule py-8">
      <h2 className="label">Which way it is going</h2>

      {points.length < 2 ? (
        <p className="mt-3 text-ink-2">
          Not enough history yet — 8004scan has scored this agent on{" "}
          {history.data_points} day{history.data_points === 1 ? "" : "s"}. New
          registrations arrive on BSC by the thousand, so most have no record
          to read.
        </p>
      ) : (
        <>
          <p className="mt-3 flex flex-wrap items-baseline gap-3">
            <span className="text-2xl font-semibold tracking-tight" style={{ color: direction?.color }}>
              {direction?.label}
            </span>
            <span className="tnum label">
              {change! >= 0 ? "+" : ""}
              {change!.toFixed(2)} over {history.period_days} days ·{" "}
              {history.data_points} readings
            </span>
          </p>
          <Sparkline values={points.map((p) => p.total_score)} />
          <p className="label mt-2">
            {points.at(0)?.scored_at.slice(0, 10)} → {points.at(-1)?.scored_at.slice(0, 10)}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * A score line, drawn as SVG rather than pulled from a charting library.
 *
 * Thirty numbers and one path element do not justify a dependency, and an
 * inline SVG renders on the server with no client JavaScript at all.
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
      className="mt-4 w-full max-w-sm"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Score from ${min.toFixed(2)} to ${max.toFixed(2)} over ${values.length} readings`}
    >
      <path d={d} fill="none" stroke="var(--brass)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * What this agent will actually do, and what it says that costs.
 *
 * 8004scan has no price field anywhere, and price is the first question
 * anyone deciding whether to hire has. Agents put it in the tool description
 * themselves — "Free.", "Paid (0.2 BNB on BSC)" — so the listing reads it
 * back rather than pretending the question does not exist.
 *
 * Labelled "declares" throughout: the agent is making the claim, Kawal is
 * only refusing to hide it. Nothing here has been paid or verified.
 */
function ToolTable({ tools, total }: { tools: ProbedTool[]; total: number }) {
  const priced = tools.filter((t) => t.declaredPrice);

  return (
    <div className="mt-6">
      <h3 className="label">
        What you can ask it · {total} tool{total === 1 ? "" : "s"}
        {priced.length > 0 && ` · ${priced.length} declares a price`}
      </h3>

      <ul className="mt-3 divide-y divide-rule border-y border-rule">
        {tools.map((t) => (
          <li key={t.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
            <span className="tnum font-mono text-sm">{t.name}</span>

            {t.declaredPrice ? (
              <span
                className="label rounded-sm border px-1.5 py-0.5"
                style={{ borderColor: "var(--brass)", color: "var(--brass)" }}
              >
                declares {t.declaredPrice.amount} {t.declaredPrice.token}
              </span>
            ) : t.declaredFree ? (
              <span className="label">declares free</span>
            ) : null}

            {t.description && (
              <span className="min-w-0 flex-1 text-sm text-ink-3">
                {t.description.length > 110 ? `${t.description.slice(0, 110)}…` : t.description}
              </span>
            )}
          </li>
        ))}
      </ul>

      {total > tools.length && (
        <p className="label mt-2">
          showing {tools.length} of {total}
        </p>
      )}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  healthy: "var(--seat-yield)",
  degraded: "var(--brass)",
  unhealthy: "var(--seat-health)",
  unknown: "var(--ink-3)",
};

function ServiceCard({ service }: { service: ServiceHealth }) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: STATUS_COLOR[service.status] ?? "var(--ink-3)" }}
        />
        <span className="label">{service.label}</span>
        {service.latency_ms !== null && (
          <span className="label tnum ml-auto">{Math.round(service.latency_ms)} ms</span>
        )}
      </div>

      {service.message && <p className="mt-1.5 text-sm text-ink-2">{service.message}</p>}

      {service.domain && (
        <p className="tnum mt-2 break-all font-mono text-xs text-ink-3">
          {service.domain}
          {/* Answering and being provably yours are different claims, and a
              user hiring an agent deserves to see the second one fail. */}
          {service.domain_verified ? (
            <span className="ml-2 text-ink-2">domain verified</span>
          ) : (
            <span className="ml-2" style={{ color: "var(--seat-health)" }}>
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
  const tone =
    flag.severity === "critical" || flag.severity === "high"
      ? "var(--seat-health)"
      : flag.severity === "medium"
        ? "var(--brass)"
        : "var(--ink-3)";
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-1.5 h-3 w-[3px] flex-none rounded-sm" style={{ background: tone }} />
      <div>
        <p className="text-sm font-medium">
          {flag.title}
          <span className="label ml-2">{flag.severity}</span>
        </p>
        <p className="text-sm text-ink-2">{flag.description}</p>
      </div>
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-rule pb-3">
      <dt className="label">{label}</dt>
      <dd className="tnum mt-1 break-all font-mono text-sm text-ink-2">{children}</dd>
    </div>
  );
}
