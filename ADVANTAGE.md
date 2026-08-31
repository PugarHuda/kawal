# Agent Advantage Report

Generated 2026-08-31T13:51:52.695Z · every number below came from a live run of
`npm run advantage`. No result is simulated, averaged or reconstructed.

## Method

Each task is run twice: once by hiring an agent listed on Kawal through its
declared MCP endpoint, and once by doing the job directly against a public RPC
or REST API. The hired path is timed from a cold start — the MCP `initialize`
handshake is included, because a real hire pays for it. Each path is run
3 times and the median reported, with the full range beside it: a
single sample flipped two of these three verdicts between consecutive runs.

Cost is what actually left a wallet. All three agents are registered as
`x402_supported` on 8004scan, but none issued a payment challenge, so all
three calls were free. That gap between declared and enforced payment is a
finding in itself and is discussed at the end.

Subject address for task 1: `0x7A38D8bad0591Ad1673E2aB20C67b2c6286982Cd` — a real Venus borrower on BSC,
found by scanning vUSDT `Borrow` events, not chosen from a write-up.

---

## Liquidation risk on a live lending position

**Category:** Health factor monitoring (high stakes: lending)
**Question:** Is Venus position 0x7A38D8bad0591Ad1673E2aB20C67b2c6286982Cd at risk of liquidation, and how much headroom does it have?

| Path | What ran | Median of 3 (range) | Returned | Cost |
|---|---|---|---|---|
| Hired | Venus powered by HeyAnon — MCP getAccountLiquidity | 987 ms (937-2684) | 1 position | $0.00 |
| Manual | Venus Comptroller read directly over RPC | 111 ms (104-475) | 1 position | $0.00 |

**Doing it yourself was 8.9x faster; both paths returned the same position. Hiring buys convenience, not information.**

Hired — Listed on Kawal as hireable. No x402 challenge was issued, so the call was free.

```json
{"project":"venus","operation":"getAccountLiquidity","data":[{"chain":"bsc","pool":"CORE","borrowLimit":"61368.06","shortfall":"0.00"}]}
```

Manual — Excludes the work of finding and proving the Comptroller address. Kawal spent real effort on that (npm run verify:venues) precisely because published lists name an implementation address that would return nothing here.

```json
{
  "source": "Venus Comptroller getAccountLiquidity, read directly",
  "comptroller": "0xfD36E2c2a6789Db23113685031d7F16329158384",
  "error": "0",
  "liquidityUsd": "61368.06",
  "shortfallUsd": "0.00"
}
```

---

## Finding where yield actually is

**Category:** Yield optimisation
**Question:** Where can capital earn yield on BSC right now, and at what rate?

| Path | What ran | Median of 3 (range) | Returned | Cost |
|---|---|---|---|---|
| Hired | Beefy powered by HeyAnon — MCP getVaultsWithChains | 1010 ms (997-1828) | 13 vaults across protocols | $0.00 |
| Manual | Venus vUSDT supply rate read directly, annualised by hand | 414 ms (106-1690) | 1 vault across protocols | $0.00 |

**Doing it yourself was 2.4x faster, but the agent returned 13 vaults across protocols against 1. Hiring wins: matching that breadth by hand is many more calls, not one.**

Hired — Returned 13 BSC vaults with TVL and platform for each.

```json
{"project":"beefy","operation":"getVaultsWithChains","data":[{"chain":"bsc","vaults":[{"id":"pancake-cow-bsc-pepe-wbnb-vault","name":"PEPE-WBNB","chain":"bsc","tokenProviderId":"pancakeswap","platform":"pancakeswap","token":"PEPE-WBNB","tokenAddress":"0x3e5067c68EA8B3661d65B6d817e669898A711B9B","tvl":4059.8874360614814,"poolTvl":244559.6756709668,"apy":0.7294505568568055},{"id":"pancake-cow-bsc-sol-wbnb-vault","name":"SOL-WBNB","chain":"bsc","tokenProviderId":"pancakeswap","platform":"pancakeswap","token":"SOL-WBNB","tokenAddress":"0x06DFa5747f0B6F4f1332267A5376aD3f4eeeff55","tvl":46022.9767801619,"poolTvl":469371.39594139135,"apy":0.13028805836870516},{"id":"pancake-cow-bsc-eth-btcb-vault","name":"ETH-BTCB","chain":"bsc","tokenProviderId":"pancakeswap","platform":"pancakeswap","token":"ETH-BTCB","tokenAddress":"0xC0885E2B72E2Ff70E6a947387a70435c6E59a477","tvl":13574.07151634619,"poolTvl":1151738.2418850763,"apy":0.11475477635600995},{"id":"pancake-cow-bsc-doge-wbnb-vault","name":"DOGE-WBNB","chain":"bsc","tokenProviderId":"pancakeswap","platform":"pancakeswap","token":"DOGE-WBNB","tokenAddress":"0x364aaFb34D8d98D9ea87aCAFc884bbd52f262cb4","tvl":47344.38914773385,"poolTvl":613907.3434885448,"apy":0.10993981084395998},{"id":"pancake-cow-bsc-usdt-sol-vault","name":"SOL-USDT","chain":"bsc","tokenProviderId":"pancakeswap","platform":"pancakeswap","token":"SOL-USDT","tokenAddress":"
… truncated, full output in advantage-output/
```

Manual — Answers a much narrower question for comparable effort: one market, one protocol, and only after deciding a blocks-per-year constant that BSC has already changed once this year.

```json
{
  "source": "Venus vUSDT supplyRatePerBlock, read directly",
  "market": "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
  "symbol": "vUSDT",
  "supplyRatePerBlock": "406097739",
  "assumedBlocksPerYear": 42048000,
  "impliedSupplyApyPercent": "1.7222",
  "covers": "one market on one protocol"
}
```

---

## Enumerating tradable markets

**Category:** Trading (high stakes)
**Question:** What perpetual markets does Aster support, and what are their price and lot constraints?

| Path | What ran | Median of 3 (range) | Returned | Cost |
|---|---|---|---|---|
| Hired | Aster powered by HeyAnon — MCP getSupportedMarkets | 1180 ms (1032-1494) | 552 markets | $0.00 |
| Manual | Aster public REST exchangeInfo, called directly | 330 ms (132-374) | 572 markets | $0.00 |

**Doing it yourself was 3.6x faster; both paths returned the same markets. Hiring buys convenience, not information.**

Hired — Returned 552 markets.

```json
{"project":"aster","operation":"getSupportedMarkets","data":[{"symbol":"ASTERUSDT","filters":[{"minPrice":"0.00010","maxPrice":"200","filterType":"PRICE_FILTER","tickSize":"0.00010"},{"stepSize":"0.01","filterType":"LOT_SIZE","maxQty":"10000000","minQty":"0.01"},{"stepSize":"0.01","filterType":"MARKET_LOT_SIZE","maxQty":"900000","minQty":"0.01"},{"limit":200,"filterType":"MAX_NUM_ORDERS"},{"limit":10,"filterType":"MAX_NUM_ALGO_ORDERS"},{"notional":"5","filterType":"MIN_NOTIONAL"},{"multiplierDown":"0.9500","multiplierUp":"1.0500","ltMultiplierDown":"0.9700","multiplierDecimal":"4","filterType":"PERCENT_PRICE","ltMultiplierUp":"1.0300"}],"orderTypes":["LIMIT","MARKET","STOP","STOP_MARKET","TAKE_PROFIT","TAKE_PROFIT_MARKET","TRAILING_STOP_MARKET"],"timeInForce":["GTC","IOC","GTX","HIDDEN"],"createTime":1758215451058,"pair":"ASTERUSDT","contractType":"PERPETUAL","deliveryDate":4133404800000,"onboardDate":1758178800000,"status":"TRADING","maintMarginPercent":"12.5000","requiredMarginPercent":"25.0000","baseAsset":"ASTER","quoteAsset":"USDT","marginAsset":"USDT","pricePrecision":5,"quantityPrecision":2,"baseAssetPrecision":8,"quotePrecision":8,"underlyingType":"COIN","underlyingSubType":["Top"],"symbolType":0,"tradingMode":0,"name":"","channel":"{}","sequenceNo":100,"twapMinNotional":"1000","imn":"4000.00","tags":[],"settlePlan":0,"triggerProtect":"0.1500","liquidationFee":"0.025000
… truncated, full output in advantage-output/
```

Manual — Returned 572 markets from a documented public endpoint that needs no key.

```json
{
  "source": "Aster public REST exchangeInfo, called directly",
  "endpoint": "https://fapi.asterdex.com/fapi/v1/exchangeInfo",
  "symbolCount": 572
}
```


---

## What the numbers say

- **Liquidation risk on a live lending position** — Doing it yourself was 8.9x faster; both paths returned the same position. Hiring buys convenience, not information.
- **Finding where yield actually is** — Doing it yourself was 2.4x faster, but the agent returned 13 vaults across protocols against 1. Hiring wins: matching that breadth by hand is many more calls, not one.
- **Enumerating tradable markets** — Doing it yourself was 3.6x faster; both paths returned the same markets. Hiring buys convenience, not information.

Wall clock favoured the manual path in all three tasks, and on its own that
number is misleading: a single targeted RPC call will always beat an MCP
handshake plus an agent's own upstream work. The column that decides anything
is what came back.

- **Liquidation risk** — both paths answered for the same one position, so the
  faster path wins and that is the direct read. Worth recording: the two
  disagreed by roughly 1% on the borrow limit, which is different oracle
  snapshots rather than a bug. For a liquidation decision that gap matters,
  and only the direct read is reproducible against a block number.
- **Yield** — the one task where hiring clearly pays. The agent surveyed
  13 vaults across several protocols in a single
  call; the direct read covered 1, and only
  after committing to a blocks-per-year constant that BSC has already changed
  once this year. The manual path is faster at answering a much smaller
  question.
- **Trading** — hiring loses on both axes. Aster publishes the same data on a
  documented public endpoint that needs no key, returned
  572 markets against the agent's
  552, and did it faster. Paying an agent to
  proxy a public API is a worse deal than calling the API.

The pattern across all three: hiring is worth it when the agent aggregates
across sources you would otherwise have to find, integrate and maintain
yourself. It is not worth it when the agent is a wrapper around one endpoint
you could have called directly. A marketplace that cannot tell a buyer which
of the two they are looking at is not doing its job, which is why Kawal shows
tool counts, live latency and price rather than a single score.

## Price discovery, and why Kawal shows it

A fourth agent was priced but not hired. **Sentinels Audit**
(`smartsentinels.net/api/audit-mcp`, token 258641) is a live MCP server whose
free `sentinels_ai_audit_info` tool quotes its own price: **0.2 BNB per
contract audit**, paid as a native transfer to
`0x4E21F74143660ee576F4D2aC26BD30729a849f55`, with the resulting transaction
hash passed back as `paymentTxHash`.

That is roughly $140 a call. It may well be worth it against a human auditor,
but it is not a number 8004scan surfaces anywhere, and it is the first thing
anyone deciding whether to hire needs to know. The report stops at the quote
rather than paying, because a run this report could not honestly reproduce is
worth less than an unpaid one it can.

## The declared-versus-enforced gap

Kawal's `hireable` tier means "declares a callable interface **and**
`x402_supported`". Running these tasks showed `x402_supported` is a
self-declared flag, not an enforced one: all three agents carry it, none
demanded payment, and the one agent that genuinely charges — Sentinels —
reports `x402_supported: false` and takes a plain native transfer instead.

So the flag predicts neither that you will be charged nor that you won't. Kawal
now says so on the agent page rather than letting the tier imply a payment
path that was never tested.
