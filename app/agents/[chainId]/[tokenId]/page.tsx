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
import { rpcOutcomeLabel } from "@/lib/a2a";
import { classify } from "@/lib/taxonomy";
import { assess, tierLabel } from "@/lib/signals";
import { categoryLabel, seatColor, Stamp, Tally, Legend, tierInk } from "@/components/listing";

/*
 * Form K-3: the inspection sheet for one agent.
 *
 * Every section is a block of the same form. The registry's entries are
 * typed into cells and labelled as the registry's; Kawal's own findings are
 * stamped, with the count behind each stamp printed in it and its blind spot
 * printed under it.
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
 * the 5-minute cache, so this costs no extra upstream call.
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
    agent.x402_supported === true && proof?.endpoint ? await checkX402Cached(proof.endpoint) : null;

  const classification = classify(agent.name, agent.description);
  // The registry's claim, reconciled with what Kawal has actually seen. An
  // endpoint called repeatedly and never reached is not hireable, whatever
  // the registration says — but an agent that published a stdio route or a
  // repository answered us, so it is not the silent case either.
  const observed = await observedFor(proof?.endpoint);
  const assessment = assess(
    agent,
    undefined,
    observed && { ...observed, reachedAnotherWay: proof?.descriptor != null },
    payment ? { demanded: payment.demanded } : undefined,
    reputation,
  );
  const registered = new Date(agent.created_at);
  const uptime = proof ? await uptimeFor(proof.endpoint) : null;
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
          <span className="cap">Form K-3 · lembar pemeriksaan · inspection sheet</span>
          <span className="serial text-[0.85rem]">No. {agent.chain_id}:{agent.token_id}</span>
          <span className="cap">Diperiksa · {new Date().toISOString().slice(0, 10)}</span>
        </div>

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
            <Stamp ink={tierInk(assessment.tier)} evidence={uptime?.checks ?? null} size="lg">
              {assessment.tier === "hireable"
                ? "Telah diperiksa"
                : assessment.tier === "reachable"
                  ? "Diterima"
                  : assessment.tier === "unreachable"
                    ? "Ditolak"
                    : "Belum diperiksa"}
            </Stamp>
          </div>
        </header>

        {/* --------------------------------------------- can you hire it --- */}
        <section className="border-b-[1.5px] border-rule px-5 py-6">
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
        </section>

        {proof && <LiveProbe proof={proof} uptime={uptime} />}

        {payment && <PaymentTerms check={payment} />}

        {/* `sampled`, not `total`. A 200 carrying a total and no readable items
            — a shape change upstream, a truncated response — would otherwise
            render "every record was written without a mark" about records
            Kawal never read. Saying nothing is the honest output of reading
            nothing. */}
        {reputation && reputation.sampled > 0 && <TrackRecord r={reputation} />}

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

        {quality && quality.score.dimensions.length > 0 && (
          <section className="border-b-[1.5px] border-rule px-5 py-6">
            <h2 className="cap">
              How 8004scan scores it · {quality.score.total_score.toFixed(2)} total
              {quality.score.version && ` · v${quality.score.version}`}
            </h2>
            <dl className="mt-3 space-y-2">
              {quality.score.dimensions.map((d) => (
                <div key={d.key} className="grid grid-cols-[7rem_minmax(0,1fr)_7rem] items-center gap-3">
                  <dt className="cap !mb-0">{d.label}</dt>
                  <dd className="h-[10px] border border-rule bg-paper-white">
                    <span
                      className="block h-full bg-carbon"
                      style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }}
                    />
                  </dd>
                  <dd className="typed text-right text-[0.8rem] text-carbon-3">
                    {d.score.toFixed(1)} × {d.weight}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <section className="px-5 py-6">
          <h2 className="cap">Registration · the registry&rsquo;s entries</h2>
          <dl className="cells mt-3 sm:grid-cols-2">
            <Row label="Identity">{agent.agent_id}</Row>
            <Row label="Owner">{agent.owner_ens ?? agent.owner_address}</Row>
            <Row label="Agent wallet">{agent.agent_wallet ?? "not published"}</Row>
            <Row label="Registered">{registered.toISOString().slice(0, 10)}</Row>
            <Row label="Protocols">{agent.supported_protocols.join(", ").toUpperCase() || "none declared"}</Row>
            <Row label="Reputation">
              score {agent.total_score.toFixed(2)} · {agent.total_feedbacks} feedbacks · {agent.star_count} stars
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
            { mark: <Stamp ink="stamp-violet" size="sm" flat>Telah diperiksa</Stamp>, means: "Kawal's own mark; the ink prints darker with more probes behind it" },
            { mark: <Stamp ink="stamp-red" size="sm" flat>Ditolak</Stamp>, means: "called at least three times, never answered" },
            { mark: <span aria-hidden className="tally"><i className="on" /><i /><i className="new" /></span>, means: "tally strip: punched = answered, blank = silent, outlined = newest" },
          ]}
        />
      </div>
    </div>
  );
}

function LiveProbe({ proof, uptime }: { proof: EndpointProof; uptime: Uptime | null }) {
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

  const ink = good ? "stamp-violet" : desc ? "stamp-blue" : proof.reachable ? "stamp-blue" : "stamp-red";
  const stampText = good ? "Telah diperiksa" : desc ? "Diterima" : proof.reachable ? "Diterima" : "Ditolak";
  const failure = !desc && proof.error ? diagnose(proof.error) : null;

  return (
    <section className="border-b-[1.5px] border-rule px-5 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="cap">We just called it</h2>
          <p className="typed mt-2 text-[1.6rem] font-bold leading-tight">
            {headline}
            <span className="ml-3 text-[0.85rem] font-normal text-carbon-3">{proof.latencyMs} ms</span>
          </p>
        </div>
        <Stamp ink={ink} evidence={uptime?.checks ?? null}>
          {stampText}
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
          <Tally answered={uptime.answered} checks={uptime.checks} />
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
        <Stamp ink={charged ? "stamp-green" : "stamp-grey"}>{charged ? "Bertarif" : "Tanpa tagihan"}</Stamp>
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
          {unmarked ? "Kosong" : captured ? "Satu sumber" : "Beberapa sumber"}
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
      </dl>
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

      <ul className="mt-2 border-y-[1.5px] border-rule">
        {tools.map((t) => (
          <li key={t.name} className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-rule-soft py-2 last:border-b-0 sm:grid-cols-[14rem_auto_minmax(0,1fr)]">
            <span className="typed text-[0.9rem] font-bold">{t.name}</span>
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
              <span className="typed min-w-0 text-[0.85rem] text-carbon-3">
                {t.description.length > 110 ? `${t.description.slice(0, 110)}…` : t.description}
              </span>
            )}
          </li>
        ))}
      </ul>

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
