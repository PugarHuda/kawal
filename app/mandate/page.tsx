import Link from "next/link";
import { connection } from "next/server";
import { formatEther, formatUnits, keccak256 } from "viem";
import {
  planMandate,
  preempt,
  narrowingFactor,
  preemptReason,
  usdtToRaw,
  SEAT_POLICIES,
  VENUES,
  USDT_BSC,
  MAX_PLANNER_CAPITAL,
  HEALTH_FLOOR,
  UnsafeMandateError,
  MAX_DURATION_DAYS,
  type SessionPlan,
  type Preemption,
} from "@/lib/mandate";
import { BSC_MAINNET } from "@/lib/chains";
import { getAgent } from "@/lib/scan";
import type { CategoryId } from "@/lib/taxonomy";
import { seatColor, Stamp, Legend } from "@/components/listing";
import { loadLedger, isLive, walletHoldings, hasAdminKey, type LedgerSeat } from "@/lib/sessions";
import { explorerTx } from "@/lib/altana";
import { revokeAction, unlockAction, lockAction, grantAction } from "./actions";
import { isOperator, operatorConfigured } from "@/lib/operator";
import { readHealth, effectiveHealthFactor, describeHealth, type HealthReading } from "./health";

/*
 * Form K-5: the mandate.
 *
 * A spend cap is the product's whole value, so on this form it is the box
 * every other line points at: "TIDAK MELEBIHI · not to exceed", typed in the
 * seat's own ink. Sessions that exist on-chain are a separate, stamped sheet
 * above the planner; everything below the fold is a plan and says so.
 */

/**
 * A revocation that landed on BSC mainnet, clicked from this control room.
 * Shown to a visitor who cannot revoke here, as proof the stub does what it
 * says where the key lives. The ledger's own `revokeTx` is preferred when
 * this instance has one; this is the fallback recorded in README.md.
 */
const PROVEN_REVOCATION_TX = "0x229e41f27369f8ab8c7d9619c1a0118a6d3d126ec8c93ccfd99f8fee15b6f6ec" as const;

/** Altana's own explorer, which reads the KeyStore rather than the chain. */
const ALTANA_EXPLORER = "https://explorer.altana.network";

/**
 * Raw USDT to a typed figure: whole numbers plain, fractions to the cent.
 *
 * `formatUnits` rather than integer division, which truncated 17,500.50 to
 * 17,500 and printed a cap the seat did not have. The whole part goes through
 * BigInt so a trillion-USDT planner line stays exact.
 */
function fromRaw(raw: bigint) {
  const [whole = "0", fraction = ""] = formatUnits(raw, 18).split(".");
  const cents = fraction.slice(0, 2).padEnd(2, "0");
  const typed = BigInt(whole).toLocaleString("en-US");
  return cents === "00" ? typed : `${typed}.${cents}`;
}

/** `0x1234…abcd`: enough to tell two keys apart, short enough for a cell. */
function short(hex: string) {
  return hex.length > 14 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

/**
 * The current Unix second, read as request-time data rather than during
 * render. `connection()` is Next's marker for "this render genuinely depends
 * on the request", which is exactly what reading a clock is.
 */
async function requestTime() {
  await connection();
  return Math.floor(Date.now() / 1000);
}

/**
 * Reads one number out of a query string, clamped. A `max` attribute on the
 * input is a hint to a browser, not a constraint on a URL anyone can type.
 */
function num(v: string | string[] | undefined, fallback: number, max: number) {
  const n = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

const SEAT_IDS = new Set<string>(SEAT_POLICIES.map((p) => p.category));

/**
 * `?seat=yield&agent=56:43129`, as the agent page's "Hire under a cap" stub
 * sends it. Either half may be missing or wrong; the form still plans.
 */
function hiring(params: Record<string, string | string[] | undefined>) {
  const seat = typeof params.seat === "string" && SEAT_IDS.has(params.seat) ? (params.seat as CategoryId) : null;
  const ref = typeof params.agent === "string" ? params.agent.match(/^(\d+):(\d+)$/) : null;
  return { seat, agent: ref ? { chainId: Number(ref[1]), tokenId: ref[2]! } : null };
}

export const metadata = {
  title: "Mandate",
  description:
    "Four seats, four session keys on Altana, none able to reach the others. Spend caps, allowlists, expiry and revocation for every agent you hire.",
};

export default async function MandatePage({ searchParams }: PageProps<"/mandate">) {
  const params = await searchParams;
  const capital = num(params.capital, 10_000, MAX_PLANNER_CAPITAL);
  const days = Math.round(num(params.days, 30, MAX_DURATION_DAYS));
  const hire = hiring(params);

  // Read once and threaded down. planMandate already takes `now` so a plan is
  // reproducible; a second read inside a child bought nothing and could
  // disagree with this one across a second boundary.
  const now = await requestTime();

  let plans: SessionPlan[] = [];
  let error: string | null = null;
  // A refusal and a crash must not read the same. The whole point of
  // planMandate is that it says why it will not build a session; folding an
  // unexpected exception into that same sentence would hide a bug behind a
  // policy message.
  let unexpected = false;
  try {
    plans = planMandate({
      chainId: BSC_MAINNET,
      capital: usdtToRaw(capital),
      token: USDT_BSC,
      durationDays: days,
      now,
    });
  } catch (e) {
    if (e instanceof UnsafeMandateError) {
      error = e.message;
    } else {
      unexpected = true;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // The seat being filled goes first; the rest keep their priority order.
  if (hire.seat) plans = [...plans.filter((p) => p.category === hire.seat), ...plans.filter((p) => p.category !== hire.seat)];

  const committed = plans.reduce((s, p) => s + (p.permissions.spend?.[0]?.limit ?? 0n), 0n);

  // Sessions that were actually granted on-chain, if this machine has run
  // `npm run onchain`. Everything below the form is a plan; this is not.
  const ledger = await loadLedger();

  // Revoking destroys a KeyStore registration for good, so the button only
  // exists for a caller who proved they are the operator. The action checks
  // this again on its own — a hidden button is not access control.
  const [operator, configured] = await Promise.all([isOperator(), operatorConfigured()]);
  // Holding the token is permission; holding the key is capability. A page
  // that offers a button it cannot honour is a dead end dressed as a control.
  const canRevoke = hasAdminKey();

  const firstSeat = ledger[0];
  // Three reads that can each fail on their own: the wallet balance, the
  // wallet's lending position, and the agent named in the URL. None of them
  // is allowed to take the planner down with it.
  const [holdings, health, agent] = await Promise.all([
    firstSeat ? walletHoldings(firstSeat.chainId, firstSeat.walletAddress) : null,
    firstSeat ? readHealth(firstSeat.chainId, firstSeat.walletAddress).catch(() => null) : null,
    hire.agent ? getAgent(hire.agent.chainId, hire.agent.tokenId).catch(() => null) : null,
  ]);

  // The cut, from the wallet's position rather than from a sentence. With no
  // mandate wallet there is no position to read, and the form says so.
  const healthFactor = health ? effectiveHealthFactor(health) : null;
  const factor = healthFactor === null ? null : narrowingFactor(healthFactor);
  let cut: Preemption | null = null;
  if (plans.length && factor !== null && healthFactor !== null) {
    try {
      cut = preempt(plans, "health", "yield", factor, preemptReason(healthFactor));
    } catch {
      cut = null;
    }
  }
  const yieldCapBefore = plans.find((p) => p.category === "yield")?.permissions.spend?.[0]?.limit;
  const yieldCapAfter = cut?.narrowed.spend?.[0]?.limit;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-8 pb-4">
      <section className="sheet sheet--carbon">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Form K-5 · surat mandat · the mandate</span>
          <span className="serial text-[0.85rem]">Chain {BSC_MAINNET} · USDT</span>
        </div>

        <header className="px-5 py-6">
          <span className="cap">Keterangan · what this form grants</span>
          <h1 className="typed text-[2rem] font-bold leading-[1.1] text-balance sm:text-[2.6rem] mt-2 max-w-[24ch]">
            Four seats, four sessions, none of them able to reach the others.
          </h1>
          <p className="typed mt-3 max-w-[62ch] text-carbon-2">
            Every seat gets its own spend cap, its own allowlist of contracts, and the same expiry.{" "}
            {ledger.length > 0
              ? "The planner below is unsigned; the sessions above are already on-chain."
              : "Nothing here is signed yet — this is exactly what a wallet would be asked to approve."}
          </p>
        </header>
      </section>

      {ledger.length > 0 ? (
        <LiveSessions
          seats={ledger}
          now={now}
          operator={operator}
          configured={configured}
          canRevoke={canRevoke}
          holdings={holdings}
        />
      ) : (
        <EmptyLedger />
      )}

      {/* ------------------------------------------------------ the planner --- */}
      <section className="sheet sheet--pink mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Bagian B · rencana · the plan (unsigned) · salinan ketiga</span>
          <span className="cap">Isi lalu tekan · fill in, then press</span>
        </div>

        <form method="get" className="grid gap-px bg-rule sm:grid-cols-[auto_auto_auto_minmax(0,1fr)] sm:items-end">
          {/* The seat and agent ride along so a re-plan keeps the line filled. */}
          {hire.seat && <input type="hidden" name="seat" value={hire.seat} />}
          {hire.agent && <input type="hidden" name="agent" value={`${hire.agent.chainId}:${hire.agent.tokenId}`} />}
          <label className="cell">
            <span className="cap">Modal · capital (USDT)</span>
            <input
              type="number"
              name="capital"
              defaultValue={capital}
              min={1}
              step="any"
              className="field w-40"
            />
          </label>
          <label className="cell">
            <span className="cap">Masa · duration (days)</span>
            <input
              type="number"
              name="days"
              defaultValue={days}
              min={1}
              max={MAX_DURATION_DAYS}
              className="field w-32"
            />
          </label>
          <div className="cell flex items-end">
            <button type="submit" className="counterfoil">
              Plan mandate
            </button>
          </div>
          <div className="cell cell--yellow">
            <span className="cap">Terikat · committed</span>
            <p className="typed text-[0.9rem]">
              {fromRaw(committed)} of {capital.toLocaleString("en-US")} USDT committed — the remainder
              never leaves your wallet.
            </p>
          </div>
        </form>

        {error ? (
          <div className={`border-t-[1.5px] px-5 py-6 ${unexpected ? "border-stamp-red bg-paper-pink" : "border-rule"}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <span className="cap">{unexpected ? "Unexpected failure" : "Refused"}</span>
                <p className="typed mt-2 max-w-[62ch] text-carbon-2">{error}</p>
                {!unexpected && (
                  <p className="stamp-note mt-2 max-w-[62ch]">
                    This is the planner declining to build a session it could not keep scoped, not an
                    error.
                  </p>
                )}
              </div>
              <Stamp ink={unexpected ? "stamp-red" : "stamp-grey"}>
                <span lang="id">{unexpected ? "Gagal" : "Ditolak"}</span>
              </Stamp>
            </div>
          </div>
        ) : (
          <div className="border-t-[1.5px] border-rule">
            {plans.map((p, i) => (
              <SeatLine
                key={p.category}
                plan={p}
                index={i + 1}
                filledBy={
                  hire.seat === p.category && hire.agent
                    ? { ...hire.agent, name: agent?.name ?? null }
                    : null
                }
              />
            ))}
          </div>
        )}

        {!error && plans.length > 0 && (
          <GrantStub operator={operator} configured={configured} canGrant={canRevoke} capital={capital} days={days} />
        )}

        {plans.length > 0 && yieldCapBefore !== undefined && (
          <section className="border-t-[1.5px] border-rule px-5 py-6">
            <h2 className="cap">Preemption</h2>
            <p className="typed mt-2 max-w-[62ch] text-carbon-2">
              The risk officer outranks every other seat. When the wallet&rsquo;s lending position slips
              below a health factor of {HEALTH_FLOOR.toFixed(2)}, it narrows the allocator instead of
              asking — revoke, then re-grant at the smaller cap, the cap shrinking with the shortfall
              until the liquidation line recalls all of it. The allowlist is untouched.
            </p>
            <PositionReading health={health} wallet={firstSeat?.walletAddress ?? null} />
            {cut && yieldCapAfter !== undefined ? (
              <p className="typed mt-3 text-[0.95rem]">
                <span className="text-carbon-3">yield spend cap </span>
                <span className="line-through decoration-stamp-red decoration-2">{fromRaw(yieldCapBefore)}</span>
                <span className="text-carbon-3"> → </span>
                <span className="font-bold text-stamp-violet">{fromRaw(yieldCapAfter)}</span>
                <span className="text-carbon-3">
                  {" "}
                  USDT/day · {Math.round((factor ?? 0) * 100)}% of the cap survives · {cut.reason}
                </span>
              </p>
            ) : (
              <p className="typed mt-3 text-[0.95rem]">
                <span className="text-carbon-3">yield spend cap </span>
                <span className="font-bold">{fromRaw(yieldCapBefore)}</span>
                <span className="text-carbon-3">
                  {" "}
                  USDT/day ·{" "}
                  {healthFactor === null
                    ? "no cut: there is no debt to protect"
                    : `no cut: health factor ${healthFactor.toFixed(2)} is above the ${HEALTH_FLOOR.toFixed(2)} floor`}
                </span>
              </p>
            )}
          </section>
        )}
      </section>

      <div className="mt-6">
        <Legend
          items={[
            { mark: <Stamp ink="stamp-violet" size="sm" flat>Live</Stamp>, means: "registered in the Altana KeyStore and not yet expired or revoked" },
            { mark: <Stamp ink="stamp-red" size="sm" flat>Revoked</Stamp>, means: "destroyed on-chain; KeyStore revocation cannot be undone" },
            { mark: <span className="serial text-[0.8rem]" lang="id">Tidak melebihi</span>, means: "the spend cap: what the seat may spend per day, never a deposit" },
          ]}
        />
      </div>

      <p className="mt-6">
        <Link href="/agents" className="counterfoil counterfoil--quiet">
          ← Pick the agents that fill these seats
        </Link>
      </p>
    </div>
  );
}

/**
 * What the wallet's lending venues said when this page was built.
 *
 * Every line is a read from the venue table's proven addresses, made as the
 * page rendered. The number the rule runs on is printed beside the cut so a
 * reader can check the arithmetic; a wallet with no position says so rather
 * than showing a factor that would mean nothing.
 */
function PositionReading({ health, wallet }: { health: HealthReading | null; wallet: string | null }) {
  if (!wallet) {
    return (
      <p className="stamp-note mt-3 max-w-[62ch]">
        No mandate wallet on this instance, so there is no position to read. The rule above is what
        the risk officer would apply to one.
      </p>
    );
  }
  if (!health) {
    return (
      <p className="stamp-note mt-3 max-w-[62ch]">
        The lending venues could not be read for {short(wallet)} just now, so no cut is computed.
        The cap below stands as planned.
      </p>
    );
  }
  return (
    <dl className="cells mt-4 sm:grid-cols-2">
      {describeHealth(health).map((line) => {
        const [venue, ...rest] = line.split(": ");
        return (
          <div key={venue} className="cell">
            <dt className="cap">{venue} · read for {short(wallet)}</dt>
            <dd className="typed text-[0.88rem] text-carbon-2">{rest.join(": ")}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * Bagian A with nothing in it.
 *
 * The sheet is printed even when empty, because a control room that simply
 * vanishes reads as "nothing to control" rather than "nothing granted yet",
 * and the two are different facts about the same wallet.
 */
function EmptyLedger() {
  return (
    <section className="sheet sheet--yellow mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
        <span className="cap">Bagian A · terdaftar di rantai · granted on-chain</span>
        <span className="serial text-[0.85rem]">0 live of 0</span>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5">
        <div>
          <h2 className="heading text-[1.9rem]">Nothing granted on-chain yet</h2>
          <p className="typed mt-2 max-w-[62ch] text-[0.9rem] text-carbon-2">
            No sessions have been granted on this instance. That is the normal state of a fresh
            deployment, not a fault: the planner below builds the exact grant a wallet would be asked
            to sign, and <code className="font-bold">npm run onchain</code> or the stub under it puts
            the seats in the Altana KeyStore where anyone can read them.
          </p>
        </div>
        <Stamp ink="stamp-grey" size="lg">
          <span lang="id">Belum ada</span>
        </Stamp>
      </div>
    </section>
  );
}

/**
 * The control room: sessions that exist on-chain right now.
 *
 * Everything else on this page is a plan. These are grants a user can lose
 * money to, so each one shows exactly what it may touch and carries the
 * button that takes it away.
 */
function LiveSessions({
  seats,
  now,
  operator,
  configured,
  canRevoke,
  holdings,
}: {
  seats: LedgerSeat[];
  now: number;
  operator: boolean;
  configured: boolean;
  canRevoke: boolean;
  holdings: { native: bigint } | null;
}) {
  const live = seats.filter((s) => isLive(s, now));

  // Caps only add up within a period. A per-day cap and a per-week cap on
  // one wallet are two ceilings, not one, so the total is printed per period.
  const capsByPeriod = new Map<string, bigint>();
  for (const s of live) capsByPeriod.set(s.spendPeriod, (capsByPeriod.get(s.spendPeriod) ?? 0n) + BigInt(s.spendLimit));

  // The revocation offered as proof to a visitor who cannot press the stub:
  // this instance's own, when it has one, otherwise the one in README.md.
  const landed = seats.find((s) => s.revokeTx)?.revokeTx ?? PROVEN_REVOCATION_TX;
  const provenRevocation = explorerTx(seats[0]?.chainId ?? BSC_MAINNET, landed);
  const wallet = seats[0]?.walletAddress;

  return (
    <section className="sheet sheet--yellow mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
        <span className="cap">Bagian A · terdaftar di rantai · granted on-chain</span>
        <span className="serial text-[0.85rem]">
          {live.length} live of {seats.length} · chain {seats[0]?.chainId}
        </span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5">
        <div>
          <h2 className="heading text-[1.9rem]">Granted on-chain</h2>
          <p className="typed mt-2 max-w-[62ch] text-[0.9rem] text-carbon-2">
            These session keys are registered in the Altana KeyStore, so anyone can read what they may
            do without trusting this page. Revoking takes effect on the next block, not at the next
            expiry.
          </p>
          {holdings && (
            <p className="typed mt-3 text-[0.9rem]">
              <span className="cap">wallet holds</span>{" "}
              <span className="font-bold">{formatEther(holdings.native)} BNB</span>
              <span className="text-carbon-3">
                {" "}
                · caps below total{" "}
                {capsByPeriod.size === 0
                  ? "nothing"
                  : [...capsByPeriod].map(([period, sum]) => `${formatEther(sum)} BNB/${period}`).join(" · ")}{" "}
                across live seats
              </span>
            </p>
          )}
          <p className="stamp-note mt-2 max-w-[62ch]">
            These grants are denominated in BNB, the coin the wallet carries; the planner below is in
            USDT. Same rule, different token.
          </p>
          {wallet && (
            <p className="mt-2">
              <a
                href={`${ALTANA_EXPLORER}/account/${wallet}`}
                target="_blank"
                rel="noreferrer noopener"
                className="cap underline"
              >
                wallet {short(wallet)} on the Altana explorer
              </a>
            </p>
          )}
        </div>
        <Stamp ink="stamp-violet" size="lg" evidence={seats.length * 20}>
          <span lang="id">Terdaftar</span>
        </Stamp>
      </div>

      <div className="px-5 pb-5">
        <OperatorBar operator={operator} configured={configured} canRevoke={canRevoke} />
      </div>

      <div className="cells border-x-0 border-b-0 sm:grid-cols-2">
        {seats.map((seat) => {
          const alive = isLive(seat, now);
          const expired = !seat.revokedAt && seat.expiry <= now;
          const status = seat.revokedAt
            ? seat.preemptedBy && !seat.supersedes
              ? "Preempted"
              : "Revoked"
            : expired
              ? "Expired"
              : "Live";
          // The KeyStore indexes a key by keccak256 of its public key; the
          // README re-derived every seat's id this way and matched `getKeys`.
          const keyId = keccak256(seat.publicKey);
          return (
            <div key={seat.publicKey} className="cell px-5 py-5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
                <div>
                  <span className="cap" style={{ color: seatColor(seat.category) }}>{seat.seat}</span>
                  <p className="heading text-[1.6rem]">
                    {formatEther(BigInt(seat.spendLimit))}
                    <span className="typed ml-2 text-[0.8rem] font-normal tracking-normal text-carbon-3">
                      BNB / {seat.spendPeriod} · <span lang="id">tidak melebihi</span>
                    </span>
                  </p>
                </div>
                <Stamp ink={alive ? "stamp-violet" : "stamp-red"} size="sm" flat>
                  {status}
                </Stamp>
              </div>

              <dl className="mt-4 space-y-2.5">
                <div>
                  <dt className="cap">May call</dt>
                  <dd className="typed mt-1 text-[0.78rem] text-carbon-3">
                    <details>
                      <summary className="cursor-pointer">
                        {seat.allowlist.map(short).join(", ")}
                        <span className="ml-1 text-carbon-2">· {seat.allowlist.length} contract{seat.allowlist.length === 1 ? "" : "s"}</span>
                      </summary>
                      <div className="mt-1 space-y-0.5 break-all">
                        {seat.allowlist.map((a) => (
                          <p key={a}>{a}</p>
                        ))}
                      </div>
                    </details>
                  </dd>
                </div>
                <div>
                  <dt className="cap">Session key</dt>
                  <dd className="typed mt-1 text-[0.78rem] text-carbon-3">
                    <details>
                      <summary className="cursor-pointer">{short(seat.publicKey)}</summary>
                      <p className="mt-1 break-all">{seat.publicKey}</p>
                    </details>
                    <a
                      href={`${ALTANA_EXPLORER}/key/${keyId}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1 inline-block underline"
                    >
                      key {short(keyId)} in the KeyStore
                    </a>
                  </dd>
                </div>
                <div>
                  <dt className="cap">Expires</dt>
                  <dd className="typed mt-1 text-[0.85rem] text-carbon-2">
                    {new Date(seat.expiry * 1000).toISOString().replace("T", " ").slice(0, 16)}
                  </dd>
                </div>
              </dl>

              {seat.supersedes && (
                <p className="typed mt-3 max-w-[60ch] text-[0.85rem] text-carbon-2">
                  Narrowed by the {seat.preemptedBy ?? "higher-priority"} seat. Replaced key{" "}
                  <span className="text-[0.78rem]">{short(seat.supersedes)}</span>, which is revoked for
                  good — KeyStore revocation cannot be undone, only superseded.
                </p>
              )}

              {seat.revokeTx && explorerTx(seat.chainId, seat.revokeTx) && (
                <p className="mt-3">
                  <a
                    href={explorerTx(seat.chainId, seat.revokeTx)!}
                    target="_blank"
                    rel="noreferrer"
                    className="cap underline"
                  >
                    revocation transaction on bscscan
                  </a>
                </p>
              )}

              {seat.revokeError && (
                <p className="typed mt-3 border-[1.5px] border-stamp-red bg-paper-pink px-2 py-1.5 text-[0.8rem] text-carbon-2">
                  Revoke did not land: {seat.revokeError}. The session is still live.
                </p>
              )}

              {alive &&
                (operator && canRevoke ? (
                  <form action={revokeAction} className="mt-4">
                    <input type="hidden" name="publicKey" value={seat.publicKey} />
                    <button type="submit" className="counterfoil counterfoil--pink counterfoil--quiet">
                      Revoke this seat
                    </button>
                  </form>
                ) : (
                  /* Not a button: nothing here can be pressed, and a disabled
                     button would still be announced as one. The stub is drawn
                     so the reader sees where the control sits. */
                  <div className="mt-4">
                    <span className="counterfoil counterfoil--pink counterfoil--quiet" aria-disabled="true">
                      Revoke this seat
                    </span>
                    <p className="stamp-note mt-2 max-w-[40ch]">
                      Revocation is operator-only on this deployment.{" "}
                      {provenRevocation && (
                        <a href={provenRevocation} target="_blank" rel="noreferrer noopener" className="underline">
                          One that landed from this stub
                        </a>
                      )}
                      {provenRevocation ? "." : ""}
                    </p>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The lock on the destructive half of the control room.
 *
 * Three states, and the one that matters is the third: with no operator token
 * configured, revoking is unavailable to everyone including the operator. An
 * instance deployed without reading the setup notes should be inert, not open.
 */
function OperatorBar({
  operator,
  configured,
  canRevoke,
}: {
  operator: boolean;
  configured: boolean;
  canRevoke: boolean;
}) {
  // Capability before permission: without the wallet key there is nothing to
  // unlock, so offering the form would invite an operator into a dead end.
  if (!canRevoke) {
    return (
      <p className="typed border-[1.5px] border-rule bg-paper-white px-3 py-2.5 text-[0.88rem] text-carbon-2">
        <span className="cap">View only</span> — this instance holds no admin key, so it can show these
        sessions but not revoke them. Revocation happens where the wallet key lives.
      </p>
    );
  }

  if (!configured) {
    return (
      <p className="typed border-[1.5px] border-rule bg-paper-white px-3 py-2.5 text-[0.88rem] text-carbon-2">
        <span className="cap">Locked</span> — no <code className="font-bold">KAWAL_OPERATOR_TOKEN</code> is
        set on this deployment, so nobody can revoke a session here. Set it to unlock the control room.
      </p>
    );
  }

  if (operator) {
    return (
      <form action={lockAction} className="flex flex-wrap items-center gap-3">
        <Stamp ink="stamp-violet" size="sm" flat>
          Unlocked as operator
        </Stamp>
        <button type="submit" className="counterfoil counterfoil--quiet">
          lock again
        </button>
      </form>
    );
  }

  return (
    <form action={unlockAction} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="cap">Operator token</span>
        <input type="password" name="token" autoComplete="off" className="field w-64" />
      </label>
      <button type="submit" className="counterfoil counterfoil--quiet">
        Unlock to revoke
      </button>
      <p className="stamp-note max-w-xs">Viewing is open to anyone. Revoking is not.</p>
    </form>
  );
}

/**
 * The stub that turns the plan into KeyStore registrations.
 *
 * Offered only where it can be honoured: the operator unlocked, and the
 * wallet key on this instance. Everywhere else it is drawn disabled with the
 * reason beside it, because a plan that ends in a button that does nothing
 * is the dead end this page exists to avoid.
 */
function GrantStub({
  operator,
  configured,
  canGrant,
  capital,
  days,
}: {
  operator: boolean;
  configured: boolean;
  canGrant: boolean;
  capital: number;
  days: number;
}) {
  const why = !canGrant
    ? "this instance holds no admin key, so it cannot sign a registration; granting happens where the wallet key lives"
    : !configured
      ? "no KAWAL_OPERATOR_TOKEN is set on this deployment, so nobody can grant here"
      : !operator
        ? "unlock the control room above with the operator token first"
        : null;

  return (
    <div className="border-t-[1.5px] border-rule px-5 py-5">
      {why === null ? (
        <form action={grantAction} className="flex flex-wrap items-center gap-4">
          <input type="hidden" name="capital" value={capital} />
          <input type="hidden" name="days" value={days} />
          <button type="submit" className="counterfoil">
            Grant these seats
          </button>
          <p className="stamp-note max-w-[48ch]">
            Registers one key per seat in the Altana KeyStore from the admin wallet, at the registration
            fee each. The seats appear in Bagian A as they land.
          </p>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <span className="counterfoil" aria-disabled="true">
            Grant these seats
          </span>
          <p className="stamp-note max-w-[48ch]">Not available here: {why}.</p>
        </div>
      )}
    </div>
  );
}

/** One planned seat, as a line of the form: the cap in its own box. */
function SeatLine({
  plan,
  index,
  filledBy,
}: {
  plan: SessionPlan;
  index: number;
  filledBy: { chainId: number; tokenId: string; name: string | null } | null;
}) {
  const policy = SEAT_POLICIES.find((s) => s.category === plan.category);
  const spend = plan.permissions.spend?.[0];
  const limit = spend?.limit ?? 0n;
  // The allowlist as granted, which is what the plan carries; the policy
  // only adds the protocol names. A plan for a seat the policy table no
  // longer names still prints its addresses rather than throwing.
  const venues = policy?.venues.map((id) => VENUES[id]) ?? [];

  return (
    <div
      className="manifest-row grid grid-cols-[3rem_minmax(0,1fr)] gap-x-4 px-5 py-5 last:border-b-0 lg:grid-cols-[3rem_11rem_minmax(0,1fr)_auto]"
      style={{ ["--seat" as string]: seatColor(plan.category) }}
    >
      <span className="serial serial--seat pt-1 text-[0.85rem]">{String(index).padStart(2, "0")}</span>
      <div>
        <span className="cap" style={{ color: seatColor(plan.category) }}>{plan.seat}</span>
        <span className="cap block !text-carbon-2">priority {plan.priority}</span>
      </div>
      <dl className="col-start-2 mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:col-start-3 lg:mt-0">
        {filledBy && (
          <div className="sm:col-span-2">
            <dt className="cap">Diisi oleh · filled by</dt>
            <dd className="typed mt-1 text-[0.95rem]">
              <Link href={`/agents/${filledBy.chainId}/${filledBy.tokenId}`} className="underline">
                {filledBy.name ?? `agent ${filledBy.chainId}:${filledBy.tokenId}`}
              </Link>
              {filledBy.name === null && (
                <span className="stamp-note ml-2">registry did not answer for the name; the id stands</span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt className="cap">May call</dt>
          <dd className="mt-1 space-y-1">
            {venues.length > 0
              ? venues.map((venue) => {
                  const address = venue.deployments[BSC_MAINNET]?.address;
                  if (!address) return null;
                  return (
                    <p key={venue.id} className="typed text-[0.85rem]">
                      {venue.protocol}
                      <span className="block break-all text-[0.75rem] text-carbon-3">{address}</span>
                    </p>
                  );
                })
              : (plan.permissions.calls ?? []).map((c, i) => (
                  <p key={i} className="typed break-all text-[0.75rem] text-carbon-3">
                    {"to" in c ? c.to : c.signature}
                  </p>
                ))}
          </dd>
        </div>
        <div>
          <dt className="cap">Expires</dt>
          <dd className="typed mt-1 text-[0.85rem] text-carbon-2">{new Date(plan.expiry * 1000).toISOString().slice(0, 10)}</dd>
        </div>
      </dl>
      {/* The box every other line points at. */}
      <div className="col-start-2 mt-3 lg:col-start-4 lg:mt-0">
        <div className="inline-block border-[1.5px] border-rule bg-paper-white px-3 py-2" style={{ borderColor: seatColor(plan.category) }}>
          <span className="cap block">
            <span lang="id">Tidak melebihi</span> · not to exceed
          </span>
          <p className="tnum heading text-[1.7rem]" style={{ color: seatColor(plan.category) }}>
            {fromRaw(limit)}{" "}
            <span className="typed text-[0.8rem] font-normal tracking-normal text-carbon-3">
              USDT / {spend?.period ?? "day"}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
