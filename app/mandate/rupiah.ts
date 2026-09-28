import { parseAbi, type Address } from "viem";
// Relative imports, matching `pools.ts` beside it: `npm run check` imports
// the arithmetic below and must not need the app's path aliases.
import { publicClientFor } from "../../lib/rpc.ts";
import { USDT_BSC } from "../../lib/mandate.ts";
import { memo } from "../../lib/memo.ts";

/**
 * A spend cap in rupiah, read from the chain.
 *
 * Every cap on the mandate is in USDT, and somebody in Jakarta deciding how
 * much to let an agent spend a day thinks in rupiah. The rate comes from the
 * same place the market-maker seat's quotes do — PancakeSwap V3's own factory
 * — asked for the IDRX/USDT pool. IDRX is a rupiah-pegged token on BSC;
 * checked 2026-09-28, the 0.05% pool quoted 17,908 against 17,921 from a
 * USD/IDR FX feed.
 *
 * What it is not: an FX rate. It is where one thin pool (about $29,000 on both
 * sides that day) priced IDRX against USDT at a named block, so the page
 * prints the depth beside it and calls the figure approximate.
 */

const FACTORY: Address = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
export const IDRX_BSC: Address = "0x649a2DA7B28E0D54c13D5eFf95d3A660652742cC";
const FEE = 500;

const FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);

export type Rupiah = {
  idrPerUsdt: number;
  pool: Address;
  /** What the pool holds, so a reader can judge how much weight the price bears. */
  depthUsdt: number;
  readAt: { block: bigint; timestamp: number };
};

/**
 * IDR per USDT from a V3 `sqrtPriceX96`.
 *
 * The raw price is token1/token0 in base units. USDT carries 18 decimals and
 * IDRX 0, so a raw IDRX-per-USDT figure is 1e18 too small; which way the pair
 * sorted decides whether it is inverted first. Its own function for the same
 * reason `usdtPerBnbFrom` is: an upside-down price is a plausible number.
 */
export function idrPerUsdtFrom(sqrtPriceX96: bigint, token0: string, usdtDecimals: number, idrDecimals: number): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const raw = ratio * ratio; // token1 base units per token0 base unit
  const usdtFirst = token0.toLowerCase() === USDT_BSC.toLowerCase();
  const idrRawPerUsdtRaw = usdtFirst ? raw : 1 / raw;
  return idrRawPerUsdtRaw * 10 ** (usdtDecimals - idrDecimals);
}

/** `Rp 62.680.000`, the way the figure is written in Indonesia. */
export function rupiah(idr: number): string {
  return `Rp ${Math.round(idr).toLocaleString("id-ID")}`;
}

export function readRupiah(): Promise<Rupiah> {
  return memo("rupiah:56", 5 * 60_000, async () => {
    const rpc = publicClientFor(56);
    const latest = await rpc.getBlock();
    const at = { blockNumber: latest.number };
    const pool = await rpc.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [USDT_BSC, IDRX_BSC, FEE], ...at });
    if (/^0x0{40}$/i.test(pool)) throw new Error("the factory names no IDRX/USDT 0.05% pool");
    const [slot0, token0, idrDecimals, usdtDecimals, usdtHeld, idrHeld] = await Promise.all([
      rpc.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0", ...at }),
      rpc.readContract({ address: pool, abi: POOL_ABI, functionName: "token0", ...at }),
      rpc.readContract({ address: IDRX_BSC, abi: ERC20_ABI, functionName: "decimals", ...at }),
      rpc.readContract({ address: USDT_BSC, abi: ERC20_ABI, functionName: "decimals", ...at }),
      rpc.readContract({ address: USDT_BSC, abi: ERC20_ABI, functionName: "balanceOf", args: [pool], ...at }),
      rpc.readContract({ address: IDRX_BSC, abi: ERC20_ABI, functionName: "balanceOf", args: [pool], ...at }),
    ]);
    const idrPerUsdt = idrPerUsdtFrom(slot0[0], token0, usdtDecimals, idrDecimals);
    const depthUsdt = Number(usdtHeld) / 10 ** usdtDecimals + Number(idrHeld) / 10 ** idrDecimals / idrPerUsdt;
    return { idrPerUsdt, pool, depthUsdt, readAt: { block: latest.number, timestamp: Number(latest.timestamp) } };
  });
}
