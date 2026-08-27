/**
 * The four categories the rubric requires, plus the security seat TermiX
 * weights highly.
 *
 * 8004scan exposes no category field, so every marketplace in this hackathon
 * has to derive one. This is that layer.
 */

export type CategoryId = "rebalancing" | "grid" | "yield" | "health" | "security";

export type Category = {
  id: CategoryId;
  /** One of the four the main track demands equal depth on. */
  core: boolean;
  seat: string;
  label: string;
  blurb: string;
  /** Natural-language query for 8004scan semantic search. */
  query: string;
  /** Short keyword queries for the list endpoint, used when semantic is down. */
  probes: string[];
  terms: string[];
};

export const CATEGORIES: Category[] = [
  {
    id: "rebalancing",
    core: true,
    seat: "Market maker",
    label: "Rebalancing",
    blurb: "Manages LP ranges and resets positions automatically.",
    query:
      "agent that manages concentrated liquidity positions, rebalances LP price ranges and reopens positions that drift out of range",
    probes: ["rebalance", "liquidity position", "concentrated liquidity"],
    terms: [
      "rebalance",
      "re-balance",
      "rebalancing",
      "liquidity position",
      "concentrated liquidity",
      "price range",
      "out of range",
      "in range",
      "impermanent loss",
      "position manager",
      "clmm",
      "lp",
      "liquidity",
    ],
  },
  {
    id: "grid",
    core: true,
    seat: "Execution trader",
    label: "Grid Trading",
    blurb: "Places and manages automated grid orders.",
    query:
      "automated grid trading bot that places laddered buy and sell orders within a price range and manages them continuously",
    probes: ["grid trading", "grid bot", "grid"],
    terms: [
      "grid trading",
      "grid bot",
      "grid strategy",
      "ladder order",
      "laddering",
      "range order",
      "dca",
      "dollar cost average",
      "martingale",
      "trading bot",
      "grid",
      "scalping",
    ],
  },
  {
    id: "yield",
    core: true,
    seat: "Allocator",
    label: "Yield Optimisation",
    blurb: "Routes liquidity to the highest available APR.",
    query:
      "yield optimiser that moves capital between lending and staking protocols to capture the highest available APR and auto-compounds rewards",
    // Broad on purpose: the narrow phrases ("yield optimizer", "highest apy")
    // matched nothing chain-wide. The classifier filters what the probe drags in.
    probes: ["yield", "apy", "vault"],
    terms: [
      "yield optimi",
      "auto-compound",
      "autocompound",
      "auto compound",
      "yield farm",
      "best rate",
      "highest apy",
      "apy",
      "apr",
      "vault",
      "staking",
      "restake",
      "lending",
      "yield",
      "farming",
      "compounding",
    ],
  },
  {
    id: "health",
    core: true,
    seat: "Risk officer",
    label: "Health Factor Monitoring",
    blurb: "Protects lending positions from liquidation.",
    query:
      "agent that monitors lending position health factor and collateral ratio and repays debt before liquidation happens",
    probes: ["health factor", "liquidation", "collateral"],
    terms: [
      "health factor",
      "liquidation",
      "liquidated",
      "collateral ratio",
      "collateralization",
      "loan-to-value",
      "ltv",
      "margin call",
      "deleverage",
      "repay debt",
      "collateral",
      "borrow",
      "debt",
    ],
  },
  {
    id: "security",
    core: false,
    seat: "Security analyst",
    label: "Security",
    blurb: "Screens tokens and contracts before capital touches them.",
    query:
      "security agent that screens tokens and smart contracts for honeypots, rug pulls and malicious approvals before a trade",
    probes: ["honeypot", "rug pull", "token safety"],
    terms: [
      "honeypot",
      "rug pull",
      "rugpull",
      "scam detect",
      "token safety",
      "contract risk",
      "risk score",
      "phishing",
      "blacklist",
      "exploit",
      "audit",
      "security",
    ],
  },
];

export const CORE_CATEGORIES = CATEGORIES.filter((c) => c.core);

export function categoryById(id: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

export type Classification = {
  category: CategoryId | null;
  confidence: number;
  matched: string[];
};

/**
 * Generic nouns that appear across half the roster. "grid" or "honeypot" names
 * a strategy; "liquidity" or "debt" is just DeFi vocabulary and must not carry
 * a category on its own.
 */
const WEAK_TERMS = new Set([
  "lp",
  "liquidity",
  "apy",
  "apr",
  "yield",
  "farming",
  "staking",
  "lending",
  "vault",
  "collateral",
  "borrow",
  "debt",
  "audit",
  "security",
  "exploit",
  "dca",
]);

/** Multi-word phrases are far stronger evidence than a bare noun. */
function weight(term: string) {
  if (WEAK_TERMS.has(term)) return 0.5;
  return term.includes(" ") || term.includes("-") ? 2 : 1;
}

/**
 * Keyword classifier over name + description.
 *
 * ponytail: deliberately not an LLM. 256k agents makes per-agent inference
 * expensive, and most registrations carry a one-line description that keywords
 * read fine. Ceiling: it cannot understand a description that never names what
 * the agent does. Upgrade path is an LLM pass over the `unclassified` bucket
 * only, not over the whole roster.
 */
export function classify(name: string, description?: string | null): Classification {
  const text = `${name} ${description ?? ""}`.toLowerCase();

  const scored = CATEGORIES.map((c) => {
    const matched = c.terms.filter((t) => text.includes(t));
    const score = matched.reduce((sum, t) => sum + weight(t), 0);
    return { id: c.id, score, matched };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  const runnerUp = scored[1];

  if (!top || top.score === 0) return { category: null, confidence: 0, matched: [] };

  // Two honest factors: how much evidence there is, and how cleanly it beats
  // the next category. A term that fires for two categories at once should not
  // read as a confident call, however many times it fires.
  const evidence = top.score / (top.score + 1);
  const separation = top.score / (top.score + (runnerUp?.score ?? 0));

  return {
    category: top.id,
    confidence: Number((evidence * separation).toFixed(3)),
    matched: top.matched,
  };
}

/** Below this we say "unclassified" rather than guess. */
export const MIN_CONFIDENCE = 0.3;
