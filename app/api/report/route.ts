import { NextResponse } from "next/server";
import { payTo, challenge, PRICE_WEI, QUOTE_TIMEOUT_SECONDS, NETWORK } from "@/lib/x402.terms";
import { settle, advertisedSettler, type Settlement } from "@/lib/settle";
import { deepReport } from "@/lib/server.mcp";
import { SUPPORTED_CHAINS, BSC_MAINNET } from "@/lib/chains";

/**
 * The one thing on Kawal that costs money — and, by its own measurement, the
 * only endpoint on BSC that both asks to be paid and can be.
 *
 * Kawal found 75 of 200 registrations declaring `x402_supported` and not one
 * reachable claimant that ever issues a challenge. This is the counter-example
 * rather than a complaint: ask without paying and it answers 402 with terms;
 * pay and resend the receipt and it answers with the report.
 *
 * The wire is x402 v2: the challenge travels base64-encoded in
 * `PAYMENT-REQUIRED` (and in the body, and summarised in `Www-Authenticate`
 * for proxies that only read that), the payment arrives in
 * `PAYMENT-SIGNATURE` — `X-PAYMENT`, the v1 name the Altana SDK still sends,
 * is read too — and a settled answer carries `PAYMENT-RESPONSE`.
 *
 * A GET is the protocol's own opening move, which matters here for a reason
 * beyond convention: it means Kawal's existing prober can be pointed at this
 * URL and check it exactly as it checks everybody else. The endpoint that
 * proves the finding and the endpoint that answers it are read by the same
 * code.
 */

export const dynamic = "force-dynamic";

function noStore(body: unknown, init: ResponseInit = {}) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...(init.headers ?? {}), "cache-control": "no-store" },
  });
}

function b64(doc: unknown) {
  return Buffer.from(JSON.stringify(doc), "utf8").toString("base64");
}

/** The v2 settlement receipt header: what moved, where, and who paid. */
function paymentResponse(settled: Settlement & { paid: true }) {
  return {
    "payment-response": b64({ success: true, transaction: settled.txHash, network: NETWORK, payer: settled.payer }),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  // Two spellings of the same question: `agent=56:2468`, the form the MCP and
  // A2A surfaces already use, or `chainId` and `tokenId` apart.
  const agentRef = (url.searchParams.get("agent") ?? "").trim();
  const ref = /^(\d+):(\d+)$/.exec(agentRef);
  const tokenId = ref ? ref[2]! : (url.searchParams.get("tokenId") ?? "").trim();
  const chainId = ref ? Number(ref[1]) : Number(url.searchParams.get("chainId") ?? BSC_MAINNET);

  const to = payTo();

  // No wallet, nothing for sale. Quoting an address this instance cannot spend
  // from would be the unbacked payment claim the whole feature argues against.
  if (!to) {
    return noStore(
      {
        error: "this instance holds no wallet, so it charges for nothing",
        priceWei: null,
      },
      { status: 503 },
    );
  }

  // The signed rails are advertised only while the account that settles them
  // is here and can pay gas; otherwise the challenge is the native rail alone.
  const offered = challenge(to, await advertisedSettler().catch(() => null));

  const paying = request.headers.get("payment-signature") ?? request.headers.get("x-payment");
  if (!paying) {
    return noStore(offered, {
      status: 402,
      headers: {
        // Both carriers, the way q402 sends them: a proxy can act on the
        // header without reading a body, and Kawal's own reader tries the
        // header first for that reason.
        "payment-required": b64(offered),
        "www-authenticate": `Payment realm="kawal", amount="${PRICE_WEI}", network="${NETWORK}", timeout="${QUOTE_TIMEOUT_SECONDS}"`,
      },
    });
  }

  // Arguments are validated before the chain is read: a caller who sent money
  // and asked a malformed question should be told which half was wrong, and
  // should not have their receipt banked for a request that cannot be served.
  if (agentRef && !ref) {
    return noStore({ error: "agent must be chainId:tokenId, for example 56:2468", paid: false }, { status: 400 });
  }
  if (!/^\d+$/.test(tokenId)) {
    return noStore({ error: "tokenId must be a decimal token id", paid: false }, { status: 400 });
  }
  if (!SUPPORTED_CHAINS.includes(chainId as (typeof SUPPORTED_CHAINS)[number])) {
    return noStore({ error: `chainId must be one of ${SUPPORTED_CHAINS.join(", ")}`, paid: false }, { status: 400 });
  }

  const settled = await settle(paying);
  if (!settled.paid) {
    // 402 again, with the same terms: the caller is exactly where they were
    // before, and the reason is theirs to act on.
    return noStore(
      { ...offered, rejected: settled.reason },
      { status: 402, headers: { "payment-required": b64(offered) } },
    );
  }

  const payment = {
    rail: settled.rail,
    txHash: settled.txHash,
    payer: settled.payer,
    amount: settled.amount.toString(),
    asset: settled.asset,
  };

  try {
    const report = await deepReport(chainId, tokenId);
    return noStore({ paid: true, payment, report }, { headers: paymentResponse(settled) });
  } catch (e) {
    // The receipt is spent by now and the report failed. Say so plainly rather
    // than returning a 500 that leaves the payer guessing whether they were
    // charged.
    return noStore(
      {
        paid: true,
        payment,
        error: e instanceof Error ? e.message : String(e),
        note: "Payment was accepted and the report could not be built. This receipt is spent; contact the operator.",
      },
      { status: 502, headers: paymentResponse(settled) },
    );
  }
}
