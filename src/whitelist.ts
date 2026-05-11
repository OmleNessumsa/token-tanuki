/**
 * Asset whitelists per exchange. The auto-trader (S4) will only act on
 * symbols in these lists. Hand-edit when adding/removing pairs. Each entry
 * is the adapter's canonical symbol — not a generic ticker.
 *
 * Coinbase top-10: BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, LINK, DOT, MATIC.
 * MATIC is auto-resolved to POL-USD via the SPOT_ALIASES table in
 * coinbase.ts (Polygon rebrand).
 */

export const COINBASE_TOP10_SPOT: readonly string[] = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "XRP-USD",
  "DOGE-USD",
  "ADA-USD",
  "AVAX-USD",
  "LINK-USD",
  "DOT-USD",
  "POL-USD",       // formerly MATIC
] as const;

export const COINBASE_TOP10_ASSETS: readonly string[] = [
  "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT", "MATIC",
] as const;
