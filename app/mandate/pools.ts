import { parseAbi, type Address } from "viem";
// Relative imports and no `server-only`, matching `rates.ts` beside it: both
// are read by `npm run check` and by plain Node scripts, and a guard that
// makes the module unimportable would make the arithmetic below untestable.
import { publicClientFor } from "../../lib/rpc.ts";
import { VENUES, USDT_BSC } from "../../lib/mandate.ts";
import { memo } from "../../lib/memo.ts";
import type { VenueReading } from "./health.ts";

/**
 * What the market-maker seat is actually looking at.
 *
 * The lending seats have printed today's Venus and Aave rates, read against a
 * named block, since the round that added `rates.ts`. The market-maker seat
 * had a cap and an allowlist and no number at all — it named two PancakeSwap
 * contracts it was permitted to call and said nothing about what calling them
 * would meet. A cap over a venue nobody has looked at is a limit on an
 * imaginary position.
 *
 * So the pool is read the same way the rates are: on-chain, at a block that is
 * printed beside the figure, with no price feed and no aggregator in between.
 * `slot0` and `liquidity` are the two things a maker needs before quoting —
 * where the pool is, and how much is standing at that price.
 *
 * The factory address is not new here: `VENUES` already records it as the
 * evidence that the positions manager and the router belong together
 * (`factory() = 0x0BFbCF9f…`), proven by `npm run verify:venues`. Asking it
 * for the pool keeps the whole chain of custody inside what this project has
 * already checked.
 */

const FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
]);

/**
 * PancakeSwap V3's own factory on BSC, as `VENUES` records it against both the
 * positions manager and the router.
 */
const V3_FACTORY: Record<number, Address> = {
  56: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  97: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
};

const WBNB: Record<number, Address> = {
  56: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  97: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
};

/**
 * The tier this seat is quoted against.
 *
 * All four PancakeSwap tiers hold a live WBNB/USDT pool on BSC — 0.01%, 0.05%,
 * 0.25% and 1%, checked 2026-09-01 — and 0.05% is where the pair trades. The
 * others are read too, because a maker choosing a tier wants to see the
 * liquidity standing in each rather than be told which one to use.
 */
const FEE_TIERS = [100, 500, 2500, 10_000] as const;

const POOLS_TTL_MS = 5 * 60_000;

export type PoolReading = {
  feeBps: number;
  address: Address;
  /** USDT per WBNB, from `slot0` alone. */
  usdtPerBnb: number;
  /** `liquidity()`: what is standing in range right now, in the pool's units. */
  liquidity: bigint;
};

export type PoolQuotes = {
  chainId: number;
  readAt: { block: bigint; timestamp: number };
  pair: string;
  pools: VenueReading<PoolReading[]>;
};

/**
 * USDT per WBNB from a V3 `sqrtPriceX96`.
 *
 * `sqrtPriceX96` is the square root of token1/token0 in Q64.96, so the price
 * is that squared — and then inverted or not depending on which token the pool
 * sorted first. On BSC mainnet USDT sorts before WBNB, so the raw figure is
 * BNB per USDT and the inversion is the one that matters; on another chain, or
 * for another pair, it is the other way round. Both tokens here carry 18
 * decimals, so no decimal correction is needed — a pair where they differ
 * would need one, and this function would be wrong for it.
 *
 * Pulled out as its own function because it is the only arithmetic on this
 * page that can be silently wrong: a mis-inverted price is not an error, it is
 * a plausible number that is upside down.
 */
export function usdtPerBnbFrom(sqrtPriceX96: bigint, token0: string, chainId: number): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const token1PerToken0 = ratio * ratio;
  const token0IsBnb = token0.toLowerCase() === WBNB[chainId]?.toLowerCase();
  return token0IsBnb ? token1PerToken0 : 1 / token1PerToken0;
}

/** `689.37`, which is as much precision as a quote is worth reading. */
export function quote(usdtPerBnb: number): string {
  return usdtPerBnb.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * `3,212,703,738,990,154,297,713,089` is not a number anyone reads. In-range
 * liquidity is a Q128 quantity whose units depend on the pair, so it is shown
 * in the order of magnitude that lets two tiers be compared and nothing more
 * is claimed for it.
 */
export function magnitude(liquidity: bigint): string {
  const digits = liquidity.toString().length;
  return digits <= 1 ? liquidity.toString() : `10^${digits - 1}`;
}

function failed(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) };
}

/** The WBNB/USDT pools this seat may trade through, read at one block. */
export function readPools(chainId: number): Promise<PoolQuotes> {
  return memo(`pools:${chainId}`, POOLS_TTL_MS, async () => {
    const rpc = publicClientFor(chainId);
    const latest = await rpc.getBlock();
    const factory = V3_FACTORY[chainId];
    const bnb = WBNB[chainId];
    const readAt = { block: latest.number, timestamp: Number(latest.timestamp) };

    if (!factory || !bnb || !VENUES["pancakeswap.v3.router"].deployments[chainId]) {
      return {
        chainId,
        readAt,
        pair: "WBNB/USDT",
        pools: failed(new Error(`PancakeSwap V3 has no proven deployment on chain ${chainId}`)),
      };
    }

    try {
      const found = await Promise.all(
        FEE_TIERS.map(async (fee) => {
          const address = await rpc.readContract({
            address: factory,
            abi: FACTORY_ABI,
            functionName: "getPool",
            args: [bnb, USDT_BSC, fee],
            blockNumber: latest.number,
          });
          if (/^0x0{40}$/i.test(address)) return null;
          const [slot0, liquidity, token0] = await Promise.all([
            rpc.readContract({ address, abi: POOL_ABI, functionName: "slot0", blockNumber: latest.number }),
            rpc.readContract({ address, abi: POOL_ABI, functionName: "liquidity", blockNumber: latest.number }),
            rpc.readContract({ address, abi: POOL_ABI, functionName: "token0", blockNumber: latest.number }),
          ]);
          return {
            feeBps: fee,
            address,
            usdtPerBnb: usdtPerBnbFrom(slot0[0], token0, chainId),
            liquidity,
          } as PoolReading;
        }),
      );
      const pools = found.filter((p): p is PoolReading => p !== null);
      if (pools.length === 0) throw new Error("the factory named no WBNB/USDT pool at any fee tier");
      return { chainId, readAt, pair: "WBNB/USDT", pools: { ok: true, value: pools } };
    } catch (e) {
      return { chainId, readAt, pair: "WBNB/USDT", pools: failed(e) };
    }
  });
}
