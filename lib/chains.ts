/**
 * Chain identifiers, in one place.
 *
 * These lived in two modules under two names: `BSC`/`BSC_TESTNET` in
 * mandate.ts and `BSC_MAINNET`/`BSC_TESTNET` in scan.ts. Same numbers, two
 * declarations, and nothing keeping them in step — the kind of duplication
 * that stays harmless right up until someone adds a chain to one of them.
 *
 * Kept as its own module rather than folded into either one because the
 * catalog side (scan, taxonomy, signals) and the custody side (mandate,
 * altana, sessions) have no business importing each other. A shared leaf is
 * the only place both can reach without coupling them.
 */

export const BSC_MAINNET = 56;
export const BSC_TESTNET = 97;

/** Chains Kawal knows how to render, plan mandates on, and verify venues for. */
export const SUPPORTED_CHAINS = [BSC_MAINNET, BSC_TESTNET] as const;

/** Human label for a chain id, for anything a person reads. */
export function chainName(chainId: number) {
  if (chainId === BSC_MAINNET) return "BSC mainnet";
  if (chainId === BSC_TESTNET) return "BSC testnet";
  return `chain ${chainId}`;
}
