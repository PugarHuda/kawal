import { formatEther } from "viem";
import { getWalletMetrics, type WalletMetrics } from "@/lib/scan";
import { agentWalletOf } from "@/lib/feedback";
import { Cell } from "@/components/listing";

/*
 * The wallet: what 8004scan has booked against an address on-chain.
 *
 * Every payment figure on this site until now was a claim — an x402 flag a
 * registration set about itself, a price a tool wrote in its own
 * description. `payment_count` and `total_revenue` here are the registry's
 * accounting of what actually moved, so they are captioned as 8004scan's and
 * printed even when they read zero: a zero from a ledger says more than a
 * flag from a form.
 */

/** Wei to a readable figure; a balance printed to eighteen places is noise. */
export function trimEther(wei: string): string {
  try {
    const n = Number(formatEther(BigInt(wei)));
    return n === 0 ? "0" : n >= 1 ? n.toFixed(4) : n.toPrecision(3);
  } catch {
    return wei;
  }
}

function kindOf(wallet: WalletMetrics) {
  return wallet.is_contract ? "contract" : wallet.is_agent_wallet ? "agent wallet" : "externally owned";
}

/** The owner sheet's strip: the whole ledger, six cells wide. */
export function WalletStrip({ wallet }: { wallet: WalletMetrics }) {
  return (
    <section aria-label="The wallet" className="border-b-[1.5px] border-rule px-5 py-5">
      <h2 className="cap">
        The wallet · 8004scan&rsquo;s on-chain accounting
      </h2>
      <div className="cells mt-2 sm:grid-cols-3 lg:grid-cols-6">
        <Cell cap="Saldo · balance">{trimEther(wallet.balance)} BNB</Cell>
        <Cell cap="Transaksi · transactions">{wallet.tx_count.toLocaleString()}</Cell>
        <Cell cap="Umur · wallet age">{wallet.wallet_age_days.toLocaleString()} days</Cell>
        <Cell cap="payments received">{wallet.payment_count.toLocaleString()}</Cell>
        <Cell cap="revenue">{trimEther(wallet.total_revenue)}</Cell>
        <Cell cap="Jenis · kind">
          {kindOf(wallet)}
          {wallet.total_associated_agents > 0 && (
            <span className="text-carbon-3">
              {" "}
              · {wallet.total_associated_agents} agent{wallet.total_associated_agents === 1 ? "" : "s"} indexed
            </span>
          )}
        </Cell>
      </div>
      {wallet.metrics_updated_at && (
        <p className="cap mt-2">as 8004scan read the chain at {wallet.metrics_updated_at.replace("T", " ").slice(0, 16)} UTC</p>
      )}
    </section>
  );
}

function short(hex: string) {
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/**
 * The agent sheet's rows beside the "Agent wallet" line.
 *
 * Two readings of one address. The Identity Registry holds `agentWallet`
 * itself — set at registration, changed only with the new wallet's
 * signature, cleared on transfer — so the chain is asked which wallet this
 * is, and the answer is printed against the one 8004scan indexed. Then
 * 8004scan's ledger for that wallet, when it has one. Async so both stream
 * in under their own boundary.
 */
export async function AgentWalletRows({ chainId, tokenId, indexed }: { chainId: number; tokenId: string; indexed: string | null }) {
  const [onchain, wallet] = await Promise.all([
    agentWalletOf(chainId, tokenId),
    indexed && /^0x[0-9a-fA-F]{40}$/.test(indexed) ? getWalletMetrics(indexed) : null,
  ]);
  const agreement =
    onchain === null
      ? indexed
        ? "the Identity Registry holds no wallet for this token — unset, or cleared by a transfer since 8004scan indexed one"
        : "the Identity Registry holds no wallet for this token either"
      : indexed && onchain.toLowerCase() === indexed.toLowerCase()
        ? `Identity Registry agrees: getAgentWallet returns ${short(onchain)}`
        : `Identity Registry names ${short(onchain)}${indexed ? ` — 8004scan indexes ${short(indexed)}, so the index is stale` : ", which 8004scan has not indexed"}`;

  return (
    <>
      <div className="cell">
        <dt className="cap">Agent wallet · the chain&rsquo;s answer</dt>
        <dd className="typed text-[0.88rem] text-carbon-2">{agreement}</dd>
      </div>
      {wallet && <AgentWalletLedger wallet={wallet} />}
    </>
  );
}

/** 8004scan's ledger for the agent wallet, typed into two cells. */
function AgentWalletLedger({ wallet }: { wallet: WalletMetrics }) {
  return (
    <>
      <div className="cell">
        <dt className="cap">Payments received · 8004scan&rsquo;s on-chain accounting</dt>
        <dd className="typed text-[0.88rem] text-carbon-2">
          {wallet.payment_count.toLocaleString()} payment{wallet.payment_count === 1 ? "" : "s"} · revenue{" "}
          {trimEther(wallet.total_revenue)} · {kindOf(wallet)}
        </dd>
      </div>
      <div className="cell">
        <dt className="cap">Agent wallet age · 8004scan&rsquo;s reading</dt>
        <dd className="typed text-[0.88rem] text-carbon-2">
          {wallet.wallet_age_days.toLocaleString()} days · {wallet.tx_count.toLocaleString()} transactions ·{" "}
          {trimEther(wallet.balance)} BNB held
        </dd>
      </div>
    </>
  );
}
