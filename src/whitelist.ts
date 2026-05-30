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
 * Blofin perpetual futures universe (USDT-quoted). Symbol format is
 * `BASE-USDT`, matching Blofin's instId convention. On a futures exchange we
 * get leverage, shorts, and ~20× lower fees (0.06% taker vs 1.20% on Coinbase
 * Intro 1).
 *
 * Curation (2026-05-30): expanded from top-10 to top-30 to grow signal volume
 * while keeping signal quality. Curated by hand against Blofin's live
 * perp list — pure volume-ranked top-30 was dominated by meme/shitcoin
 * volume anomalies (PEPE/SHIB/BONK/NOM/JCT/etc.) where 1.5% stops can't
 * even clear the bid-ask spread. Memes and tail-coins get their own
 * scanner loop on the backlog (see CB-8). Composition: 10 majors + 4
 * large-cap stalwarts + 7 L1s + 2 L2s + 4 DeFi + 3 storage/AI.
 *
 * MATIC is aliased to POL inside blofin.ts (Polygon rebrand).
 */
export const BLOFIN_TOP30_PERP: readonly string[] = [
  // Majors (original top-10)
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
  // Large-cap stalwarts
  "TRX-USDT",
  "BCH-USDT",
  "LTC-USDT",
  "XLM-USDT",
  // L1s
  "SUI-USDT",
  "TIA-USDT",
  "APT-USDT",
  "NEAR-USDT",
  "ATOM-USDT",
  "SEI-USDT",
  "HBAR-USDT",
  // L2s
  "ARB-USDT",
  "OP-USDT",
  // DeFi
  "UNI-USDT",
  "AAVE-USDT",
  "INJ-USDT",
  "LDO-USDT",
  // Storage / AI
  "FIL-USDT",
  "FET-USDT",
  "TAO-USDT",
] as const;

export const BLOFIN_TOP30_ASSETS: readonly string[] = [
  "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT", "POL",
  "TRX", "BCH", "LTC", "XLM",
  "SUI", "TIA", "APT", "NEAR", "ATOM", "SEI", "HBAR",
  "ARB", "OP",
  "UNI", "AAVE", "INJ", "LDO",
  "FIL", "FET", "TAO",
] as const;

/**
 * Subset Blofin is allowed to auto-fire on. Top-30 active by default — we
 * curated this list (no memes/shitcoins) so every entry is fire-eligible.
 * Re-evaluate after ~30 closed Blofin paper trades; suspend any asset
 * with WR <20% over n ≥ 5.
 */
export const BLOFIN_ACTIVE_ASSETS: readonly string[] = BLOFIN_TOP30_ASSETS;
