/**
 * Chain reads, and the one place the RPC endpoint is chosen.
 *
 * The dataseed URL was hardcoded in three modules, so a dead host meant three
 * edits and a chance to miss one. Worth centralising for a second reason as
 * well: the Altana SDK's own `publicRpcUrl` points at publicnode, which
 * refuses archive requests and answers `Invalid parameters were provided to
 * the RPC method` — an error that reads exactly like a contract rejection.
 * That nearly went into a report as proof a revoked key had been refused,
 * when it was really the RPC declining to answer.
 *
 * So: reads go through here, not through the SDK's default.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import { BSC_MAINNET, BSC_TESTNET, chainName } from "./chains.ts";
import { altanaNetwork } from "./altana.ts";

const RPC_URL: Record<number, string> = {
  [BSC_MAINNET]: "https://bsc-dataseed.bnbchain.org",
  [BSC_TESTNET]: "https://bsc-testnet-dataseed.bnbchain.org",
};

const CHAIN = {
  [BSC_MAINNET]: bsc,
  [BSC_TESTNET]: bscTestnet,
} as const;

const clients = new Map<number, PublicClient>();

/** A read-only client for a chain Kawal supports. */
export function publicClientFor(chainId: number): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;

  const chain = CHAIN[chainId as keyof typeof CHAIN];
  const url = RPC_URL[chainId];
  if (!chain || !url) throw new Error(`no RPC configured for ${chainName(chainId)}`);

  const client = createPublicClient({ chain, transport: http(url) }) as PublicClient;
  clients.set(chainId, client);
  return client;
}

const FEE_ABI = [
  {
    type: "function",
    name: "getRegistrationFeeInWei",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * What the KeyStore controller charges to register one key, right now.
 *
 * Asked rather than remembered. The fee is set on-chain and quoted in wei
 * against a dollar target, so it moves with the BNB price — a number copied
 * into the source would be wrong within a week, and being wrong here means
 * either refusing a run that would have worked or starting one that cannot
 * finish.
 */
async function registrationFee(chainId: number): Promise<bigint> {
  return publicClientFor(chainId).readContract({
    address: altanaNetwork(chainId).keyStoreController,
    abi: FEE_ABI,
    functionName: "getRegistrationFeeInWei",
  });
}

/**
 * What a run costs before it starts: registrations, plus gas for every
 * transaction it intends to send.
 *
 * Callers check this up front because the expensive failure is stopping
 * halfway. `preempt` revokes before it re-grants, and a wallet that empties
 * in that gap leaves the seat with no authority and no way back.
 */
export async function cycleCost(
  chainId: number,
  opts: { keys: number; transactions: number; gasPerTx?: bigint },
): Promise<{ fee: bigint; gas: bigint; total: bigint }> {
  const client = publicClientFor(chainId);
  const [fee, gasPrice] = await Promise.all([registrationFee(chainId), client.getGasPrice()]);
  const gas = gasPrice * (opts.gasPerTx ?? 300_000n) * BigInt(opts.transactions);
  return { fee, gas, total: fee * BigInt(opts.keys) + gas };
}
