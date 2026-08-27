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
import { seatColor } from "@/components/listing";
import { readLedger, isLive, walletHoldings, hasAdminKey, type LedgerSeat } from "@/lib/sessions";
import { explorerTx } from "@/lib/altana";
import { revokeAction, unlockAction, lockAction } from "./actions";
import { isOperator, operatorConfigured } from "@/lib/operator";
import { formatEther } from "viem";

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
 * render.
 *
 * `connection()` is Next's marker for "this render genuinely depends on the
 * request", which is exactly what reading a clock is; the docs use the same
 * shape for synchronous DB drivers. Keeping it out of the component body also
 * satisfies React's purity rule honestly instead of suppressing it — a render
 * that returns something different every time it runs is not idempotent, and
 * the rule is right to say so.
 */
async function requestTime() {
  await connection();
  return Math.floor(Date.now() / 1000);
}

/**
 * Reads one number out of a query string, clamped.
 *
 * A `max` attribute on the input is a hint to a browser, not a constraint on
 * a URL anyone can type. Everything past this point assumes a sane number, so
 * this is where it becomes true.
 */
function num(v: string | string[] | undefined, fallback: number, max: number) {
  const n = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

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

  // `spend?.[0].limit` guards the array being absent, not its being empty:
  // `[]?.[0]` is undefined and reading `.limit` off that throws before the
  // fallback applies. Same shape as the bug found in lib/altana.ts.
  const committed = plans.reduce((s, p) => s + (p.permissions.spend?.[0]?.limit ?? 0n), 0n);
  const cut = plans.length
    ? preempt(plans, "health", "yield", 0.25, "health factor fell below the 1.40 floor")
    : null;

  // Read once, with a guard, instead of `plans.find(...)!.permissions.spend![0]`
  // inside the markup. Two non-null assertions in one expression is two places
  // a wrong assumption turns into a render crash rather than a missing line.
  const yieldCapBefore = plans.find((p) => p.category === "yield")?.permissions.spend?.[0]?.limit;
  const yieldCapAfter = cut?.narrowed.spend?.[0]?.limit;

  // Sessions that were actually granted on-chain, if this machine has run
  // `npm run onchain`. Everything below the form is a plan; this is not.
  const ledger = readLedger();

  // Revoking destroys a KeyStore registration for good, so the button only
  // exists for a caller who proved they are the operator. The action checks
  // this again on its own — a hidden button is not access control.
  const [operator, configured] = await Promise.all([isOperator(), operatorConfigured()]);
  // Holding the token is permission; holding the key is capability. A page
  // that offers a button it cannot honour is a dead end dressed as a control.
  const canRevoke = hasAdminKey();

  // What the wallet actually holds, so the caps below are read against a
  // floor rather than in a vacuum.
  // Every seat in a ledger shares one wallet, so the first row names it. Read
  // through a binding rather than indexing twice: `length > 0` tells a human
  // the index is safe but tells the compiler nothing.
  const firstSeat = ledger[0];
  const holdings = firstSeat
    ? await walletHoldings(firstSeat.chainId, firstSeat.walletAddress)
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12">
      <header>
        <p className="label">Mandate</p>
        <h1 className="mt-3 max-w-2xl text-3xl font-bold tracking-[-0.03em]">
          Four seats, four sessions, none of them able to reach the others.
        </h1>
        <p className="mt-3 max-w-2xl text-ink-2">
          Every seat gets its own spend cap, its own allowlist of contracts, and
          the same expiry.{" "}
          {ledger.length > 0
            ? "The planner below is unsigned; the sessions above are already on-chain."
            : "Nothing here is signed yet — this is exactly what a wallet would be asked to approve."}
        </p>
      </header>

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

      <form method="get" className="mt-8 flex flex-wrap items-end gap-4 border-y border-rule py-5">
        <label className="flex flex-col gap-1.5">
          <span className="label">Capital (USDT)</span>
          <input
            type="number"
            name="capital"
            defaultValue={capital}
            min={1}
            step="any"
            className="tnum w-40 rounded-sm border border-rule-2 bg-surface px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">Duration (days)</span>
          <input
            type="number"
            name="days"
            defaultValue={days}
            min={1}
            max={MAX_DURATION_DAYS}
            className="tnum w-32 rounded-sm border border-rule-2 bg-surface px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          className="rounded-sm bg-ink px-5 py-2.5 text-sm font-medium text-ground hover:opacity-90"
        >
          Plan mandate
        </button>
        <p className="label ml-auto max-w-xs leading-relaxed">
          {fromRaw(committed)} of {capital.toLocaleString("en-US")} USDT committed —
          the remainder never leaves your wallet.
        </p>
      </form>

      {error ? (
        <div
          className="mt-10 border bg-surface p-6"
          style={{ borderColor: unexpected ? "var(--seat-health)" : "var(--rule-2)" }}
        >
          <p className="label">{unexpected ? "Unexpected failure" : "Refused"}</p>
          <p className="mt-2 text-ink-2">{error}</p>
          {!unexpected && (
            <p className="mt-3 text-sm text-ink-3">
              This is the planner declining to build a session it could not keep
              scoped, not an error.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-10 grid gap-px bg-rule sm:grid-cols-2">
          {plans.map((p) => (
            <SeatCard key={p.category} plan={p} />
          ))}
        </div>
      )}

      {cut && yieldCapBefore !== undefined && yieldCapAfter !== undefined && (
        <section className="mt-12 border-t border-rule pt-8">
          <h2 className="label">Preemption</h2>
          <p className="mt-3 max-w-2xl text-ink-2">
            The risk officer outranks every other seat. When it needs capital
            back, it narrows the allocator instead of asking — revoke, then
            re-grant at the smaller cap. The allowlist is untouched.
          </p>
          <p className="tnum mt-4 font-mono text-sm">
            <span className="text-ink-3">yield spend cap </span>
            {fromRaw(yieldCapBefore)}
            <span className="text-ink-3"> → </span>
            <span className="text-brass">{fromRaw(yieldCapAfter)}</span>
            <span className="text-ink-3"> USDT/day · {cut.reason}</span>
          </p>
        </section>
      )}

      <p className="label mt-12">
        <Link href="/agents" className="hover:text-ink">
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
    <section className="mt-10 border border-brass bg-brass-soft/30 p-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Granted on-chain</h2>
        <span className="label">
          {live.length} live of {seats.length} · chain {seats[0]?.chainId}
        </span>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">
        These session keys are registered in the Altana KeyStore, so anyone can
        read what they may do without trusting this page. Revoking takes effect
        on the next block, not at the next expiry.
      </p>

      {holdings && (
        <p className="tnum mt-3 font-mono text-sm">
          <span className="label">wallet holds</span>{" "}
          <span className="font-semibold">{formatEther(holdings.native)} BNB</span>
          <span className="text-ink-3">
            {" "}
            · caps below total{" "}
            {formatEther(
              seats
                .filter((s) => isLive(s, now))
                .reduce((sum, s) => sum + BigInt(s.spendLimit), 0n),
            )}{" "}
            BNB/day across live seats
          </span>
        </p>
      )}

      <OperatorBar operator={operator} configured={configured} canRevoke={canRevoke} />

      <div className="mt-6 grid gap-px bg-rule sm:grid-cols-2">
        {seats.map((seat) => {
          const alive = isLive(seat, now);
          const expired = !seat.revokedAt && seat.expiry <= now;
          return (
            <div key={seat.publicKey} className="bg-surface p-5">
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className="h-4 w-[3px] rounded-sm"
                  style={{ background: seatColor(seat.category) }}
                />
                <span className="label">{seat.seat}</span>
                <span
                  className={`label ml-auto rounded-sm border px-2 py-0.5 ${
                    alive
                      ? "border-brass text-brass"
                      : "border-rule-2 text-ink-3"
                  }`}
                >
                  {seat.revokedAt
                    ? seat.preemptedBy && !seat.supersedes
                      ? "Preempted"
                      : "Revoked"
                    : expired
                      ? "Expired"
                      : "Live"}
                </span>
              </div>

              <p className="tnum mt-3 text-lg font-semibold">
                {formatEther(BigInt(seat.spendLimit))}{" "}
                <span className="text-sm font-normal text-ink-3">
                  BNB / {seat.spendPeriod}
                </span>
              </p>

              <dl className="mt-4 space-y-2 text-sm">
                <div>
                  <dt className="label">May call</dt>
                  <dd className="tnum mt-1 space-y-0.5 break-all font-mono text-xs text-ink-3">
                    {seat.allowlist.map((a) => (
                      <p key={a}>{a}</p>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt className="label">Session key</dt>
                  <dd className="tnum mt-1 break-all font-mono text-xs text-ink-3">
                    {seat.publicKey}
                  </dd>
                </div>
                <div>
                  <dt className="label">Expires</dt>
                  <dd className="tnum mt-1 font-mono text-xs text-ink-2">
                    {new Date(seat.expiry * 1000).toISOString().replace("T", " ").slice(0, 16)}
                  </dd>
                </div>
              </dl>

              {seat.supersedes && (
                <p className="mt-3 border-l-2 pl-3 text-sm text-ink-2" style={{ borderColor: seatColor(seat.category) }}>
                  Narrowed by the {seat.preemptedBy ?? "higher-priority"} seat.
                  Replaced key{" "}
                  <span className="tnum font-mono text-xs">
                    {seat.supersedes.slice(0, 20)}…
                  </span>
                  , which is revoked for good — KeyStore revocation cannot be
                  undone, only superseded.
                </p>
              )}

              {seat.revokeTx && explorerTx(seat.chainId, seat.revokeTx) && (
                <p className="label mt-4">
                  <a
                    href={explorerTx(seat.chainId, seat.revokeTx)!}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-ink"
                  >
                    revocation transaction ↗
                  </a>
                </p>
              )}

              {seat.revokeError && (
                <p className="mt-4 border p-2 text-xs text-ink-2"
                  style={{ borderColor: "var(--seat-health)" }}>
                  Revoke did not land: {seat.revokeError}. The session is still
                  live.
                </p>
              )}

              {alive && operator && canRevoke && (
                <form action={revokeAction} className="mt-4">
                  <input type="hidden" name="publicKey" value={seat.publicKey} />
                  <button
                    type="submit"
                    className="rounded-sm border border-rule-2 px-3 py-1.5 text-sm font-medium hover:border-ink hover:bg-ink hover:text-ground"
                  >
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
      <p className="mt-5 border border-rule-2 bg-surface p-4 text-sm text-ink-2">
        <span className="label">View only</span> — this instance holds no admin
        key, so it can show these sessions but not revoke them. Revocation
        happens where the wallet key lives.
      </p>
    );
  }

  if (!configured) {
    return (
      <p className="mt-5 border border-rule-2 bg-surface p-4 text-sm text-ink-2">
        <span className="label">Locked</span> — no{" "}
        <code className="font-mono text-xs">KAWAL_OPERATOR_TOKEN</code> is set on this
        deployment, so nobody can revoke a session here. Set it to unlock the control
        room.
      </p>
    );
  }

  if (operator) {
    return (
      <form action={lockAction} className="mt-5 flex items-center gap-3">
        <span className="label">Unlocked as operator</span>
        <button type="submit" className="label underline hover:text-ink">
          lock again
        </button>
      </form>
    );
  }

  return (
    <form action={unlockAction} className="mt-5 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="label">Operator token</span>
        <input
          type="password"
          name="token"
          autoComplete="off"
          className="w-64 rounded-sm border border-rule-2 bg-surface px-3 py-2 text-sm"
        />
      </label>
      <button
        type="submit"
        className="rounded-sm border border-rule-2 px-4 py-2 text-sm font-medium hover:border-ink"
      >
        Unlock to revoke
      </button>
      <p className="label max-w-xs leading-relaxed">
        Viewing is open to anyone. Revoking is not.
      </p>
    </form>
  );
}

function SeatCard({ plan }: { plan: SessionPlan }) {
  const policy = SEAT_POLICIES.find((s) => s.category === plan.category)!;
  const spend = plan.permissions.spend?.[0];
  const limit = spend?.limit ?? 0n;

  return (
    <div className="bg-surface p-6">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="h-4 w-[3px] rounded-sm"
          style={{ background: seatColor(plan.category) }}
        />
        <span className="label">{plan.seat}</span>
        <span className="label tnum ml-auto">priority {plan.priority}</span>
      </div>

      <p className="tnum mt-4 text-2xl font-semibold tracking-tight">
        {fromRaw(limit)}{" "}
        <span className="text-base font-normal text-ink-3">USDT / {spend?.period ?? "day"}</span>
      </p>

      <dl className="mt-5 space-y-3">
        <div>
          <dt className="label">May call</dt>
          <dd className="mt-1.5 space-y-1.5">
            {policy.venues.map((id) => {
              const venue = VENUES[id];
              const address = venue?.deployments[BSC_MAINNET]?.address;
              if (!venue || !address) return null;
              return (
                <p key={id} className="text-sm">
                  {venue.protocol}
                  <span className="tnum block break-all font-mono text-xs text-ink-3">
                    {address}
                  </span>
                </p>
              );
            })}
          </dd>
        </div>
        <div>
          <dt className="label">Expires</dt>
          <dd className="tnum mt-1 font-mono text-sm text-ink-2">
            {new Date(plan.expiry * 1000).toISOString().slice(0, 10)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
