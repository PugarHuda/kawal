"use server";

import { revalidatePath } from "next/cache";
import { signerFromPrivateKey } from "@altananetwork/sdk";
import { revokeSeat, hasAdminKey, loadLedger } from "@/lib/sessions";
import { adminKey, mutateLedger } from "@/lib/vault";
import { clientFor, grantMandate } from "@/lib/altana";
import { USDT_BSC, MAX_PLANNER_CAPITAL, MAX_DURATION_DAYS, usdtToRaw } from "@/lib/mandate";
import { BSC_MAINNET } from "@/lib/chains";
import { assertOperator, unlock, lock } from "@/lib/operator";
import { hireQuote, hireAgent, formatU, U_DECIMALS } from "@/lib/erc8183";
import { isAddress, parseUnits, type Address } from "viem";

/**
 * Takes a live session away.
 *
 * Authorisation first, and as a throw rather than a check the caller could
 * forget to read. This function permanently destroys a KeyStore registration
 * the operator paid for — revocation is monotonic, so there is no undo, only
 * a fresh grant at the registration fee again.
 *
 * Deliberately does not swallow the outcome: `revokeSeat` records a failed
 * revoke on the seat and the page re-reads the ledger, so a revoke that did
 * not land shows up as still-live with an error rather than as done.
 */
export async function revokeAction(formData: FormData) {
  await assertOperator();
  requireAdminKey("revoke");

  const publicKey = formData.get("publicKey");
  if (typeof publicKey !== "string" || !publicKey) return;

  await revokeSeat(publicKey);
  revalidatePath("/mandate");
}

/**
 * Grants the planned seats on-chain.
 *
 * The same authorisation shape as `revokeAction`, because it spends the same
 * authority: four KeyStore registrations paid from the admin wallet, each a
 * session an agent can move money through. The mandate is rebuilt here from
 * the two numbers the form carries rather than trusted from hidden fields —
 * `planMandate` inside `grantMandate` is what refuses anything unscoped, so
 * a POST that skips the page cannot get a wider session than the page shows.
 *
 * Written through `mutateLedger` seat by seat as `grantMandate` returns them,
 * so a partial grant leaves the seats that landed visible in the control
 * room. Failures are thrown after the write, not instead of it.
 */
export async function grantAction(formData: FormData) {
  await assertOperator();
  requireAdminKey("grant");

  const capital = Number(formData.get("capital"));
  const days = Math.round(Number(formData.get("days")));
  if (!Number.isFinite(capital) || capital <= 0 || capital > MAX_PLANNER_CAPITAL) {
    throw new Error(`capital must be between 0 and ${MAX_PLANNER_CAPITAL.toLocaleString("en-US")} USDT`);
  }
  if (!Number.isFinite(days) || days <= 0 || days > MAX_DURATION_DAYS) {
    throw new Error(`duration must be between 1 and ${MAX_DURATION_DAYS} days`);
  }

  const chainId = BSC_MAINNET;
  const adminSigner = signerFromPrivateKey(adminKey());
  const client = clientFor(chainId);
  // The wallet the existing seats were granted from, when there is one; the
  // admin signer's own smart account otherwise. Two wallets on one ledger
  // would be two control rooms on one page.
  const existing = (await loadLedger()).find((s) => s.chainId === chainId);
  const wallet = existing ? { address: existing.walletAddress } : await client.createWallet({ signer: adminSigner });

  const { granted, failures } = await grantMandate({
    client,
    wallet,
    adminSigner,
    mandate: {
      chainId,
      capital: usdtToRaw(capital),
      token: USDT_BSC,
      durationDays: days,
      now: Math.floor(Date.now() / 1000),
    },
  });

  if (granted.length > 0) {
    await mutateLedger((seats) => {
      seats.push(...granted);
    });
  }
  revalidatePath("/mandate");

  if (failures.length > 0) {
    throw new Error(
      `${granted.length} of ${granted.length + failures.length} seats granted; the rest did not land: ${failures.join("; ")}`,
    );
  }
}

/**
 * Hires the agent filling a seat, on ERC-8183, from the admin wallet.
 *
 * Same gate as `grantAction`, because it spends more: a funded job moves $U
 * out of the wallet into the kernel's escrow. The page only offers the stub
 * when the wallet already holds the budget, but a POST can skip the page, so
 * the quote is taken again here and the batch is refused on any shortfall or
 * any simulated revert — nothing is sent that would not land. The job then
 * shows up in Bagian C on the next render, read back off the kernel rather
 * than remembered from here.
 */
export async function hireAction(formData: FormData) {
  await assertOperator();
  requireAdminKey("hire");

  const provider = formData.get("provider");
  const task = formData.get("task");
  const budget = formData.get("budget");
  if (typeof provider !== "string" || !isAddress(provider)) throw new Error("provider must be an address");
  if (typeof task !== "string" || task.trim() === "" || new TextEncoder().encode(task).length > 4096) {
    throw new Error("task must be a non-empty description under 4096 bytes");
  }
  if (typeof budget !== "string" || !/^\d+(\.\d{1,18})?$/.test(budget) || Number(budget) <= 0 || Number(budget) > MAX_PLANNER_CAPITAL) {
    throw new Error(`budget must be between 0 and ${MAX_PLANNER_CAPITAL.toLocaleString("en-US")} $U`);
  }
  const budgetRaw = parseUnits(budget, U_DECIMALS);

  const q = await hireQuote({ provider: provider as Address, task, budgetRaw, chainId: BSC_MAINNET });
  if (q.shortfallRaw > 0n) {
    throw new Error(`the wallet is short ${formatU(q.shortfallRaw)} for this budget; nothing was sent`);
  }
  const revert = q.calls.find((c) => c.status !== "success");
  if (revert) throw new Error(`${revert.name} would revert (${revert.error ?? "no reason given"}); nothing was sent`);

  await hireAgent({ provider: provider as Address, task, budgetRaw, chainId: BSC_MAINNET });
  revalidatePath("/mandate");
}

/**
 * An instance can hold the operator token and not the wallet key — a
 * read-only deployment, or one where the key was never installed. Without
 * this the button was offered, the operator unlocked, and the click threw an
 * uncaught MissingAdminKeyError straight into a 500.
 */
function requireAdminKey(verb: "revoke" | "grant" | "hire") {
  if (!hasAdminKey()) {
    throw new Error(
      `This instance holds no admin key, so it cannot ${verb}. This only happens where the wallet key lives.`,
    );
  }
}

/** Exchanges the operator token for a session cookie. */
export async function unlockAction(formData: FormData) {
  const token = formData.get("token");
  if (typeof token !== "string") return;

  await unlock(token);
  revalidatePath("/mandate");
}

export async function lockAction() {
  await lock();
  revalidatePath("/mandate");
}
