/**
 * Intermarket analysis layer.
 * Source concept: John J. Murphy, "Technical Analysis of the Financial Markets"
 *   (NYIF, 1999), Ch. 17 — Intermarket Analysis.
 *
 * Murphy's principle: assets are connected. In TradFi the canonical chain is:
 *   USD ↑ → commodities ↓; bonds ↑ → stocks (eventually) ↑; stocks ↓ → bonds ↑.
 *
 * Crypto translation: BTC dominance is the dominant intermarket variable.
 *   - BTC.D rising = capital flows TO BTC, away from alts → alt charts decay
 *   - BTC.D falling + BTC stable/rising = "altseason" — alts outperform
 *   - BTC dump = whole crypto market dumps regardless of token-specific story
 *
 * This module fetches BTC and the queried token's recent prices, computes the
 * regime, and produces a bias adjustment for the verdict layer.
 */

import { fetchJson } from "../http.js";
import { config } from "../config.js";

const BTC_USDT_BIRDEYE_MINT = "So11111111111111111111111111111111111111112"; // Wrapped SOL is just placeholder; real BTC requires CG.
const COINGECKO_BTC_ID = "bitcoin";

export type Regime =
  | "btc_dump"             // BTC down >5% in 24h — risk-off, no alt longs
  | "btc_dominance_rising" // alts underperforming BTC; reduce conviction on alt longs
  | "altseason"            // BTC.D falling + BTC stable; alt longs amplified
  | "neutral"              // no strong intermarket signal
  | "unknown";             // couldn't fetch data

export interface IntermarketContext {
  regime: Regime;
  btcChange24hPct: number | null;
  btcChange7dPct: number | null;
  /** -10..+10 — caller multiplies their alt-long score by this multiplier. */
  altLongMultiplier: number;
  description: string;
}

interface CgMarketChart {
  prices: Array<[number, number]>;
}

const CACHE_TTL_MS = 60_000;
let cachedAt = 0;
let cached: IntermarketContext | null = null;

export async function getIntermarketContext(): Promise<IntermarketContext> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;

  try {
    // CoinGecko free endpoint — last 7 days of BTC prices, hourly granularity.
    // Demo API key (env COINGECKO_API_KEY) gives 30 rpm vs ~5 anonymous.
    const url = `https://api.coingecko.com/api/v3/coins/${COINGECKO_BTC_ID}/market_chart?vs_currency=usd&days=7`;
    const headers: Record<string, string> = config.coingeckoKey
      ? { "x-cg-demo-api-key": config.coingeckoKey }
      : {};
    const data = await fetchJson<CgMarketChart>(url, { headers });
    const prices = data.prices ?? [];
    if (prices.length < 25) {
      cached = unknown("insufficient BTC price data");
      cachedAt = Date.now();
      return cached;
    }
    const last = prices[prices.length - 1]![1];
    const oneDayAgo = prices[Math.max(0, prices.length - 25)]![1];
    const sevenDaysAgo = prices[0]![1];
    const change24h = (last - oneDayAgo) / oneDayAgo * 100;
    const change7d = (last - sevenDaysAgo) / sevenDaysAgo * 100;

    let regime: Regime;
    let mult: number;
    let desc: string;

    if (change24h <= -5) {
      regime = "btc_dump";
      mult = 0.2;
      desc = `BTC −${Math.abs(change24h).toFixed(1)}% in 24h — risk-off, alt longs likely to dump regardless of fundamentals`;
    } else if (change7d > 8 && change24h < 1) {
      // BTC ran hard the past week but is now stable — capital may rotate to alts
      regime = "altseason";
      mult = 1.3;
      desc = `BTC +${change7d.toFixed(1)}% in 7d, +${change24h.toFixed(1)}% 24h — capital rotation into alts likely`;
    } else if (change24h < -2) {
      regime = "btc_dominance_rising";
      mult = 0.7;
      desc = `BTC ${change24h.toFixed(1)}% 24h — alt longs face headwind`;
    } else if (change24h > 2) {
      regime = "neutral";
      mult = 1.1;
      desc = `BTC +${change24h.toFixed(1)}% 24h — risk-on, mild tailwind for alts`;
    } else {
      regime = "neutral";
      mult = 1.0;
      desc = `BTC ${change24h.toFixed(2)}% 24h — sideways, no intermarket bias`;
    }

    cached = {
      regime,
      btcChange24hPct: change24h,
      btcChange7dPct: change7d,
      altLongMultiplier: mult,
      description: desc,
    };
    cachedAt = Date.now();
    return cached;
  } catch {
    cached = unknown("BTC price fetch failed");
    cachedAt = Date.now();
    return cached;
  }
}

function unknown(reason: string): IntermarketContext {
  return {
    regime: "unknown",
    btcChange24hPct: null,
    btcChange7dPct: null,
    altLongMultiplier: 1.0,
    description: `intermarket context unavailable: ${reason}`,
  };
}

/** Pure function for tests: classify regime from BTC % changes. */
export function classifyRegime(change24hPct: number, change7dPct: number): Regime {
  if (change24hPct <= -5) return "btc_dump";
  if (change7dPct > 8 && change24hPct < 1) return "altseason";
  if (change24hPct < -2) return "btc_dominance_rising";
  return "neutral";
}
