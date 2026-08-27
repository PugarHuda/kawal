import { NextResponse } from "next/server";
import { payTo, challenge, PRICE_WEI, QUOTE_TIMEOUT_SECONDS } from "@/lib/x402.terms";
import { settle } from "@/lib/settle";
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenId = (url.searchParams.get("tokenId") ?? "").trim();
  const chainId = Number(url.searchParams.get("chainId") ?? BSC_MAINNET);

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

  const offered = challenge(to);

  const paying = request.headers.get("x-payment");
  if (!paying) {
    return noStore(offered, {
      status: 402,
      headers: {
        // Both carriers, the way q402 sends them: a proxy can act on the
        // header without reading a body, and Kawal's own reader tries the
        // header first for that reason.
        "payment-required": Buffer.from(JSON.stringify(offered), "utf8").toString("base64"),
        "www-authenticate": `Payment realm="kawal", amount="${PRICE_WEI}", network="eip155:56", timeout="${QUOTE_TIMEOUT_SECONDS}"`,
      },
    });
  }

  // Arguments are validated before the chain is read: a caller who sent money
  // and asked a malformed question should be told which half was wrong, and
  // should not have their receipt banked for a request that cannot be served.
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
    return noStore({ ...offered, rejected: settled.reason }, { status: 402 });
  }

  try {
    const report = await deepReport(chainId, tokenId);
    return noStore({
      paid: true,
      payment: {
        txHash: settled.txHash,
        payer: settled.payer,
        amountWei: settled.amountWei.toString(),
      },
      report,
    });
  } catch (e) {
    // The receipt is spent by now and the report failed. Say so plainly rather
    // than returning a 500 that leaves the payer guessing whether they were
    // charged.
    return noStore(
      {
        paid: true,
        payment: { txHash: settled.txHash },
        error: e instanceof Error ? e.message : String(e),
        note: "Payment was accepted and the report could not be built. This receipt is spent; contact the operator.",
      },
      { status: 502 },
    );
  }
}
