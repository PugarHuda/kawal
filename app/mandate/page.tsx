import Link from "next/link";
import { connection } from "next/server";
import {
  planMandate,
  preempt,
  SEAT_POLICIES,
  VENUES,
  UnsafeMandateError,
  MAX_DURATION_DAYS,
  type SessionPlan,
} from "@/lib/mandate";
import { BSC_MAINNET } from "@/lib/chains";
import { seatColor, Stamp, Legend } from "@/components/listing";
import { loadLedger, isLive, walletHoldings, hasAdminKey, type LedgerSeat } from "@/lib/sessions";
import { explorerTx } from "@/lib/altana";
import { revokeAction, unlockAction, lockAction } from "./actions";
import { isOperator, operatorConfigured } from "@/lib/operator";
import { formatEther } from "viem";

/*
 * Form K-5: the mandate.
 *
 * A spend cap is the product's whole value, so on this form it is the box
 * every other line points at: "TIDAK MELEBIHI · not to exceed", typed in the
 * seat's own ink. Sessions that exist on-chain are a separate, stamped sheet
 * above the planner; everything below the fold is a plan and says so.
 */

// USDT on BSC, the settlement token every seat's cap is denominated in.
const USDT = "0x55d398326f99059fF775485246999027B3197955" as const;
const DECIMALS = 18n;

/**
 * Above this the planner stops meaning anything, and `Math.round(x * 100)`
 * leaves the range where a double still represents whole numbers exactly
 * (2^53 / 100). Past that point `BigInt(...)` either throws on Infinity or
 * silently rounds — both worse than refusing.
 */
const MAX_CAPITAL = 1e12;

function toRaw(usdt: number) {
  // ponytail: cents are the smallest unit anyone types into this form.
  return (BigInt(Math.round(usdt * 100)) * 10n ** DECIMALS) / 100n;
}

function fromRaw(raw: bigint) {
  const whole = raw / 10n ** DECIMALS;
  return whole.toLocaleString("en-US");
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

export const metadata = {
  title: "Mandate",
  description:
    "Four seats, four session keys on Altana, none able to reach the others. Spend caps, allowlists, expiry and revocation for every agent you hire.",
};

export default async function MandatePage({ searchParams }: PageProps<"/mandate">) {
  const params = await searchParams;
  const capital = num(params.capital, 10_000, MAX_CAPITAL);
  const days = Math.round(num(params.days, 30, MAX_DURATION_DAYS));

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
      capital: toRaw(capital),
      token: USDT,
      durationDays: Math.round(days),
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

  const committed = plans.reduce((s, p) => s + (p.permissions.spend?.[0]?.limit ?? 0n), 0n);
  const cut = plans.length
    ? preempt(plans, "health", "yield", 0.25, "health factor fell below the 1.40 floor")
    : null;

  const yieldCapBefore = plans.find((p) => p.category === "yield")?.permissions.spend?.[0]?.limit;
  const yieldCapAfter = cut?.narrowed.spend?.[0]?.limit;

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
  const holdings = firstSeat ? await walletHoldings(firstSeat.chainId, firstSeat.walletAddress) : null;

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

      {ledger.length > 0 && (
        <LiveSessions
          seats={ledger}
          now={now}
          operator={operator}
          configured={configured}
          canRevoke={canRevoke}
          holdings={holdings}
        />
      )}

      {/* ------------------------------------------------------ the planner --- */}
      <section className="sheet sheet--pink mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 border-b-[1.5px] border-rule px-5 py-2">
          <span className="cap">Bagian B · rencana · the plan (unsigned) · salinan ketiga</span>
          <span className="cap">Isi lalu tekan · fill in, then press</span>
        </div>

        <form method="get" className="grid gap-px bg-rule sm:grid-cols-[auto_auto_auto_minmax(0,1fr)] sm:items-end">
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
              <Stamp ink={unexpected ? "stamp-red" : "stamp-grey"}>{unexpected ? "Gagal" : "Ditolak"}</Stamp>
            </div>
          </div>
        ) : (
          <div className="border-t-[1.5px] border-rule">
            {plans.map((p, i) => (
              <SeatLine key={p.category} plan={p} index={i + 1} />
            ))}
          </div>
        )}

        {cut && yieldCapBefore !== undefined && yieldCapAfter !== undefined && (
          <section className="border-t-[1.5px] border-rule px-5 py-6">
            <h2 className="cap">Preemption</h2>
            <p className="typed mt-2 max-w-[62ch] text-carbon-2">
              The risk officer outranks every other seat. When it needs capital back, it narrows the
              allocator instead of asking — revoke, then re-grant at the smaller cap. The allowlist is
              untouched.
            </p>
            <p className="typed mt-3 text-[0.95rem]">
              <span className="text-carbon-3">yield spend cap </span>
              <span className="line-through decoration-stamp-red decoration-2">{fromRaw(yieldCapBefore)}</span>
              <span className="text-carbon-3"> → </span>
              <span className="font-bold text-stamp-violet">{fromRaw(yieldCapAfter)}</span>
              <span className="text-carbon-3"> USDT/day · {cut.reason}</span>
            </p>
          </section>
        )}
      </section>

      <div className="mt-6">
        <Legend
          items={[
            { mark: <Stamp ink="stamp-violet" size="sm" flat>Live</Stamp>, means: "registered in the Altana KeyStore and not yet expired or revoked" },
            { mark: <Stamp ink="stamp-red" size="sm" flat>Revoked</Stamp>, means: "destroyed on-chain; KeyStore revocation cannot be undone" },
            { mark: <span className="serial text-[0.8rem]">Tidak melebihi</span>, means: "the spend cap: what the seat may spend per day, never a deposit" },
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
                {formatEther(seats.filter((s) => isLive(s, now)).reduce((sum, s) => sum + BigInt(s.spendLimit), 0n))} BNB/day
                across live seats
              </span>
            </p>
          )}
        </div>
        <Stamp ink="stamp-violet" size="lg" evidence={seats.length * 20}>
          Terdaftar
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
          return (
            <div key={seat.publicKey} className="cell px-5 py-5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
                <div>
                  <span className="cap" style={{ color: seatColor(seat.category) }}>{seat.seat}</span>
                  <p className="heading text-[1.6rem]">
                    {formatEther(BigInt(seat.spendLimit))}
                    <span className="typed ml-2 text-[0.8rem] font-normal tracking-normal text-carbon-3">
                      BNB / {seat.spendPeriod} · tidak melebihi
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
                  <dd className="typed mt-1 space-y-0.5 break-all text-[0.78rem] text-carbon-3">
                    {seat.allowlist.map((a) => (
                      <p key={a}>{a}</p>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt className="cap">Session key</dt>
                  <dd className="typed mt-1 break-all text-[0.78rem] text-carbon-3">{seat.publicKey}</dd>
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
                  <span className="text-[0.78rem]">{seat.supersedes.slice(0, 20)}…</span>, which is revoked
                  for good — KeyStore revocation cannot be undone, only superseded.
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

              {alive && operator && canRevoke && (
                <form action={revokeAction} className="mt-4">
                  <input type="hidden" name="publicKey" value={seat.publicKey} />
                  <button type="submit" className="counterfoil counterfoil--pink counterfoil--quiet">
                    Revoke this seat
                  </button>
                </form>
              )}
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
        <button type="submit" className="cap underline">
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

/** One planned seat, as a line of the form: the cap in its own box. */
function SeatLine({ plan, index }: { plan: SessionPlan; index: number }) {
  const policy = SEAT_POLICIES.find((s) => s.category === plan.category)!;
  const spend = plan.permissions.spend?.[0];
  const limit = spend?.limit ?? 0n;

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
        <div>
          <dt className="cap">May call</dt>
          <dd className="mt-1 space-y-1">
            {policy.venues.map((id) => {
              const venue = VENUES[id];
              const address = venue?.deployments[BSC_MAINNET]?.address;
              if (!venue || !address) return null;
              return (
                <p key={id} className="typed text-[0.85rem]">
                  {venue.protocol}
                  <span className="block break-all text-[0.75rem] text-carbon-3">{address}</span>
                </p>
              );
            })}
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
          <span className="cap block">Tidak melebihi · not to exceed</span>
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
