/**
 * Mandate planning: turning "here is my capital, guard it" into four scoped
 * Altana sessions that cannot step on each other.
 *
 * THE TRAP THIS MODULE EXISTS TO CLOSE
 * ------------------------------------
 * Altana's SessionPermissions says of `calls`:
 *
 *     "Allowed calls. If omitted, all targets are allowed (use carefully)."
 *
 * An empty or forgotten allowlist is therefore not a locked-down session —
 * it is a wildcard over the whole wallet. For a product whose entire promise
 * is "limits they can't cross", that is the one failure that must be
 * impossible rather than merely unlikely. Every plan here is built through
 * `planMandate`, which refuses to emit a session without an explicit
 * allowlist and an explicit spend cap.
 *
 * Nothing in this file touches the chain. It produces the exact
 * `GrantSessionOptions` shape the SDK expects, so the policy is testable
 * offline and reviewable without a wallet.
 */

import type { CategoryId } from "./taxonomy.ts";

/** Mirrors viem's Address without pulling viem into the offline check. */
export type Address = `0x${string}`;

export type SpendPeriod = "minute" | "hour" | "day" | "week" | "month" | "year";

export type CallPermission = { to: Address } | { signature: string } | { to: Address; signature: string };

export type SpendPermission = {
  limit: bigint;
  period: SpendPeriod;
  token?: Address;
};

export type SessionPermissions = {
  calls?: readonly CallPermission[];
  spend?: readonly SpendPermission[];
};

import { BSC_MAINNET, BSC_TESTNET } from "./chains.ts";

/** One proven deployment of a venue on one chain. */
export type VenueDeployment = {
  /**
   * `null` means the venue lives on this chain but no address has been
   * proven yet — `planMandate` refuses to build a session around it.
   */
  address: Address | null;
  /** What the identity call returned when this address was last verified. */
  source: string;
};

/**
 * A venue a seat is allowed to touch.
 *
 * A chain missing from `deployments` means the venue is simply not deployed
 * there, and a seat quietly does without it. A chain present with a `null`
 * address means it IS deployed there but unproven, which fails the grant
 * closed. The two cases are kept apart on purpose: "not available here" and
 * "we never checked" must never be confused when the answer decides what an
 * agent is allowed to call.
 *
 * No address here was written from memory: each one has bytecode on its chain
 * and answered an identity call that only the real contract could answer.
 * Re-prove them any time with `npm run verify:venues` (mainnet) or
 * `npm run verify:venues -- testnet`.
 */
export type Venue = {
  id: string;
  protocol: string;
  deployments: Record<number, VenueDeployment>;
};

/**
 * The venue table, in two steps on purpose.
 *
 * Annotated `Record<string, Venue>` outright, the type threw away what the
 * literal already knows — which venues exist — so every
 * `VENUES["venus.comptroller"]` read as possibly undefined and callers reached
 * for `!` to quiet it. A non-null assertion on a key that might genuinely be
 * missing is a runtime crash wearing a type annotation.
 *
 * `satisfies` alone over-corrects the other way: it freezes each address into
 * a literal type, so the self-check can no longer park one at `null` to prove
 * the grant fails closed on an unverified venue.
 *
 * So: infer the keys from the literal, then re-expose the table with `Venue`
 * values. Literal lookups are proven present, dynamic ones are correctly
 * flagged as needing a check, and the values stay writable.
 */
const VENUE_TABLE = {
  "pancakeswap.v3.positions": {
    id: "pancakeswap.v3.positions",
    protocol: "PancakeSwap V3 NonfungiblePositionManager",
    deployments: {
      [BSC_MAINNET]: {
        address: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
        source: "symbol() = PCS-V3-POS; factory() = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
      },
      [BSC_TESTNET]: {
        address: "0x427bF5b37357632377eCbEC9de3626C71A5396c1",
        source:
          "symbol() = PCS-V3-POS; factory() = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865 " +
          "(same factory as the router reports); WETH9() = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
      },
    },
  },
  "pancakeswap.v3.router": {
    id: "pancakeswap.v3.router",
    protocol: "PancakeSwap V3 router",
    deployments: {
      // Mainnet uses the aggregating SmartRouter; testnet ships the plain V3
      // SwapRouter. Different contracts, same role for this seat, so the
      // evidence names which one each chain actually got.
      [BSC_MAINNET]: {
        address: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
        source: "SmartRouter; WETH9() = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c (WBNB)",
      },
      [BSC_TESTNET]: {
        address: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
        source:
          "SwapRouter (v3); WETH9() = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd; " +
          "factory() = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
      },
    },
  },
  wbnb: {
    id: "wbnb",
    protocol: "Wrapped BNB",
    // The execution trader has to hold WBNB before it can route anything, so
    // wrapping is part of the seat's job rather than a demo-only detour.
    deployments: {
      [BSC_MAINNET]: {
        address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        source: "symbol() = WBNB; reported by the mainnet SmartRouter as WETH9()",
      },
      [BSC_TESTNET]: {
        address: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
        source:
          "symbol() = WBNB; independently reported as WETH9() by the testnet " +
          "PancakeSwap router and listed as WBNB by Venus testnet",
      },
    },
  },
  "venus.comptroller": {
    id: "venus.comptroller",
    protocol: "Venus Core Pool Comptroller",
    deployments: {
      // The proxy, not the implementation: transactions are sent here. Published
      // lists that name 0x9DF11376... as "the Comptroller" are quoting an
      // implementation; this address reports 0xA66B2b5D... as its current one.
      [BSC_MAINNET]: {
        address: "0xfD36E2c2a6789Db23113685031d7F16329158384",
        source: "comptrollerImplementation() = 0xA66B2b5D50ce68A125bBad6B2265b637868c6E66",
      },
      [BSC_TESTNET]: {
        address: "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D",
        source: "Venus deployed-contracts manifest, BNB Chain Testnet Core Pool",
      },
    },
  },
  "venus.vusdt": {
    id: "venus.vusdt",
    protocol: "Venus vUSDT market",
    // The Comptroller alone is not enough: supply, redeem and repay are all
    // calls on the market itself.
    deployments: {
      [BSC_MAINNET]: {
        address: "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
        source: "symbol() = vUSDT; underlying() = 0x55d398326f99059fF775485246999027B3197955 (USDT)",
      },
      [BSC_TESTNET]: {
        address: "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A",
        source: "symbol() = vUSDT; underlying() = 0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c (testnet USDT)",
      },
    },
  },
  "aave.v3.pool": {
    id: "aave.v3.pool",
    protocol: "Aave V3 Pool (BNB market)",
    // Aave V3 has no BNB-testnet market, so the seat simply does without it
    // there rather than pointing at a lookalike.
    deployments: {
      [BSC_MAINNET]: {
        address: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
        source: "ADDRESSES_PROVIDER() = 0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D; POOL_REVISION() = 11",
      },
    },
  },
  "lista.staking": {
    id: "lista.staking",
    protocol: "Lista ListaStakeManager",
    deployments: {
      [BSC_MAINNET]: {
        address: "0x1adB950d8bB3dA4bE104211D5AB038628e477fE6",
        source: "getTotalPooledBnb() answered with a live balance; totalDelegated() present",
      },
    },
  },
  "lista.slisbnb": {
    id: "lista.slisbnb",
    protocol: "slisBNB token",
    deployments: {
      [BSC_MAINNET]: {
        address: "0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B",
        source: "symbol() = slisBNB",
      },
      [BSC_TESTNET]: {
        address: "0xd2aF6A916Bc77764dc63742BC30f71AF4cF423F4",
        // Predates the Synclub -> Lista rebrand, so it still answers with the
        // old ticker. Two independent sources agree on what it is.
        source:
          'name() = "Synclub Staked BNB", symbol() = SnBNB (slisBNB before the ' +
          "rebrand); listed as the slisBNB underlying by the Venus testnet manifest",
      },
    },
  },
} satisfies Record<string, Venue>;

/** Every venue id the table actually defines. */
export type VenueId = keyof typeof VENUE_TABLE;

export const VENUES: Record<VenueId, Venue> = VENUE_TABLE;

export type SeatPolicy = {
  category: CategoryId;
  seat: string;
  /** Share of mandate capital this seat may spend. */
  capShare: number;
  period: SpendPeriod;
  /**
   * Typed to the ids the table actually defines, not `string[]`.
   *
   * A policy naming a venue that does not exist is a seat that either gets a
   * shorter allowlist than intended or none at all — and an empty allowlist is
   * the wildcard this whole module exists to prevent. A typo here should fail
   * the build, not the grant.
   */
  venues: VenueId[];
  /**
   * Higher preempts lower. The risk officer outranks everyone: when a health
   * factor slips, its recall of capital must beat the allocator's next move.
   */
  priority: number;
};

export const SEAT_POLICIES: SeatPolicy[] = [
  {
    category: "health",
    seat: "Risk officer",
    capShare: 0.35,
    period: "day",
    // Repaying a debt is a call on the market, not on the Comptroller, so the
    // market has to be allowlisted too or the seat cannot do the one thing it
    // exists for.
    venues: ["venus.comptroller", "venus.vusdt", "aave.v3.pool"],
    priority: 100,
  },
  {
    category: "yield",
    seat: "Allocator",
    capShare: 0.3,
    period: "day",
    venues: ["venus.vusdt", "aave.v3.pool", "lista.staking", "lista.slisbnb"],
    priority: 40,
  },
  {
    category: "rebalancing",
    seat: "Market maker",
    capShare: 0.2,
    period: "day",
    venues: ["pancakeswap.v3.positions"],
    priority: 30,
  },
  {
    category: "grid",
    seat: "Execution trader",
    capShare: 0.15,
    period: "day",
    venues: ["pancakeswap.v3.router", "wbnb"],
    priority: 20,
  },
];

export type Mandate = {
  /** Which chain the sessions will be granted on. */
  chainId: number;
  /** Total the user is entrusting, in raw token units. */
  capital: bigint;
  /** Settlement token. Omit for the native coin. */
  token?: Address;
  /** How long the whole mandate runs. */
  durationDays: number;
  /** Unix seconds. Passed in rather than read from the clock so plans are reproducible. */
  now: number;
};

export type SessionPlan = {
  category: CategoryId;
  seat: string;
  priority: number;
  permissions: SessionPermissions;
  expiry: number;
  /** Human-readable, for the control room. */
  explain: string;
};

export class UnsafeMandateError extends Error {}

/**
 * The longest a mandate may run.
 *
 * Without a ceiling, `planMandate` accepted any positive number and then threw
 * a bare `RangeError` from `new Date(...).toISOString()` once the expiry left
 * the range JavaScript can represent — a crash dressed up as a refusal by
 * whatever caught it. The UI already advertised 365 as the maximum; a limit
 * enforced only by a form's `max` attribute is not enforced at all.
 *
 * The number is a product judgement rather than a protocol one: KeyStore
 * stores expiry as a uint40 and would happily accept centuries. A session key
 * that outlives the person who granted it is the failure this module exists
 * to prevent.
 */
export const MAX_DURATION_DAYS = 365;

function resolveVenues(ids: VenueId[], chainId: number): Address[] {
  const unproven: string[] = [];
  const out: Address[] = [];
  for (const id of ids) {
    const v = VENUES[id];
    if (!v) throw new UnsafeMandateError(`unknown venue "${id}"`);

    const deployment = v.deployments[chainId];
    // Absent means "not deployed on this chain" — a seat legitimately does
    // without it. Present-but-null means "deployed here, never proven", which
    // is the case that must fail closed.
    if (deployment === undefined) continue;
    if (deployment.address === null) unproven.push(`${v.id} (${deployment.source})`);
    else out.push(deployment.address);
  }
  if (unproven.length) {
    throw new UnsafeMandateError(
      `cannot grant a session with unverified venues: ${unproven.join("; ")}`,
    );
  }
  return out;
}

/**
 * Builds one scoped session per seat.
 *
 * Fails closed on every path that would widen authority: an unresolved venue,
 * an empty allowlist, a zero cap, or seat caps that together exceed the
 * mandate. A caller cannot accidentally receive a wildcard session.
 */
export function planMandate(
  mandate: Mandate,
  policies: SeatPolicy[] = SEAT_POLICIES,
): SessionPlan[] {
  if (mandate.capital <= 0n) throw new UnsafeMandateError("mandate capital must be positive");
  if (!Number.isInteger(mandate.durationDays)) {
    throw new UnsafeMandateError("mandate duration must be a whole number of days");
  }
  if (mandate.durationDays <= 0) throw new UnsafeMandateError("mandate duration must be positive");
  if (mandate.durationDays > MAX_DURATION_DAYS) {
    throw new UnsafeMandateError(
      `a mandate cannot run longer than ${MAX_DURATION_DAYS} days (asked for ${mandate.durationDays})`,
    );
  }
  if (!Number.isInteger(mandate.now) || mandate.now <= 0) {
    throw new UnsafeMandateError("mandate `now` must be a positive Unix second");
  }
  if (policies.length === 0) throw new UnsafeMandateError("a mandate needs at least one seat");

  const totalShare = policies.reduce((s, p) => s + p.capShare, 0);
  // Floating point makes an exact 1.0 unreachable; anything above it would let
  // the seats collectively spend more than was entrusted.
  if (totalShare > 1 + 1e-9) {
    throw new UnsafeMandateError(
      `seat caps total ${totalShare.toFixed(3)} of capital — a mandate cannot overcommit`,
    );
  }

  const expiry = mandate.now + mandate.durationDays * 86_400;

  return policies
    .map((p) => {
      const addresses = resolveVenues(p.venues, mandate.chainId);
      if (addresses.length === 0) {
        throw new UnsafeMandateError(
          `${p.seat} has no venue proven on chain ${mandate.chainId} — ` +
            `an empty allowlist is a wildcard session`,
        );
      }

      const limit = (mandate.capital * BigInt(Math.round(p.capShare * 10_000))) / 10_000n;
      if (limit <= 0n) {
        throw new UnsafeMandateError(`${p.seat} would receive a zero spend cap`);
      }

      const calls: CallPermission[] = addresses.map((to) => ({ to }));
      const spend: SpendPermission[] = [{ limit, period: p.period, token: mandate.token }];

      return {
        category: p.category,
        seat: p.seat,
        priority: p.priority,
        permissions: { calls, spend },
        expiry,
        explain:
          `${p.seat} may call ${addresses.length} contract${addresses.length === 1 ? "" : "s"} ` +
          `and spend at most ${limit} per ${p.period}, until ${new Date(expiry * 1000)
            .toISOString()
            .slice(0, 10)}.`,
      } satisfies SessionPlan;
    })
    .sort((a, b) => b.priority - a.priority);
}

export type Preemption = {
  /** Seat whose authority is being cut. */
  target: CategoryId;
  /** Seat invoking the cut. */
  by: CategoryId;
  /** The session to revoke, then re-grant with these narrowed permissions. */
  narrowed: SessionPermissions;
  reason: string;
};

/**
 * Shrinks a seat's spend cap so a higher-priority seat can recall capital.
 *
 * Altana has no "amend a session" call, so preemption is revoke-then-regrant.
 * Expressed as data rather than executed here, so the control room can show
 * the user exactly what is about to change before it happens.
 */
export function preempt(
  plans: SessionPlan[],
  by: CategoryId,
  target: CategoryId,
  factor: number,
  reason: string,
): Preemption {
  if (factor < 0 || factor >= 1) {
    throw new UnsafeMandateError("preemption factor must shrink the cap (0 <= factor < 1)");
  }

  const caller = plans.find((p) => p.category === by);
  const victim = plans.find((p) => p.category === target);
  if (!caller) throw new UnsafeMandateError(`${by} holds no seat in this mandate`);
  if (!victim) throw new UnsafeMandateError(`${target} holds no seat in this mandate`);
  if (caller.priority <= victim.priority) {
    throw new UnsafeMandateError(
      `${by} does not outrank ${target} — only a higher-priority seat may preempt`,
    );
  }

  const spend = (victim.permissions.spend ?? []).map((s) => ({
    ...s,
    limit: (s.limit * BigInt(Math.round(factor * 10_000))) / 10_000n,
  }));

  return {
    target,
    by,
    narrowed: { calls: victim.permissions.calls, spend },
    reason,
  };
}
