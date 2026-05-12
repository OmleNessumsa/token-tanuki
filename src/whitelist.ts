/**
 * Asset whitelists per exchange. The auto-trader (S4) will only act on
 * symbols in these lists. Hand-edit when adding/removing pairs. Each entry
 * is the adapter's canonical symbol — not a generic ticker.
 *
 * Coinbase top-10: BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, LINK, DOT, MATIC.
 * MATIC is auto-resolved to POL-USDC via the SPOT_ALIASES table in
 * coinbase.ts (Polygon rebrand).
 *
 * USDC pairs (not USD): Coinbase EU consumer accounts cannot hold USD fiat,
 * so USDC is the only USD-equivalent stablecoin we can actually trade
 * against. Fund the account by buying USDC with EUR once, then trade
 * USDC pairs from there.
 */

export const COINBASE_TOP10_SPOT: readonly string[] = [
  "BTC-USDC",
  "ETH-USDC",
  "SOL-USDC",
  "XRP-USDC",
  "DOGE-USDC",
  "ADA-USDC",
  "AVAX-USDC",
  "LINK-USDC",
  "DOT-USDC",
  "POL-USDC",       // formerly MATIC
] as const;

export const COINBASE_TOP10_ASSETS: readonly string[] = [
  "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT", "MATIC",
] as const;
