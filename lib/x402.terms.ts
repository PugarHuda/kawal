import { privateKeyToAccount } from "viem/accounts";
import { formatEther, type Address } from "viem";
import { adminKey, hasAdminKey } from "./vault.ts";

/**
 * The terms Kawal charges on, and where the money goes.
 *
 * Split from settlement so the offline suite can assert the challenge without
 * a database or a chain: the document below is the whole public claim, and it
 * is worth checking against Kawal's own reader rather than only against a
 * running server.
 *
 * The other side of the x402 check.
 *
 * Kawal measured that 75 of 200 BSC registrations declare `x402_supported`
 * and that not one of the reachable ones ever asks to be paid. Publishing that
 * finding and then not charging for anything would leave the obvious question
 * unanswered, so this is the counter-example: an endpoint that issues a real
 * payment challenge and, unlike every claimant measured, can actually be paid.
 *
 * Settlement is deliberately the dullest possible mechanism. There is no
 * facilitator, no signature scheme and no allowance: the challenge names an
 * address and an amount, the caller sends a plain BNB transfer, and resends
 * the request carrying the transaction hash. Kawal then reads the chain.
 *
 * That choice is the honest one available. A facilitator-based flow would mean
 * either running one or trusting somebody else's, and a scheme Kawal cannot
 * verify end to end is exactly the kind of unbacked payment claim this whole
 * module exists to be the opposite of. Reading a receipt on the chain the
 * payment happened on is something anyone can reproduce.
 *
 * Three things it will not do:
 *
 *  - Accept a transaction twice. A receipt is a bearer token once it is
 *    public, so spent hashes are kept and refused on sight.
 *  - Accept an unconfirmed transaction. A pending transfer can be dropped.
 *  - Offer to be paid when there is nowhere to pay. With no wallet configured
 *    the endpoint says so and stays free rather than quoting an address it
 *    does not control.
 */

/** Atomic units of BNB. 0.0001 BNB, about seven cents at the time of writing. */
export const PRICE_WEI = 100_000_000_000_000n;

/** CAIP-2 for BSC mainnet, the namespace the challenge is quoted in. */
export const NETWORK = "eip155:56";

/** How long a caller has to pay a quote before it should be re-fetched. */
export const QUOTE_TIMEOUT_SECONDS = 900;

/**
 * Where Kawal takes payment.
 *
 * Derived from the wallet key when the instance holds one, so the address
 * quoted is provably one Kawal can spend from rather than a constant someone
 * pasted. `KAWAL_PAY_TO` overrides for a deployment that keeps the key out of
 * the filesystem. Null when neither is available, which disables charging
 * entirely — see the note above about not quoting an address we do not own.
 */
export function payTo(): Address | null {
  const configured = process.env.KAWAL_PAY_TO;
  if (configured && /^0x[0-9a-fA-F]{40}$/.test(configured)) return configured as Address;
  if (!hasAdminKey()) return null;
  try {
    return privateKeyToAccount(adminKey()).address;
  } catch {
    return null;
  }
}

export type Challenge = {
  x402Version: number;
  error: string;
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
  }>;
  resource: { serviceName: string; description: string };
};

/**
 * The document a caller gets instead of the report.
 *
 * Shaped to what Kawal's own reader parses, because the reader was written
 * against a live q402 challenge rather than against a specification — if this
 * did not survive `readChallenge`, Kawal could not verify its own endpoint,
 * and a payment claim Kawal cannot check is the thing it refuses to publish
 * about anyone else.
 */
export function challenge(to: Address): Challenge {
  return {
    x402Version: 2,
    error: `payment required: send ${formatEther(PRICE_WEI)} BNB to ${to} on BNB Smart Chain, then resend with an X-PAYMENT header carrying the transaction hash`,
    accepts: [
      {
        // Native transfer, verified by reading the receipt. Named plainly
        // rather than borrowed from a scheme Kawal does not implement.
        scheme: "native-transfer",
        network: NETWORK,
        asset: "BNB",
        amount: PRICE_WEI.toString(),
        payTo: to,
        maxTimeoutSeconds: QUOTE_TIMEOUT_SECONDS,
      },
    ],
    resource: {
      serviceName: "Kawal deep report",
      description:
        "Everything Kawal has on one agent: a live handshake, every probe kept, how it fails when it fails, whether it really charges, and who wrote its feedback.",
    },
  };
}
