import Link from "next/link";
import { getAgent, getQuality, getScoreHistory } from "@/lib/scan";
import { proveAgent, type EndpointProof } from "@/lib/probe";
import { uptimeFor, observedFor, type Uptime } from "@/lib/uptime";
import { classify } from "@/lib/taxonomy";
import { assess, tierLabel, type Assessment } from "@/lib/signals";
import { categoryLabel, seatColor } from "@/components/listing";
import type { ScanAgentDetail, AgentQuality, ScoreHistory } from "@/lib/scan";

/**
 * Two or three agents, the same questions asked of each.
 *
 * The rubric asks that a user "make a genuinely informed call", and a single
 * agent page cannot do that — judging one in isolation means holding the
 * alternatives in your head. Every row here is a question someone actually
 * weighs before handing over a spend cap: can it be called, does it answer
 * right now, how fast, what will it do, what does it say that costs, and what
 * is being held against it.
 *
 * Deliberately shows the disagreements rather than a combined score. A single
 * number would hide exactly the thing worth seeing: an agent can be the
 * fastest, the best rated, and still be the one whose domain does not verify.
 */

const MAX_COLUMNS = 3;

type Column = {
  ref: string;
  color: string;
  agent: ScanAgentDetail;
  quality: AgentQuality | null;
  history: ScoreHistory | null;
  proof: EndpointProof | null;
  uptime: Uptime | null;
  assessment: Assessment;
  category: string;
  confidence: number;
};

/** Parses "56:43129,56:45422" into chain/token pairs, dropping anything odd. */
function parseRefs(raw: string | string[] | undefined): Array<{ chainId: number; tokenId: string }> {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return [];

  const seen = new Set<string>();
  const out: Array<{ chainId: number; tokenId: string }> = [];
  for (const part of value.split(",")) {
    const [chain, token] = part.trim().split(":");
    const chainId = Number(chain);
    if (!Number.isInteger(chainId) || chainId <= 0) continue;
    if (!token || !/^\d+$/.test(token)) continue;
    const key = `${chainId}:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chainId, tokenId: token });
    if (out.length === MAX_COLUMNS) break;
  }
  return out;
}

async function loadColumn(chainId: number, tokenId: string): Promise<Column | null> {
  const agent = await getAgent(chainId, tokenId).catch(() => null);
  if (!agent) return null;

  const [quality, proof, history] = await Promise.all([
    getQuality(chainId, tokenId),
    proveAgent(agent),
    getScoreHistory(chainId, tokenId),
  ]);

  const classification = classify(agent.name, agent.description);
  return {
    ref: `${chainId}:${tokenId}`,
    agent,
    quality,
    proof,
    uptime: proof ? uptimeFor(proof.endpoint) : null,
    history,
    assessment: assess(agent, undefined, observedFor(proof?.endpoint)),
    category: categoryLabel(classification.category),
    confidence: classification.confidence,
    // The seat colour a buyer is filling, so the category stays visible in
    // the header rather than being a word in a table.
    color: seatColor(classification.category),
  };
}

export const metadata = {
  title: "Compare agents — Kawal",
  description: "Put two or three BNB Chain agents side by side before hiring one.",
};

export default async function ComparePage({ searchParams }: PageProps<"/compare">) {
  const params = await searchParams;
  const refs = parseRefs(params.ids);

  const columns = (await Promise.all(refs.map((r) => loadColumn(r.chainId, r.tokenId)))).filter(
    (c): c is Column => c !== null,
  );

  if (columns.length === 0) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-[-0.03em]">Compare agents</h1>
        <p className="mt-3 max-w-xl text-ink-2">
          Pick agents from a category listing and open them here together. The
          address bar takes them as{" "}
          <code className="font-mono text-sm">?ids=56:43129,56:45422</code>.
        </p>
        <p className="label mt-8">
          <Link href="/agents" className="hover:text-ink">
            ← Browse agents
          </Link>
        </p>
      </div>
    );
  }

  const missing = refs.length - columns.length;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12">
      <header>
        <p className="label">Side by side</p>
        <h1 className="mt-3 text-3xl font-bold tracking-[-0.03em]">
          {columns.map((c) => c.agent.name).join("  ·  ")}
        </h1>
        {missing > 0 && (
          <p className="label mt-3">
            {missing} of the requested agents could not be loaded and are not shown.
          </p>
        )}
      </header>

      <div className="mt-10 overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              <th className="label w-40 border-b border-rule pb-3 align-bottom">Question</th>
              {columns.map((c) => (
                <th key={c.ref} className="border-b border-rule pb-3 pl-6 align-bottom">
                  <Link
                    href={`/agents/${c.agent.chain_id}/${c.agent.token_id}`}
                    className="text-base font-semibold tracking-tight hover:text-brass"
                  >
                    {c.agent.name}
                  </Link>
                  <span className="label mt-1 flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-3 w-[3px] rounded-sm"
                      style={{ background: c.color }}
                    />
                    {c.category} · {Math.round(c.confidence * 100)}%
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            <Row label="Can you hire it" columns={columns}>
              {(c) => (
                <span className={c.assessment.tier === "hireable" ? "text-brass" : ""}>
                  {tierLabel(c.assessment.tier)}
                </span>
              )}
            </Row>

            <Row label="Answers right now" columns={columns}>
              {(c) =>
                !c.proof ? (
                  <span className="text-ink-3">no MCP or A2A endpoint declared</span>
                ) : c.proof.answered ? (
                  <span style={{ color: "var(--seat-yield)" }}>
                    yes, {c.proof.protocol.toUpperCase()} in {c.proof.latencyMs} ms
                  </span>
                ) : (
                  <span style={{ color: "var(--seat-health)" }}>
                    no — {c.proof.error?.slice(0, 60) ?? "did not answer"}
                  </span>
                )
              }
            </Row>

            <Row label="Keeps answering" columns={columns}>
              {(c) =>
                !c.uptime || c.uptime.checks < 2 ? (
                  <span className="text-ink-3">only one check so far</span>
                ) : (
                  <span className="tnum">
                    {c.uptime.answered}/{c.uptime.checks} since{" "}
                    {new Date(c.uptime.since * 1000).toISOString().slice(0, 10)}
                    {c.uptime.medianMs !== null && ` · median ${c.uptime.medianMs} ms`}
                  </span>
                )
              }
            </Row>

            <Row label="What it can do" columns={columns}>
              {(c) =>
                c.proof?.toolCount ? (
                  <span className="tnum">{c.proof.toolCount} tools</span>
                ) : (
                  <span className="text-ink-3">nothing listed</span>
                )
              }
            </Row>

            <Row label="Declared price" columns={columns}>
              {(c) => {
                const priced = c.proof?.tools.filter((t) => t.declaredPrice) ?? [];
                if (priced.length === 0) {
                  const free = c.proof?.tools.some((t) => t.declaredFree);
                  return (
                    <span className="text-ink-3">{free ? "declares free" : "not stated"}</span>
                  );
                }
                return (
                  <span className="text-brass">
                    {priced
                      .map((t) => `${t.declaredPrice!.amount} ${t.declaredPrice!.token}`)
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .join(", ")}
                  </span>
                );
              }}
            </Row>

            <Row label="Domain proven" columns={columns}>
              {(c) => {
                const services = c.quality?.endpoint_health?.services ?? [];
                const checked = services.filter((s) => s.status !== "skipped");
                if (checked.length === 0) return <span className="text-ink-3">not checked</span>;
                const verified = checked.filter((s) => s.domain_verified).length;
                return verified === checked.length ? (
                  <span style={{ color: "var(--seat-yield)" }}>all {checked.length}</span>
                ) : (
                  <span style={{ color: "var(--seat-health)" }}>
                    {verified} of {checked.length}
                  </span>
                );
              }}
            </Row>

            <Row label="Track record" columns={columns}>
              {(c) => (
                <span className="tnum">
                  {c.agent.total_feedbacks === 0
                    ? "never rated"
                    : `${c.agent.total_feedbacks} feedbacks, avg ${c.agent.average_score.toFixed(1)}`}
                </span>
              )}
            </Row>

            <Row label="Score trend" columns={columns}>
              {(c) => {
                const h = c.history;
                if (!h || h.data_points < 2 || h.score_change === null) {
                  return <span className="text-ink-3">no history yet</span>;
                }
                const up = h.score_change > 0.5;
                const down = h.score_change < -0.5;
                return (
                  <span
                    className="tnum"
                    style={{
                      color: up
                        ? "var(--seat-yield)"
                        : down
                          ? "var(--seat-health)"
                          : undefined,
                    }}
                  >
                    {up ? "rising" : down ? "falling" : "flat"} ({h.score_change >= 0 ? "+" : ""}
                    {h.score_change.toFixed(2)} / {h.period_days}d)
                  </span>
                );
              }}
            </Row>

            <Row label="Registry score" columns={columns}>
              {(c) => <span className="tnum">{c.agent.total_score.toFixed(2)}</span>}
            </Row>

            <Row label="Flagged risks" columns={columns}>
              {(c) => {
                const flags = c.quality?.risk_flags ?? [];
                if (flags.length === 0) return <span className="text-ink-3">none</span>;
                return (
                  <ul className="space-y-1">
                    {flags.slice(0, 4).map((f) => (
                      <li key={f.id} className="text-sm">
                        <span className="label mr-2">{f.severity}</span>
                        {f.title}
                      </li>
                    ))}
                  </ul>
                );
              }}
            </Row>

            <Row label="Registered" columns={columns}>
              {(c) => (
                <span className="tnum font-mono text-xs">
                  {new Date(c.agent.created_at).toISOString().slice(0, 10)}
                </span>
              )}
            </Row>
          </tbody>
        </table>
      </div>

      <p className="mt-8 max-w-2xl text-sm text-ink-3">
        Prices are what each agent states in its own tool descriptions. Nothing
        here has been paid or independently confirmed — 8004scan carries no
        price field at all, so this is the agent&rsquo;s claim, surfaced rather
        than hidden.
      </p>

      <p className="label mt-8">
        <Link href="/agents" className="hover:text-ink">
          ← Back to the listing
        </Link>
      </p>
    </div>
  );
}

function Row({
  label,
  columns,
  children,
}: {
  label: string;
  columns: Column[];
  children: (c: Column) => React.ReactNode;
}) {
  return (
    <tr className="border-b border-rule align-top">
      <th scope="row" className="label py-4 pr-4 font-normal">
        {label}
      </th>
      {columns.map((c) => (
        <td key={c.ref} className="py-4 pl-6 text-sm">
          {children(c)}
        </td>
      ))}
    </tr>
  );
}
