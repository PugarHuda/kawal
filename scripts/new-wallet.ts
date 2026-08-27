/**
 * Mints the admin key Kawal grants mandates from.
 *
 * Run: npm run wallet:new
 *
 * Deliberately a separate command rather than a flag on `onchain`. Creating
 * the key that owns the money should be something you did on purpose, not
 * something a mistyped argument did for you.
 *
 * The key is written straight to a gitignored file and printed nowhere. A
 * private key that reaches a terminal reaches scrollback, shell history, CI
 * logs and screen shares; the only copy that stays private is the one that
 * was never displayed.
 */

import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPrivateKeySigner } from "@altananetwork/sdk";
import { publicClientFor } from "../lib/rpc.ts";
import { SUPPORTED_CHAINS, chainName } from "../lib/chains.ts";
import { KEY_FILE } from "../lib/vault.ts";

const force = process.argv.includes("--force");

if (existsSync(KEY_FILE) && !force) {
  const existing = privateKeyToAccount(
    readFileSync(KEY_FILE, "utf8").trim() as `0x${string}`,
  );

  // Overwriting a key that still holds money destroys access to it, so check
  // both chains before saying anything reassuring.
  let held = 0n;
  for (const chainId of SUPPORTED_CHAINS) {
    const balance = await publicClientFor(chainId).getBalance({ address: existing.address });
    if (balance > 0n) {
      console.log(`  ${chainName(chainId)}: ${formatEther(balance)} BNB`);
      held += balance;
    }
  }

  console.error(`\n${KEY_FILE} already exists — ${existing.address}`);
  console.error(
    held > 0n
      ? "It still holds a balance. Move those funds out before replacing it."
      : "It is empty, so nothing is lost by replacing it.",
  );
  console.error(`\nTo replace it anyway:  npm run wallet:new -- --force\n`);
  process.exit(1);
}

const signer = createPrivateKeySigner();
writeFileSync(KEY_FILE, signer._privateKey, { mode: 0o600 });

console.log(`admin key written to ${KEY_FILE} (gitignored, never printed)\n`);
console.log(`  wallet address   ${signer.address}\n`);
console.log(`This is the address to fund, and the address to put in a submission.`);
console.log(`It is the same on every EVM chain — EIP-7702 makes the smart account`);
console.log(`the EOA itself, so mainnet and testnet share it.\n`);
console.log(`Next:  fund it, then  npm run onchain -- mainnet`);
