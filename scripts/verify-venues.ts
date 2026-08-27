/**
 * Proves every allowlisted venue address is what it claims to be, on the
 * chain it claims it for.
 *
 * Run: npm run verify:venues            (BSC mainnet)
 *      npm run verify:venues -- testnet (BSC testnet)
 *
 * A wrong address in a session allowlist either bricks a seat or points it at
 * a contract it should never touch, and neither failure is visible until real
 * capital is moving. So no address enters lib/mandate.ts on the strength of a
 * search result: each one must have bytecode on its chain and answer an
 * identity call that only the real contract could answer.
 *
 * The addresses are read straight out of VENUES rather than restated here.
 * A second copy of an address is a second thing to get wrong.
 */

import { createPublicClient, http, type Abi, type Address } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import { VENUES, planMandate, preempt } from "../lib/mandate.ts";
import { BSC_MAINNET, BSC_TESTNET } from "../lib/chains.ts";

type Probe = {
  fn: string;
  outputs: "string" | "address" | "uint256";
  /** Expected value, compared case-insensitively. Omit to just require success. */
  expect?: string;
  /**
   * Per-chain override of `expect`. Some contracts are older on testnet than
   * on mainnet and still answer with a pre-rebrand name; that is a fact worth
   * recording rather than a check worth loosening everywhere.
   */
  expectOn?: Record<number, string>;
};

/**
 * What each venue must be able to answer. Keyed by venue id, so adding a
 * venue without deciding how to prove it is a visible omission rather than a
 * silent pass.
 */
const PROBES: Record<string, Probe[]> = {
  "pancakeswap.v3.positions": [
    { fn: "symbol", outputs: "string", expect: "PCS-V3-POS" },
    { fn: "factory", outputs: "address" },
    { fn: "WETH9", outputs: "address" },
  ],
  "pancakeswap.v3.router": [
    { fn: "WETH9", outputs: "address" },
    { fn: "deployer", outputs: "address" },
    { fn: "factory", outputs: "address" },
  ],
  wbnb: [{ fn: "symbol", outputs: "string", expect: "WBNB" }],
  "venus.comptroller": [
    { fn: "comptrollerImplementation", outputs: "address" },
    { fn: "admin", outputs: "address" },
  ],
  "venus.vusdt": [
    { fn: "symbol", outputs: "string", expect: "vUSDT" },
    { fn: "underlying", outputs: "address" },
  ],
  "aave.v3.pool": [
    { fn: "ADDRESSES_PROVIDER", outputs: "address" },
    { fn: "POOL_REVISION", outputs: "uint256" },
  ],
  "lista.staking": [
    { fn: "getTotalPooledBnb", outputs: "uint256" },
    { fn: "slisBnb", outputs: "address" },
    { fn: "totalDelegated", outputs: "uint256" },
  ],
  "lista.slisbnb": [
    {
      fn: "symbol",
      outputs: "string",
      expect: "slisBNB",
      // The testnet deployment predates the Synclub -> Lista rebrand and still
      // reports the old ticker. name() confirms the lineage.
      expectOn: { [BSC_TESTNET]: "SnBNB" },
    },
    { fn: "name", outputs: "string" },
  ],
};

const NETWORKS = {
  mainnet: { chainId: BSC_MAINNET, chain: bsc, rpc: "https://bsc-dataseed.bnbchain.org" },
  testnet: {
    chainId: BSC_TESTNET,
    chain: bscTestnet,
    rpc: "https://bsc-testnet-dataseed.bnbchain.org",
  },
} as const;

const which = (process.argv[2] ?? "mainnet") as keyof typeof NETWORKS;
const net = NETWORKS[which];
if (!net) {
  console.error(`unknown network "${which}" - expected mainnet or testnet`);
  process.exit(1);
}

const client = createPublicClient({ chain: net.chain, transport: http(net.rpc) });

function abiFor(p: Probe): Abi {
  return [
    {
      type: "function",
      name: p.fn,
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: p.outputs }],
    },
  ];
}

const chainId = await client.getChainId();
console.log(`RPC chain id ${chainId} (expecting ${net.chainId} - BSC ${which})\n`);
if (chainId !== net.chainId) {
  console.error("RPC is not on the expected chain - refusing to verify against it");
  process.exit(1);
}

let failures = 0;
let checked = 0;

for (const venue of Object.values(VENUES)) {
  const deployment = venue.deployments[net.chainId];
  if (deployment === undefined) {
    console.log(`${venue.protocol}\n  not deployed on BSC ${which} - seats do without it here\n`);
    continue;
  }

  console.log(venue.protocol);

  if (deployment.address === null) {
    console.log("  FAIL  claims a deployment here but carries no proven address\n");
    failures++;
    continue;
  }
  console.log(`  ${deployment.address}`);
  checked++;

  const code = await client.getCode({ address: deployment.address });
  const bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  if (bytes === 0) {
    console.log("  FAIL  no bytecode - this is an EOA or an empty address\n");
    failures++;
    continue;
  }
  console.log(`  code  ${bytes.toLocaleString()} bytes`);

  const probes = PROBES[venue.id];
  if (!probes) {
    console.log("  FAIL  no identity probe defined for this venue\n");
    failures++;
    continue;
  }

  let answered = 0;
  for (const p of probes) {
    try {
      const value = await client.readContract({
        address: deployment.address as Address,
        abi: abiFor(p),
        functionName: p.fn,
      });
      const shown = String(value);
      const expected = p.expectOn?.[net.chainId] ?? p.expect;
      if (expected && shown.toLowerCase() !== expected.toLowerCase()) {
        console.log(`  FAIL  ${p.fn}() = ${shown}, expected ${expected}`);
        failures++;
      } else {
        console.log(`  ok    ${p.fn}() = ${shown}`);
        answered++;
      }
    } catch {
      console.log(`  --    ${p.fn}() not present`);
    }
  }

  if (answered === 0) {
    console.log("  FAIL  answered no identity call - cannot confirm what this contract is");
    failures++;
  }
  console.log();
}

console.log(
  failures === 0
    ? `all ${checked} venue deployment(s) on BSC ${which} verified`
    : `${failures} verification failure(s)`,
);

if (failures === 0) {
  // Verifying an address only matters because of what it authorizes, so show
  // the mandate these addresses actually produce on this chain.
  const capital = 50_000n * 10n ** 18n;
  const plans = planMandate({
    chainId: net.chainId,
    capital,
    durationDays: 30,
    now: 1_755_300_000,
  });

  console.log(`\nmandate over ${Number(capital / 10n ** 18n).toLocaleString()} units, 30 days\n`);
  for (const p of plans) {
    const cap = (p.permissions.spend?.[0]?.limit ?? 0n) / 10n ** 18n;
    console.log(`  [${String(p.priority).padStart(3)}] ${p.seat} - ${p.category}`);
    for (const c of p.permissions.calls ?? []) {
      console.log(`        may call ${"to" in c ? c.to : c.signature}`);
    }
    console.log(`        cap ${Number(cap).toLocaleString()} per ${p.permissions.spend?.[0]?.period ?? "day"}`);
  }

  const cut = preempt(plans, "health", "yield", 0.25, "health factor 1.28 below the 1.40 floor");
  const before =
    (plans.find((p) => p.category === "yield")?.permissions.spend?.[0]?.limit ?? 0n) / 10n ** 18n;
  const after = (cut.narrowed.spend?.[0]?.limit ?? 0n) / 10n ** 18n;
  console.log(`\n  preemption - ${cut.by} narrows ${cut.target}: ${cut.reason}`);
  console.log(`        cap ${Number(before).toLocaleString()} -> ${Number(after).toLocaleString()}`);
  console.log(`        allowlist unchanged (${cut.narrowed.calls?.length ?? 0} contracts)`);
}

process.exit(failures === 0 ? 0 : 1);
