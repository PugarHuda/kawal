import { formatUnits, maxUint256, parseAbi, type Address } from "viem";
// Relative, not `@/`: `scripts/preempt.ts` runs this under plain Node,
// which has no path aliases.
import { publicClientFor } from "../../lib/rpc.ts";
import { VENUES, LIQUIDATION_LINE } from "../../lib/mandate.ts";

/**
 * The risk officer's eyes: the mandate wallet's lending position, read from
 * the two venues its seat is allowed to call.
 *
 * `lib/mandate.ts` deliberately touches no chain, so the read lives here,
 * beside the page that shows it; `scripts/preempt.ts` imports the same
 * function so the number that decides a cut on-chain is the number printed
 * on the form. The addresses are the proven ones from the venue table — no
 * address is typed here.
 *
 * Aave answers with a health factor directly. With no debt it answers
 * `type(uint256).max`, which is not "infinitely healthy" but "nothing to
 * divide by", and is reported as no position rather than as a number. Venus
 * has no health factor; `getAccountLiquidity` gives the USD the account may
 * still borrow and the USD it is short, and a shortfall above zero is a
 * position already past the line.
 */

const AAVE_POOL_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const VENUS_COMPTROLLER_ABI = parseAbi([
  "function getAccountLiquidity(address account) view returns (uint256 err, uint256 liquidity, uint256 shortfall)",
]);

/** Aave's base currency on the BNB market is USD with 8 decimals. */
const AAVE_BASE_DECIMALS = 8;
/** Venus quotes liquidity and shortfall in 18-decimal USD. */
const VENUS_USD_DECIMALS = 18;

export type VenueReading<T> = { ok: true; value: T } | { ok: false; error: string };

export type HealthReading = {
  wallet: Address;
  aave: VenueReading<{
    /** Null when there is no debt: the contract returns uint max, not a ratio. */
    healthFactor: number | null;
    totalDebtBase: bigint;
    totalCollateralBase: bigint;
  }>;
  venus: VenueReading<{ liquidity: bigint; shortfall: bigint }>;
};

function failed(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) };
}

async function readAave(chainId: number, wallet: Address): Promise<HealthReading["aave"]> {
  const pool = VENUES["aave.v3.pool"].deployments[chainId]?.address;
  if (!pool) return failed(new Error(`Aave V3 has no proven pool on chain ${chainId}`));
  try {
    const [totalCollateralBase, totalDebtBase, , , , healthFactor] = await publicClientFor(chainId).readContract({
      address: pool,
      abi: AAVE_POOL_ABI,
      functionName: "getUserAccountData",
      args: [wallet],
    });
    return {
      ok: true,
      value: {
        healthFactor:
          healthFactor === maxUint256 || totalDebtBase === 0n ? null : Number(formatUnits(healthFactor, 18)),
        totalDebtBase,
        totalCollateralBase,
      },
    };
  } catch (e) {
    return failed(e);
  }
}

async function readVenus(chainId: number, wallet: Address): Promise<HealthReading["venus"]> {
  const comptroller = VENUES["venus.comptroller"].deployments[chainId]?.address;
  if (!comptroller) return failed(new Error(`Venus has no proven Comptroller on chain ${chainId}`));
  try {
    const [err, liquidity, shortfall] = await publicClientFor(chainId).readContract({
      address: comptroller,
      abi: VENUS_COMPTROLLER_ABI,
      functionName: "getAccountLiquidity",
      args: [wallet],
    });
    if (err !== 0n) return failed(new Error(`Venus Comptroller answered error code ${err}`));
    return { ok: true, value: { liquidity, shortfall } };
  } catch (e) {
    return failed(e);
  }
}

export async function readHealth(chainId: number, wallet: Address): Promise<HealthReading> {
  const [aave, venus] = await Promise.all([readAave(chainId, wallet), readVenus(chainId, wallet)]);
  return { wallet, aave, venus };
}

/**
 * The one number the rule runs on, or null when there is no debt anywhere.
 *
 * Aave's factor is used as read. A Venus shortfall has no factor to give,
 * but it means the account is already past the line, so it is reported as
 * the line itself and the rule recalls everything.
 */
export function effectiveHealthFactor(r: HealthReading): number | null {
  if (r.venus.ok && r.venus.value.shortfall > 0n) return LIQUIDATION_LINE;
  if (r.aave.ok && r.aave.value.healthFactor !== null) return r.aave.value.healthFactor;
  return null;
}

/** One typed line per venue, for the form and for the script's console. */
export function describeHealth(r: HealthReading): string[] {
  const usd = (v: bigint, decimals: number) => `$${Number(formatUnits(v, decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return [
    r.aave.ok
      ? r.aave.value.healthFactor === null
        ? `Aave V3: no debt, nothing to protect (collateral ${usd(r.aave.value.totalCollateralBase, AAVE_BASE_DECIMALS)})`
        : `Aave V3: health factor ${r.aave.value.healthFactor.toFixed(2)}, debt ${usd(r.aave.value.totalDebtBase, AAVE_BASE_DECIMALS)}`
      : `Aave V3: could not be read (${r.aave.error})`,
    r.venus.ok
      ? r.venus.value.shortfall > 0n
        ? `Venus: ${usd(r.venus.value.shortfall, VENUS_USD_DECIMALS)} short of its collateral requirement`
        : r.venus.value.liquidity > 0n
          ? `Venus: ${usd(r.venus.value.liquidity, VENUS_USD_DECIMALS)} of borrowing room, no shortfall`
          : "Venus: no position"
      : `Venus: could not be read (${r.venus.error})`,
  ];
}
