/**
 * Agents the chain knows and 8004scan does not.
 *
 * Kawal's whole argument is that the index is not the registry. It read
 * badly on its own site: Kawal registered itself as agent 320164 on
 * 2026-08-31, `ownerOf(320164)` named the operator wallet within the minute,
 * and `https://kawal-three.vercel.app/agents/56/320164` answered **404** for
 * the rest of the day, because `getAgent` asks 8004scan and nothing else.
 * A marketplace that disappears the moment its index falls behind is a
 * marketplace that trusts the index completely.
 *
 * So: when the index has never heard of a token, the Identity Registry is
 * asked directly — `ownerOf` for whether it exists, `tokenURI` for where its
 * registration document lives, `getAgentWallet` for where it is paid — and
 * the document is fetched through the same SSRF guard every other declared
 * URL goes through. A `tokenURI` is written by whoever minted the token, so
 * it is exactly as untrusted as an endpoint.
 *
 * What comes back is deliberately thin. Scores, stars, feedback counts and
 * ranks are things 8004scan computes; the chain has none of them and this
 * module invents none of them. Callers can tell the two apart by `indexed`.
 */

import { z } from "zod";
import { parseAbi, type Address } from "viem";
import { publicClientFor } from "./rpc.ts";
import { agentRegistryFor, ownerOfAgent, agentWalletOf } from "./feedback.ts";
import { guardedFetch, readCapped } from "./ssrf.ts";
import { ScanAgentDetailSchema, type ScanAgentDetail } from "./scan.schema.ts";

const IDENTITY_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
]);

/**
 * The registration document EIP-8004 points `tokenURI` at.
 *
 * Every field is optional except the ones a page cannot do without, because
 * this is a stranger's JSON: a document that names the agent and nothing else
 * still renders a usable page, and one that names nothing at all is refused.
 */
const RegistrationSchema = z.object({
  type: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  image: z.string().optional(),
  x402Support: z.boolean().optional(),
  services: z
    .array(z.object({ name: z.string(), description: z.string().optional(), endpoint: z.string(), version: z.string().optional() }))
    .optional(),
});

const REGISTRATION_V1 = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/** Where the registration document lives, as the token itself says. */
async function tokenUriOf(chainId: number, tokenId: string): Promise<string | null> {
  try {
    return await publicClientFor(chainId).readContract({
      address: agentRegistryFor(chainId),
      abi: IDENTITY_ABI,
      functionName: "tokenURI",
      args: [BigInt(tokenId)],
    });
  } catch {
    return null;
  }
}

/**
 * A registration document, fetched the way every other declared URL is.
 *
 * `ipfs://` is left alone rather than routed through a gateway: picking one
 * would make Kawal's answer depend on whichever gateway it chose, and the
 * `--verify` round already measured how unreliable that is.
 */
async function readRegistration(uri: string) {
  if (!/^https?:\/\//i.test(uri)) return null;
  try {
    const res = await guardedFetch(uri, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const parsed = RegistrationSchema.safeParse(JSON.parse(await readCapped(res)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * One agent, assembled from the Identity Registry and its own document.
 *
 * Null when the token was never minted or has been burned — `ownerOf` reverts
 * on both, which is the same 404 the index would have given, honestly earned.
 * A token that exists but whose document cannot be read still returns a row:
 * the chain's word that it exists is worth more than nothing, and the page
 * says the document could not be read rather than pretending it had one.
 */
export async function agentFromChain(chainId: number, tokenId: string): Promise<ScanAgentDetail | null> {
  if (!/^\d+$/.test(tokenId)) return null;

  const owner = await ownerOfAgent(chainId, tokenId);
  if (!owner) return null;

  const [uri, wallet] = await Promise.all([tokenUriOf(chainId, tokenId), agentWalletOf(chainId, tokenId)]);
  const doc = uri ? await readRegistration(uri) : null;

  const services: Record<string, { endpoint: string; version?: string }> = {};
  for (const s of doc?.services ?? []) services[s.name.toLowerCase()] = { endpoint: s.endpoint, version: s.version };

  const row = ScanAgentDetailSchema.parse({
    id: `${chainId}:${tokenId}`,
    agent_id: tokenId,
    token_id: tokenId,
    chain_id: chainId,
    contract_address: agentRegistryFor(chainId),
    owner_address: owner,
    agent_wallet: wallet,
    name: doc?.name ?? `Agent ${tokenId}`,
    description:
      doc?.description ??
      (uri
        ? `The registration document at ${uri} could not be read, so nothing here describes what this agent does. The chain's word that the token exists is the whole of it.`
        : "This token carries no registration URI, so there is nothing to describe it."),
    image_url: doc?.image ?? null,
    supported_protocols: Object.keys(services).map((k) => k.toUpperCase()),
    x402_supported: doc?.x402Support ?? false,
    services: Object.keys(services).length ? services : null,
    // 8004scan computes these. The chain does not have them, and a zero here
    // means "not scored", which is what `indexed: false` is for saying.
    star_count: 0,
    total_score: 0,
    total_feedbacks: 0,
    average_score: 0,
    // The mint block is not cheaply readable — the dataseed refuses `getLogs`
    // over even 5,000 blocks — so the date is left empty rather than guessed.
    // `registeredOn` renders that as "not published".
    created_at: "",
    is_verified: doc?.type === REGISTRATION_V1,
  } satisfies Record<string, unknown>);

  // Set here rather than in the object above, where it was forgotten once: the
  // schema defaults `indexed` to true, so an omission read as a fully scored
  // agent whose every score happened to be zero — worse than the 404 it
  // replaces. Nothing this function returns came from the index.
  return { ...row, indexed: false };
}

/**
 * The registration date as a page should print it.
 *
 * A chain-built row has no date, and `new Date("").toISOString()` throws
 * rather than returning anything a reader could see. One helper so the three
 * places that print it cannot each get it wrong differently.
 */
export function registeredOn(createdAt: string): string {
  const at = new Date(createdAt);
  return Number.isNaN(at.getTime()) ? "not published" : at.toISOString().slice(0, 10);
}

/** How many identity tokens an address holds, straight from the registry. */
export async function heldCount(chainId: number, owner: string): Promise<number | null> {
  try {
    const n = await publicClientFor(chainId).readContract({
      address: agentRegistryFor(chainId),
      abi: IDENTITY_ABI,
      functionName: "balanceOf",
      args: [owner as Address],
    });
    return Number(n);
  } catch {
    return null;
  }
}

/**
 * How far below the newest known token id an unindexed registration is looked
 * for.
 *
 * 8004scan takes roughly 2,000 registrations a day, and a registration the
 * index has not caught is by definition a recent one — Kawal's own sat about
 * 700 ids below the top. Three thousand covers well over a day of minting.
 *
 * ponytail: a fixed window, because the two cheap alternatives do not exist
 * here. The registry is not `ERC721Enumerable` (`tokenOfOwnerByIndex`
 * reverts), and the public dataseed refuses `eth_getLogs` on this contract at
 * every span tried, 5,000 blocks included — the same wall `lib/erc8183.ts`
 * hit. If an owner ever needs a deeper look, the upgrade is a stored high
 * water mark rather than a bigger window.
 */
const SCAN_WINDOW = 3_000;

export type ChainOnly = {
  /** Token ids the chain says this address holds that the index did not list. */
  ids: string[];
  /** `balanceOf`, or null when the registry could not be read. */
  held: number | null;
  /** Whether `ids` plus the indexed rows account for the whole balance. */
  accounted: boolean;
};

/**
 * Which of an owner's tokens the index missed.
 *
 * Cheap in the ordinary case and only expensive when it has to be: one
 * `balanceOf` decides whether there is a gap at all, and the scan runs only
 * when the chain says the owner holds more than the index listed. That scan
 * is ~3,000 `ownerOf` calls through Multicall3, measured at 7.5 s cold
 * against the public dataseed, so callers must not put it on a path that
 * runs for every visitor.
 *
 * `accounted` is the honest part: a window that does not find every missing
 * token says so, instead of letting a caller read the shorter list as
 * complete.
 */
export async function chainOnlyFor(
  chainId: number,
  owner: string,
  indexedIds: string[],
  newestKnownId: () => Promise<string | null>,
): Promise<ChainOnly> {
  const held = await heldCount(chainId, owner);
  if (held === null || held <= indexedIds.length) {
    return { ids: [], held, accounted: held !== null };
  }

  // Only asked for once the balance says there is something to look for, so
  // the ordinary owner page pays neither this call nor the scan below it.
  const newest = await newestKnownId().catch(() => null);
  const top = newest && /^\d+$/.test(newest) ? BigInt(newest) : null;
  if (top === null) return { ids: [], held, accounted: false };

  const known = new Set(indexedIds);
  const wanted = owner.toLowerCase();
  // Above the newest id the index knows about as well as below it: the index
  // is behind by definition here, so the true top of the registry is higher
  // than anything it has published.
  const first = top + BigInt(SCAN_WINDOW / 2);
  const registry = agentRegistryFor(chainId);

  let results;
  try {
    results = await publicClientFor(chainId).multicall({
      contracts: Array.from({ length: SCAN_WINDOW }, (_, i) => ({
        address: registry,
        abi: IDENTITY_ABI,
        functionName: "ownerOf" as const,
        args: [first - BigInt(i)],
      })),
      allowFailure: true,
    });
  } catch {
    return { ids: [], held, accounted: false };
  }

  const ids: string[] = [];
  results.forEach((r, i) => {
    if (r.status !== "success" || String(r.result).toLowerCase() !== wanted) return;
    const id = (first - BigInt(i)).toString();
    if (!known.has(id)) ids.push(id);
  });

  return { ids, held, accounted: ids.length + indexedIds.length >= held };
}
