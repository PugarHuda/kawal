/**
 * Who is allowed to spend the operator's authority.
 *
 * The control room revokes real session keys with the admin key this server
 * holds. Next's own guidance is blunt about what that means: "Server
 * Functions are reachable via direct POST requests, not just through your
 * application's UI. Always verify authentication and authorization inside
 * every Server Function." Kawal's revoke action had no check at all, so a
 * single anonymous POST to a deployed instance could destroy authority the
 * operator paid for — and KeyStore revocation is monotonic in v1.0.0, so the
 * seat cannot be revived, only re-granted at the registration fee again.
 *
 * Fails closed by design. With no `KAWAL_OPERATOR_TOKEN` configured, nobody
 * is the operator and the destructive path is simply unavailable — an
 * instance deployed without reading the setup notes is inert rather than
 * exposed.
 */

import "server-only";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";

const COOKIE = "kawal_operator";

/** Constant-time compare, so a wrong token cannot be found one byte at a time. */
function sameSecret(a: string, b: string) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself leak the
  // length, so pad both sides to a fixed width first.
  const width = Math.max(left.length, right.length, 32);
  const padLeft = Buffer.alloc(width);
  const padRight = Buffer.alloc(width);
  left.copy(padLeft);
  right.copy(padRight);
  return timingSafeEqual(padLeft, padRight) && left.length === right.length;
}

/** True when the deployment has an operator token configured at all. */
export function operatorConfigured() {
  return Boolean(process.env.KAWAL_OPERATOR_TOKEN);
}

/** True when this request carries the operator's unlock cookie. */
export async function isOperator() {
  const expected = process.env.KAWAL_OPERATOR_TOKEN;
  if (!expected) return false;

  const jar = await cookies();
  const held = jar.get(COOKIE)?.value;
  return Boolean(held) && sameSecret(held!, expected);
}

/**
 * Throws unless the caller is the operator.
 *
 * Every destructive server action calls this first. Written as a throw rather
 * than a boolean so that forgetting to check the return value cannot silently
 * authorise anything.
 */
export async function assertOperator() {
  if (!(await isOperator())) {
    throw new Error(
      "Not authorised. Unlock the control room with the operator token before revoking a session.",
    );
  }
}

export async function unlock(token: string) {
  const expected = process.env.KAWAL_OPERATOR_TOKEN;
  if (!expected || !sameSecret(token, expected)) return false;

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return true;
}

export async function lock() {
  const jar = await cookies();
  jar.delete(COOKIE);
}
