import { endpoints } from "../config.js";
import { fetchJson } from "../http.js";
import { DexScreenerResponse, type DexScreenerPair } from "../schemas.js";
import type { Chain } from "../chain.js";
import { NETWORK_SLUGS } from "../chain.js";

export async function getPairs(chain: Chain, address: string): Promise<DexScreenerPair[]> {
  const slug = NETWORK_SLUGS.dexscreener[chain];
  const url = `${endpoints.dexscreener}/token-pairs/v1/${slug}/${address}`;
  const raw = await fetchJson<unknown>(url);
  let pairs: DexScreenerPair[] = [];
  if (Array.isArray(raw)) {
    const parsed = DexScreenerResponse.safeParse({ pairs: raw });
    if (parsed.success) pairs = parsed.data.pairs ?? [];
  } else {
    const parsed = DexScreenerResponse.safeParse(raw);
    if (parsed.success) pairs = parsed.data.pairs ?? [];
  }
  // Some tokens are missing from token-pairs/v1 indexing but present in /latest/dex/search.
  if (pairs.length === 0) {
    const searched = await searchByAddress(address);
    pairs = searched.filter((p) => p.chainId === slug);
  }
  return pairs;
}

export async function searchByAddress(address: string): Promise<DexScreenerPair[]> {
  const url = `${endpoints.dexscreener}/latest/dex/search?q=${encodeURIComponent(address)}`;
  const raw = await fetchJson<unknown>(url);
  const parsed = DexScreenerResponse.safeParse(raw);
  return parsed.success ? parsed.data.pairs ?? [] : [];
}

const STANDARD_DEXES = new Set([
  "uniswap", "sushiswap", "pancakeswap", "raydium", "orca", "meteora",
  "pumpfun", "pumpswap", "baseswap", "aerodrome", "quickswap", "camelot",
]);

export function pickCanonicalPair(pairs: readonly DexScreenerPair[], address: string): DexScreenerPair | null {
  if (pairs.length === 0) return null;
  const lower = address.toLowerCase();
  const baseMatching = pairs.filter((p) => p.baseToken.address.toLowerCase() === lower);
  const quoteMatching = pairs.filter((p) => p.quoteToken.address.toLowerCase() === lower);
  // Prefer where the queried address is the BASE token — gives a pair "about" that token.
  const matching = baseMatching.length > 0 ? baseMatching : quoteMatching.length > 0 ? quoteMatching : pairs;
  const standard = matching.filter((p) => STANDARD_DEXES.has(p.dexId.toLowerCase()));
  const pool = standard.length > 0 ? standard : matching;
  return [...pool].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
}
