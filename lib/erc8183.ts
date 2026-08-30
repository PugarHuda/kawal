/**
 * Hiring an ERC-8183 seller from Kawal's wallet.
 *
 * ERC-8183 is the escrow rail the BSC agent economy actually uses: a buyer
 * funds a Job in $U on the AgenticCommerce kernel, the seller submits a
 * deliverable, and after an optimistic dispute window the escrow is released.
 * The 46 A2A-only agents Kawal lists are its sellers, and until now the site
 * could verify them but not hire one.
 *
 * The Altana SDK batches the buyer's five calls (createJob, registerJob,
 * setBudget, approve $U, fund) into one atomic relay intent, signed by the
 * admin key or by a scoped session key. This module wraps that with Kawal's
 * own key handling and adds the one thing the SDK does not offer: a dry run
 * that simulates the whole batch, in order, from the wallet that would send
 * it, and says exactly what is short.
 *
 * Interface, kept small so a page can render a job panel from it:
 *
 *   hireQuote({ provider, task, budgetRaw })          read-only; simulates, prices, reports the shortfall
 *   hireAgent({ provider, task, budgetRaw, seat? })   funds the job; returns the jobId and the relay result
 *   jobStatus(jobId)                                  read-only; the job plus its deliverable URL once submitted
 *   settleJob({ jobId, action?, seat? })              "approve" releases the escrow, "dispute" contests it
 *   claimRefund({ jobId, seat? })                     reclaims escrow after `expiredAt` with nothing delivered
 *   recentJobs({ limit })                             read-only; the newest N jobs, walked down from the counter
 *   marketSummary()                                   read-only; those jobs counted by status, budget and provider
 *   uHeld(address)                                    read-only; the $U an address holds, the coin every budget is in
 *
 * The market is read by job id, not by logs. The public dataseed refuses a
 * `getLogs` over even 5,000 blocks ("Request exceeds defined limit"), and the
 * kernel numbers jobs from 1 with no gaps, so `jobCounter()` and N calls to
 * `getJob` are the whole index: sixty jobs took 2.4 s cold at eight in
 * flight, and the answer is memoised for five minutes.
 *
 * Every write takes an optional ledger seat. Given one, the session key
 * signs — which only works for a seat whose allowlist names the kernel, the
 * router and $U; the four seats granted so far do not, so today the admin
 * key is the buyer. `seat.sessionPrivateKey` must be a real key, not the
 * "0x" the pushed ledger carries.
 */

import { formatUnits, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildClaimRefundCall,
  buildHireCalls,
  erc8183Addresses,
  getErc8183DeliverableUrl,
  getErc8183Job,
  hireErc8183Agent,
  settleErc8183Job,
  signerFromPrivateKey,
  JOB_STATUS,
  type Erc8183Addresses,
  type Erc8183Job,
  type HireAgentResult,
  type ExecuteResult,
  type JobStatusName,
  type Session,
  type Signer,
} from "@altananetwork/sdk";
import { altanaNetwork, clientFor, sessionFromSeat } from "./altana.ts";
import { BSC_MAINNET } from "./chains.ts";
import { mapLimit } from "./concurrency.ts";
import { memo } from "./memo.ts";
import { publicClientFor } from "./rpc.ts";
import { adminKey, hasAdminKey, type LedgerSeat } from "./vault.ts";

export { ERC8183_ADDRESSES, JOB_STATUS, type Erc8183Job, type JobStatusName } from "@altananetwork/sdk";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const POLICY = parseAbi(["function disputeWindow() view returns (uint64)"]);
const COMMERCE = parseAbi([
  "function jobCounter() view returns (uint256)",
  // The SDK's own `getJob` reads through its default RPC (publicnode), which
  // lib/rpc.ts explains is the one host that answers archive-ish reads with
  // an error that looks like a revert. Same ABI, Kawal's endpoint.
  "function getJob(uint256 jobId) view returns ((uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook, uint256 submittedAt, bytes32 deliverable))",
]);

/** $U carries 18 decimals on both BSC chains. */
export const U_DECIMALS = 18;

/**
 * Extra submission time past the dispute window, in seconds. The SDK's
 * default; mirrors `bag erc8183 buy --deadline-min 30`.
 */
const DEADLINE_SECONDS = 1800;

/** Which key signs: a seat's session, or the admin key behind the wallet. */
type Buyer = { seat?: LedgerSeat; chainId?: number };

type Resolved =
  | { chainId: number; network: ReturnType<typeof altanaNetwork>; address: Address; session: Session }
  | { chainId: number; network: ReturnType<typeof altanaNetwork>; address: Address; signer: Signer };

function buyerOf(b: Buyer): Resolved {
  const chainId = b.chainId ?? b.seat?.chainId ?? BSC_MAINNET;
  const network = altanaNetwork(chainId);
  if (b.seat) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(b.seat.sessionPrivateKey)) {
      throw new Error(`seat ${b.seat.seat} carries no session key on this machine; the pushed ledger cannot drive a seat`);
    }
    return { chainId, network, session: sessionFromSeat(b.seat), address: b.seat.walletAddress as Address };
  }
  const key = adminKey();
  return {
    chainId,
    network,
    signer: signerFromPrivateKey(key),
    // The Altana wallet is the EOA itself under EIP-7702, so the admin key's
    // address is the wallet address — the same identity every seat names.
    address: privateKeyToAccount(key).address,
  };
}

export type HireQuote = {
  chainId: number;
  buyer: Address;
  addresses: Erc8183Addresses;
  /** Bytecode sizes at each address, so a wrong constant reads as 0 rather than as a revert later. */
  deployed: Record<keyof Erc8183Addresses, number>;
  disputeWindow: bigint;
  /** The id the batch will claim: `jobCounter() + 1`. */
  jobId: bigint;
  expiredAt: bigint;
  budgetRaw: bigint;
  balanceRaw: bigint;
  /** $U the wallet is short for this budget; 0n when it can fund. */
  shortfallRaw: bigint;
  /** Each of the five calls, simulated in order from the buyer. */
  calls: Array<{ name: string; to: Address; status: "success" | "failure"; gasUsed: bigint; error: string | null }>;
  gasTotal: bigint;
};

const CALL_NAMES = ["createJob", "registerJob", "setBudget", "approve $U", "fund"] as const;

/**
 * Prices a hire without sending it.
 *
 * The five calls are simulated as one sequence from the buyer's address
 * (`eth_simulateV1`, which the BSC dataseed answers), so `setBudget` and
 * `fund` run against the job `createJob` just made rather than against
 * nothing. A revert names the call and the reason — with an empty $U balance
 * that is `fund`, and the shortfall printed beside it is the exact amount.
 */
export async function hireQuote(opts: { provider: Address; task: string; budgetRaw: bigint; buyer?: Address; chainId?: number }): Promise<HireQuote> {
  const chainId = opts.chainId ?? BSC_MAINNET;
  const addresses = erc8183Addresses(chainId);
  const rpc = publicClientFor(chainId);
  const buyer = opts.buyer ?? privateKeyToAccount(adminKey()).address;

  const [disputeWindow, jobCounter, balanceRaw, ...codes] = await Promise.all([
    rpc.readContract({ address: addresses.policy, abi: POLICY, functionName: "disputeWindow" }),
    rpc.readContract({ address: addresses.commerce, abi: COMMERCE, functionName: "jobCounter" }),
    rpc.readContract({ address: addresses.paymentToken, abi: ERC20, functionName: "balanceOf", args: [buyer] }),
    ...(Object.keys(addresses) as Array<keyof Erc8183Addresses>).map((k) =>
      rpc.getCode({ address: addresses[k] }).then((c) => (c ? (c.length - 2) / 2 : 0)),
    ),
  ]);
  const deployed = Object.fromEntries(
    (Object.keys(addresses) as Array<keyof Erc8183Addresses>).map((k, i) => [k, codes[i] ?? 0]),
  ) as HireQuote["deployed"];

  const jobId = jobCounter + 1n;
  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(disputeWindow) + BigInt(DEADLINE_SECONDS);
  const calls = buildHireCalls({ addresses, jobId, provider: opts.provider, description: opts.task, budget: opts.budgetRaw, expiredAt });

  const { results } = await rpc.simulateCalls({
    account: buyer,
    calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
  });

  const simulated = results.map((r, i) => ({
    name: CALL_NAMES[i] ?? `call ${i}`,
    to: calls[i]!.to,
    status: r.status,
    gasUsed: r.gasUsed,
    error: r.error ? (r.error as { shortMessage?: string; message: string }).shortMessage ?? r.error.message : null,
  }));

  return {
    chainId,
    buyer,
    addresses,
    deployed,
    disputeWindow,
    jobId,
    expiredAt,
    budgetRaw: opts.budgetRaw,
    balanceRaw,
    shortfallRaw: balanceRaw >= opts.budgetRaw ? 0n : opts.budgetRaw - balanceRaw,
    calls: simulated,
    gasTotal: simulated.reduce((n, c) => n + c.gasUsed, 0n),
  };
}

/** Funds a job. Resolves once the kernel reports it FUNDED. */
export async function hireAgent(opts: { provider: Address; task: string; budgetRaw: bigint } & Buyer): Promise<HireAgentResult> {
  const b = buyerOf(opts);
  const params = { provider: opts.provider, task: opts.task, budget: opts.budgetRaw, deadlineSeconds: DEADLINE_SECONDS };
  return "session" in b
    ? hireErc8183Agent(b.session, params, { network: b.network })
    : hireErc8183Agent({ address: b.address }, b.signer, params, { network: b.network });
}

/** A job as the kernel holds it, plus where its deliverable is once one was submitted. */
export async function jobStatus(jobId: bigint, chainId = BSC_MAINNET): Promise<Erc8183Job & { deliverableUrl: string | null }> {
  const network = altanaNetwork(chainId);
  const job = await getErc8183Job(network, jobId);
  const deliverableUrl = job.submittedAt > 0n ? ((await getErc8183DeliverableUrl(network, jobId).catch(() => undefined)) ?? null) : null;
  return { ...job, deliverableUrl };
}

/** Releases the escrow ("approve", after the dispute window) or contests it ("dispute", inside it). */
export async function settleJob(opts: { jobId: bigint; action?: "approve" | "dispute" } & Buyer): Promise<ExecuteResult> {
  const b = buyerOf(opts);
  const params = { jobId: opts.jobId, action: opts.action };
  return "session" in b
    ? settleErc8183Job(b.session, params, { network: b.network })
    : settleErc8183Job({ address: b.address }, b.signer, params, { network: b.network });
}

/** Takes the escrow back from a job whose seller never delivered, once `expiredAt` has passed. */
export async function claimRefund(opts: { jobId: bigint } & Buyer): Promise<ExecuteResult> {
  const b = buyerOf(opts);
  const call = buildClaimRefundCall(b.chainId, opts.jobId);
  const client = clientFor(b.chainId);
  return "session" in b
    ? client.execute({ session: b.session, calls: call, chainId: b.chainId })
    : client.execute({ wallet: { address: b.address }, signer: b.signer, calls: call, chainId: b.chainId });
}

/** $U, printed for a person. */
export function formatU(raw: bigint) {
  return `${formatUnits(raw, U_DECIMALS)} $U`;
}

/** The wallet the admin key would buy from, or null on an instance without one. */
export function buyerAddress(): Address | null {
  return hasAdminKey() ? privateKeyToAccount(adminKey()).address : null;
}

/** $U an address holds, raw. The coin every ERC-8183 budget is escrowed in. */
export function uHeld(address: Address, chainId = BSC_MAINNET): Promise<bigint> {
  return publicClientFor(chainId).readContract({
    address: erc8183Addresses(chainId).paymentToken,
    abi: ERC20,
    functionName: "balanceOf",
    args: [address],
  });
}

/* ------------------------------------------------------- the market --- */

/**
 * A job as the walk reads it. The SDK types `statusName` as always one of
 * the six; its own implementation falls back to "UNKNOWN" for a status the
 * enum does not name, and so does this, with the type saying so.
 */
export type MarketJob = Omit<Erc8183Job, "statusName"> & { statusName: JobStatusName | "UNKNOWN" };

/** How many of the newest jobs the market window reads by default. */
export const MARKET_WINDOW = 60;
const MARKET_TTL_MS = 5 * 60_000;
/** Reads in flight against the dataseed at once. */
const READ_LIMIT = 8;

export type RecentJobs = {
  chainId: number;
  /** `jobCounter() + 1`: the id the next `createJob` will take. */
  nextJobId: bigint;
  /** Newest first. */
  jobs: MarketJob[];
  readAt: string;
};

/** The newest `limit` jobs on the kernel, walked down from the counter. */
export function recentJobs(opts: { limit?: number; chainId?: number } = {}): Promise<RecentJobs> {
  const chainId = opts.chainId ?? BSC_MAINNET;
  // Capped: two hundred reads is the most a page should wait on, memoised or not.
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? MARKET_WINDOW), 200));
  return memo(`erc8183:recent:${chainId}:${limit}`, MARKET_TTL_MS, async () => {
    const rpc = publicClientFor(chainId);
    const commerce = erc8183Addresses(chainId).commerce;
    const counter = await rpc.readContract({ address: commerce, abi: COMMERCE, functionName: "jobCounter" });
    const count = counter < BigInt(limit) ? Number(counter) : limit;
    const ids = Array.from({ length: count }, (_, i) => counter - BigInt(i));
    const jobs = await mapLimit(ids, READ_LIMIT, async (id): Promise<MarketJob> => {
      const job = await rpc.readContract({ address: commerce, abi: COMMERCE, functionName: "getJob", args: [id] });
      return { ...job, statusName: JOB_STATUS[job.status] ?? "UNKNOWN" };
    });
    return { chainId, nextJobId: counter + 1n, jobs, readAt: new Date().toISOString() };
  });
}

export type MarketSummary = RecentJobs & {
  byStatus: Record<JobStatusName, number>;
  /** Sum of every budget in the window, raw $U. */
  budgetRaw: bigint;
  /** Distinct sellers in the window. */
  providers: number;
};

/** Counts a window of jobs. Pure, so the self-check can pin it. */
export function summariseMarket(recent: RecentJobs): MarketSummary {
  const byStatus = Object.fromEntries(JOB_STATUS.map((s) => [s, 0])) as Record<JobStatusName, number>;
  const providers = new Set<string>();
  let budgetRaw = 0n;
  for (const job of recent.jobs) {
    if (job.statusName !== "UNKNOWN") byStatus[job.statusName] += 1;
    budgetRaw += job.budget;
    providers.add(job.provider.toLowerCase());
  }
  return { ...recent, byStatus, budgetRaw, providers: providers.size };
}

/** The market as the newest `limit` jobs describe it. */
export async function marketSummary(opts: { limit?: number; chainId?: number } = {}): Promise<MarketSummary> {
  return summariseMarket(await recentJobs(opts));
}
