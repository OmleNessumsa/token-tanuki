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

/**
 * Subset of top-10 we currently allow the auto-fire path to act on. The
 * scanner still RENDERS the full top-10 (observability) but `--fire` only
 * writes signals for assets in this list. Re-evaluate after every batch of
 * ~30 closed paper trades.
 *
 * Rationale (post-mortem 2026-05-15, 76 closed trades):
 *   BTC   WR 14%, -7.75R   → suspended
 *   XRP   WR  0%, -5.00R   → suspended (n=5)
 *   DOT   WR  0%, -1.00R   → suspended (n=1, small but ugly)
 *   AVAX  WR  0%, -1.00R   → suspended (n=1)
 *   POL   no closed trades yet → keep paused with the above
 *   DOGE  WR 52%, +8.83R   → ACTIVE
 *   LINK  WR 41%, breakeven gross → ACTIVE (high volume, gives data)
 *   ETH/SOL/ADA: no closed sample yet → ACTIVE on prior majors prior
 */
export const COINBASE_ACTIVE_ASSETS: readonly string[] = [
  "ETH", "SOL", "DOGE", "ADA", "LINK",
] as const;

/**
 * Blofin perpetual futures top-10 (USDT-quoted). Symbol format is `BASE-USDT`,
 * matching Blofin's instId convention. Same asset set as Coinbase for apples-
 * to-apples comparison — but on a futures exchange we get leverage, shorts,
 * and ~20× lower fees (0.06% taker vs 1.20% on Coinbase Intro 1).
 *
 * MATIC is aliased to POL inside blofin.ts (Polygon rebrand).
 */
export const BLOFIN_TOP10_PERP: readonly string[] = [
  "BTC-USDT",
  "ETH-USDT",
  "SOL-USDT",
  "XRP-USDT",
  "DOGE-USDT",
  "ADA-USDT",
  "AVAX-USDT",
  "LINK-USDT",
  "DOT-USDT",
  "POL-USDT",       // formerly MATIC
] as const;

export const BLOFIN_TOP10_ASSETS: readonly string[] = [
  "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT", "POL",
] as const;

/**
 * Subset Blofin is allowed to auto-fire on. We start with ALL of top-10 active
 * — we don't have Blofin forward-test data yet, and the Coinbase blacklist
 * (BTC/XRP/DOT/AVAX/POL) was driven by Coinbase-spot fee economics, not by
 * the underlying asset's setup quality. Re-evaluate after ~30 closed Blofin
 * paper trades.
 */
export const BLOFIN_ACTIVE_ASSETS: readonly string[] = BLOFIN_TOP10_ASSETS;
