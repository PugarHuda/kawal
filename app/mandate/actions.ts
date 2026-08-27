"use server";

import { revalidatePath } from "next/cache";
import { revokeSeat, hasAdminKey } from "@/lib/sessions";
import { assertOperator, unlock, lock } from "@/lib/operator";

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

  // An instance can hold the operator token and not the wallet key — a
  // read-only deployment, or one where the key was never installed. Without
  // this the button was offered, the operator unlocked, and the click threw
  // an uncaught MissingAdminKeyError straight into a 500.
  if (!hasAdminKey()) {
    throw new Error(
      "This instance holds no admin key, so it cannot revoke. Sessions can only be revoked where the wallet key lives.",
    );
  }

  const publicKey = formData.get("publicKey");
  if (typeof publicKey !== "string" || !publicKey) return;

  await revokeSeat(publicKey);
  revalidatePath("/mandate");
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
