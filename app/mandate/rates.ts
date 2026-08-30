import { parseAbi } from "viem";
// Relative, not `@/`: `health.ts` beside this file is imported by a plain
// Node script, and this may be one day.
import { publicClientFor } from "../../lib/rpc.ts";
import { VENUES, USDT_BSC } from "../../lib/mandate.ts";
import { memo } from "../../lib/memo.ts";
import type { VenueReading } from "./health.ts";

/**
 * What the two lending venues pay and charge for USDT, right now.
 *
 * Part B prints a seat's allowlist and its cap; beside the venues that
 * lend, it prints what those venues are paying today, so "the allocator may
 * put 3,000 USDT/day into Venus" sits next to what Venus does with it. Read
 * live, never remembered: a rate typed into the source would be wrong by the
 * time the page was deployed.
 *
 * Venus quotes per block and the block is not a unit of time. BSC has
 * shortened it twice in a year (three seconds, then 0.75, then 0.45), so the
 * cadence is measured from two block timestamps rather than assumed: ten
 * thousand blocks apart, which is under an hour at today's pace. Aave
 * quotes per second in ray, which needs no clock.
 */

const VTOKEN_ABI = parseAbi([
  "function supplyRatePerBlock() view returns (uint256)",
  "function borrowRatePerBlock() view returns (uint256)",
]);

const AAVE_POOL_ABI = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

/** Blocks between the two timestamps the cadence is measured over. */
const CADENCE_SPAN = 10_000n;
const RATES_TTL_MS = 5 * 60_000;

export type Apr = { supplyApr: number; borrowApr: number };

export type VenueRates = {
  chainId: number;
  /** The block the rates were read against, and its timestamp in Unix seconds. */
  readAt: { block: bigint; timestamp: number };
  blocksPerDay: number;
  venus: VenueReading<Apr>;
  aave: VenueReading<Apr>;
};

/** Blocks per day, from two blocks and the seconds between them. */
export function blocksPerDayBetween(span: bigint, seconds: number): number {
  if (seconds <= 0) throw new RangeError("the newer block must be later than the older one");
  return (Number(span) / seconds) * 86_400;
}

/** A Venus per-block rate (1e18 = 100% per block) as a simple annual rate. */
export function annualise(ratePerBlock: bigint, blocksPerDay: number): number {
  return (Number(ratePerBlock) / 1e18) * blocksPerDay * 365;
}

/** An Aave ray rate (1e27 = 100% per year) as a fraction. */
export function fromRay(ray: bigint): number {
  return Number(ray) / 1e27;
}

function failed(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) };
}

export function readRates(chainId: number): Promise<VenueRates> {
  return memo(`rates:${chainId}`, RATES_TTL_MS, async () => {
    const rpc = publicClientFor(chainId);
    const latest = await rpc.getBlock();
    const older = await rpc.getBlock({ blockNumber: latest.number - CADENCE_SPAN });
    const blocksPerDay = blocksPerDayBetween(CADENCE_SPAN, Number(latest.timestamp - older.timestamp));

    const vusdt = VENUES["venus.vusdt"].deployments[chainId]?.address;
    const pool = VENUES["aave.v3.pool"].deployments[chainId]?.address;

    const [venus, aave] = await Promise.all([
      vusdt
        ? Promise.all([
            rpc.readContract({ address: vusdt, abi: VTOKEN_ABI, functionName: "supplyRatePerBlock", blockNumber: latest.number }),
            rpc.readContract({ address: vusdt, abi: VTOKEN_ABI, functionName: "borrowRatePerBlock", blockNumber: latest.number }),
          ])
            .then(([s, b]): VenueReading<Apr> => ({ ok: true, value: { supplyApr: annualise(s, blocksPerDay), borrowApr: annualise(b, blocksPerDay) } }))
            .catch(failed)
        : failed(new Error(`Venus has no proven vUSDT market on chain ${chainId}`)),
      pool
        ? rpc
            .readContract({ address: pool, abi: AAVE_POOL_ABI, functionName: "getReserveData", args: [USDT_BSC], blockNumber: latest.number })
            .then((r): VenueReading<Apr> => ({ ok: true, value: { supplyApr: fromRay(r.currentLiquidityRate), borrowApr: fromRay(r.currentVariableBorrowRate) } }))
            .catch(failed)
        : failed(new Error(`Aave V3 has no proven pool on chain ${chainId}`)),
    ]);

    return { chainId, readAt: { block: latest.number, timestamp: Number(latest.timestamp) }, blocksPerDay, venus, aave };
  });
}

/** `2.63%`: two decimals, which is all a lending rate means day to day. */
export function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}
