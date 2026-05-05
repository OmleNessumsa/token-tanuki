/**
 * MEXC public market data client.
 * No API key needed for these endpoints — only signed/private endpoints (orders,
 * account) require auth.
 *
 * Why we use it: native L1 coins (BTC, XRP, ADA, BNB native, etc.) and major alts
 * that don't have meaningful DEX liquidity. MEXC has CEX-quality OHLCV for them.
 *
 * https://mexcdevelop.github.io/apidocs/spot_v3_en/
 */

import { fetchJson } from "../http.js";
import type { Candle } from "../analysis/indicators.js";

const BASE = "https://api.mexc.com/api/v3";

export type MexcInterval = "1m" | "5m" | "15m" | "30m" | "60m" | "4h" | "1d" | "1W" | "1M";

export interface MexcTicker24h {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  prevClosePrice: string;
  lastPrice: string;
  bidPrice: string;
  askPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;       // base asset volume
  quoteVolume: string;  // USD volume
  openTime: number;
  closeTime: number;
  count: number;
}

/** Fetch OHLCV candles. Returns Candle[] in our internal shape. */
export async function getKlines(symbol: string, interval: MexcInterval, limit = 500): Promise<Candle[]> {
  const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(limit, 1000)}`;
  try {
    const raw = await fetchJson<unknown[][]>(url);
    if (!Array.isArray(raw)) return [];
    return raw.map((row) => ({
      t: Number(row[0]) / 1000,
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    })).filter((c) => Number.isFinite(c.c) && c.c > 0);
  } catch {
    return [];
  }
}

export async function get24hTicker(symbol: string): Promise<MexcTicker24h | null> {
  const url = `${BASE}/ticker/24hr?symbol=${symbol}`;
  try {
    return await fetchJson<MexcTicker24h>(url);
  } catch {
    return null;
  }
}

/** Check if a trading pair exists on MEXC spot. Caches symbols list across calls. */
let cachedSymbols: Set<string> | null = null;
let cachedAt = 0;
const SYMBOLS_TTL = 60 * 60 * 1000; // 1 hour

export async function symbolExists(symbol: string): Promise<boolean> {
  if (!cachedSymbols || Date.now() - cachedAt > SYMBOLS_TTL) {
    try {
      const info = await fetchJson<{ symbols: Array<{ symbol: string; status: string }> }>(`${BASE}/exchangeInfo`);
      cachedSymbols = new Set(info.symbols.filter((s) => s.status === "1" || s.status === "ENABLED" || s.status === "TRADING").map((s) => s.symbol));
      cachedAt = Date.now();
    } catch {
      return false;
    }
  }
  return cachedSymbols.has(symbol);
}

/**
 * Try the canonical USDT pair first, then USDC, then BTC pair as fallback.
 * Returns the first symbol that exists, or null.
 */
export async function findCanonicalPair(asset: string): Promise<string | null> {
  const candidates = [`${asset}USDT`, `${asset}USDC`, `${asset}BTC`];
  for (const c of candidates) {
    if (await symbolExists(c)) return c;
  }
  return null;
}
