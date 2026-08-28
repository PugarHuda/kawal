import { privateKeyToAccount } from "viem/accounts";
import { formatEther, formatUnits, type Address } from "viem";
import { buildChallenge, U_TOKEN, USDT_BSC, type MerchantConfig, type RailConfig } from "@altananetwork/x402-server";
import { adminKey, hasAdminKey } from "./vault.ts";
import { BSC_MAINNET } from "./chains.ts";

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
 * Two ways to pay it, on one challenge:
 *
 *  - The native rail. No facilitator, no signature scheme, no allowance: the
 *    challenge names an address and an amount, the caller sends a plain BNB
 *    transfer, and resends carrying the transaction hash. Kawal reads the
 *    chain. Anyone can reproduce that verification.
 *  - The Altana rails, on the B402 v2 wire: `eip3009` on $U for BNB Agent
 *    Studio buyers and `permit2-exact` on USDT for Altana session keys. The
 *    buyer signs an authorisation, and Kawal itself broadcasts the settlement
 *    from a gas-only settler key — funds move payer to `payTo` and the
 *    recipient is bound into the signature. Still no third party: the
 *    "facilitator" in that scheme is an EOA this instance holds, so these
 *    rails are advertised only when it is present and funded for gas.
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

/**
 * Price on the stablecoin rails, atomic units. USDT and $U both carry 18
 * decimals on BSC, so one figure serves both.
 */
// ponytail: fixed at 0.10 rather than derived from a BNB/USD feed; a price
// feed is a dependency guarding seven cents. Retune by hand when BNB moves.
export const PRICE_STABLE_RAW = 100_000_000_000_000_000n;

/** CAIP-2 for BSC mainnet, the namespace the challenge is quoted in. */
export const NETWORK = "eip155:56";

/** How long a caller has to pay a native quote before it should be re-fetched. Enforced in `settle`. */
export const QUOTE_TIMEOUT_SECONDS = 900;

/**
 * Validity window offered on the signed rails. Studio buyers backdate
 * `validAfter` by 120s and refuse windows over 600s, so 480 is the ceiling
 * the docs name; 300 is the SDK's default and leaves room under it.
 */
export const STABLE_TIMEOUT_SECONDS = 300;

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

/**
 * The rails the Altana SDK settles, bound to the settler that will broadcast.
 *
 * `spender` on permit2-exact is the address that calls
 * `Permit2.permitWitnessTransferFrom`; it is baked into the buyer's signature,
 * so the settler is part of the terms rather than an implementation detail.
 */
export function altanaRails(settler: Address): RailConfig[] {
  return [
    { rail: "eip3009", token: U_TOKEN[BSC_MAINNET]! },
    { rail: "permit2-exact", token: USDT_BSC, spender: settler },
  ];
}

export const SERVICE_NAME = "Kawal deep report";
const DESCRIPTION =
  "Everything Kawal has on one agent: a live handshake, every probe kept, how it fails when it fails, whether it really charges, and who wrote its feedback.";

/** The SDK's view of the same terms, for its verify/settle primitives. */
export function merchantConfig(to: Address, settler: Address): MerchantConfig {
  return {
    chainId: BSC_MAINNET,
    payTo: to,
    price: PRICE_STABLE_RAW,
    // Clamped to itself: the SDK's floor/ceiling exist for prices read from
    // config files, and Kawal's is a constant.
    minPrice: PRICE_STABLE_RAW,
    maxPrice: PRICE_STABLE_RAW,
    rails: altanaRails(settler),
    maxTimeoutSeconds: STABLE_TIMEOUT_SECONDS,
    description: DESCRIPTION,
  };
}

export type Accept = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** Scheme-specific, as x402 v2 defines it. Absent on the native rail. */
  extra?: Record<string, string>;
};

export type Challenge = {
  x402Version: number;
  error: string;
  accepts: Accept[];
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
 *
 * The native rail is always first. The Altana rails follow only when a
 * settler is named, which the server decides after checking it can pay gas:
 * advertising a rail nobody here can settle would be exactly the unbacked
 * `x402_supported` flag this endpoint exists to be the opposite of.
 */
export function challenge(to: Address, settler: Address | null = null): Challenge {
  const stable = settler ? buildChallenge(merchantConfig(to, settler)).accepts : [];
  const byToken = stable.length
    ? `, or pay ${formatUnits(PRICE_STABLE_RAW, 18)} ${stable.map((a) => a.extra.name).join(" or ")} on the x402 rails listed, signed as their scheme requires`
    : "";
  return {
    x402Version: 2,
    error:
      `payment required: send ${formatEther(PRICE_WEI)} BNB to ${to} on BNB Smart Chain, then resend with a PAYMENT-SIGNATURE (or X-PAYMENT) header carrying the transaction hash` +
      byToken,
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
      ...stable,
    ],
    resource: { serviceName: SERVICE_NAME, description: DESCRIPTION },
  };
}
