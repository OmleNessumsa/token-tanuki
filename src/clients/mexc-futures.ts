/**
 * MEXC Futures (Contract) public API client.
 * Base: https://contract.mexc.com/api/v1
 * No API key needed for these public endpoints.
 *
 * Symbols use underscore format: "BTC_USDT" (perp swap), not "BTCUSDT".
 *
 * Docs: https://mexcdevelop.github.io/apidocs/contract_v1_en/
 */

import { fetchJson } from "../http.js";
import type { Candle } from "../analysis/indicators.js";

const BASE = "https://contract.mexc.com/api/v1";

export type FuturesInterval = "Min1" | "Min5" | "Min15" | "Min30" | "Min60" | "Hour4" | "Hour8" | "Day1" | "Week1" | "Month1";

export interface FuturesTicker {
  symbol: string;
  lastPrice: number;
  bid1: number;
  ask1: number;
  volume24: number;       // 24h base volume in contracts
  amount24: number;       // 24h quote (USDT) volume
  holdVol: number;        // open interest in contracts
  lower24Price: number;
  high24Price: number;
  riseFallRate: number;   // 24h % change as fraction (e.g. 0.012 = +1.2%)
  fundingRate: number;    // current funding rate (per cycle)
  indexPrice: number;
  fairPrice: number;
  timestamp: number;
}

export interface FundingRateInfo {
  symbol: string;
  fundingRate: number;       // per-cycle (e.g. 0.0001 = 0.01%/8h ≈ 11% APR)
  maxFundingRate: number;
  minFundingRate: number;
  collectCycle: number;      // hours per cycle (typically 8)
  nextSettleTime: number;
}

export interface FundingHistoryEntry {
  symbol: string;
  fundingRate: number;
  settleTime: number;
}

interface KlineRaw {
  time: number[];
  open: number[];
  close: number[];
  high: number[];
  low: number[];
  vol: number[];
  amount: number[];
}

/** Pull klines for a perp symbol. MEXC returns parallel arrays — we zip into Candle[]. */
export async function getFuturesKlines(symbol: string, interval: FuturesInterval, limit = 500): Promise<Candle[]> {
  // MEXC returns up to 2000 bars without a limit param; some intervals respect ?limit=.
  // To be safe, just take the last `limit` from the full response.
  const url = `${BASE}/contract/kline/${symbol}?interval=${interval}`;
  try {
    const resp = await fetchJson<{ success: boolean; data: KlineRaw }>(url);
    if (!resp.success || !resp.data) return [];
    const d = resp.data;
    const n = d.time.length;
    const start = Math.max(0, n - limit);
    const out: Candle[] = [];
    for (let i = start; i < n; i++) {
      out.push({
        t: d.time[i]!,
        o: d.open[i]!,
        h: d.high[i]!,
        l: d.low[i]!,
        c: d.close[i]!,
        v: d.amount[i]!,   // use quote volume (USDT) — apples-to-apples with our other USD-denominated logic
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function getFuturesTicker(symbol: string): Promise<FuturesTicker | null> {
  const url = `${BASE}/contract/ticker?symbol=${symbol}`;
  try {
    const resp = await fetchJson<{ success: boolean; data: FuturesTicker }>(url);
    return resp.success ? resp.data : null;
  } catch {
    return null;
  }
}

export async function getFundingRate(symbol: string): Promise<FundingRateInfo | null> {
  const url = `${BASE}/contract/funding_rate/${symbol}`;
  try {
    const resp = await fetchJson<{ success: boolean; data: FundingRateInfo }>(url);
    return resp.success ? resp.data : null;
  } catch {
    return null;
  }
}

export async function getFundingHistory(symbol: string, pages = 1, pageSize = 50): Promise<FundingHistoryEntry[]> {
  const out: FundingHistoryEntry[] = [];
  for (let p = 1; p <= pages; p++) {
    const url = `${BASE}/contract/funding_rate/history?symbol=${symbol}&page_num=${p}&page_size=${pageSize}`;
    try {
      const resp = await fetchJson<{ success: boolean; data: { resultList: FundingHistoryEntry[] } }>(url);
      if (resp.success && resp.data?.resultList) out.push(...resp.data.resultList);
    } catch { break; }
  }
  return out;
}

let cachedSymbols: Set<string> | null = null;
let cachedAt = 0;
const SYMBOLS_TTL = 60 * 60 * 1000;

export async function symbolExists(symbol: string): Promise<boolean> {
  if (!cachedSymbols || Date.now() - cachedAt > SYMBOLS_TTL) {
    try {
      const resp = await fetchJson<{ success: boolean; data: Array<{ symbol: string; state: number }> }>(`${BASE}/contract/detail`);
      if (resp.success && resp.data) {
        cachedSymbols = new Set(resp.data.filter((s) => s.state === 0).map((s) => s.symbol));
        cachedAt = Date.now();
      }
    } catch {
      return false;
    }
  }
  return cachedSymbols?.has(symbol) ?? false;
}

/** Known aliases where the asset's MEXC perp symbol differs from the common ticker. */
const PERP_ALIASES: Record<string, string> = {
  TON: "TONCOIN",
  // Add more here when discovered
};

/** Try the canonical USDT perp first, then USD perp, with alias fallback. */
export async function findCanonicalPerp(asset: string): Promise<string | null> {
  const upper = asset.toUpperCase();
  const candidates: string[] = [];
  candidates.push(`${upper}_USDT`, `${upper}_USD`);
  if (PERP_ALIASES[upper]) {
    const aliased = PERP_ALIASES[upper];
    candidates.push(`${aliased}_USDT`, `${aliased}_USD`);
  }
  for (const c of candidates) {
    if (await symbolExists(c)) return c;
  }
  return null;
}

/**
 * Funding rate analysis — interprets the per-cycle rate.
 *
 * Cycle = 8 hours typically → multiply by 3 to get daily, by ~1095 to get APR.
 *
 * Rule of thumb (per 8h cycle):
 *   < -0.05% (-0.0005)  → paid heavily to long; shorts crowded → bullish bias
 *   -0.05% to +0.01%    → neutral / slightly long-biased
 *   +0.01% to +0.05%    → longs paying — normal bull market
 *   +0.05% to +0.10%    → crowded long — squeeze risk if BTC dumps
 *   > +0.10% (>0.001)   → euphoria — high reversal risk
 */
export interface FundingAnalysis {
  ratePerCycle: number;
  cycleHours: number;
  apr: number;            // approximate annualized
  regime: "paid_to_long" | "neutral" | "normal_bull" | "crowded_long" | "euphoria";
  /** Score adjustment to a long-side position (negative = headwind, positive = tailwind). */
  longBiasScore: number;
  description: string;
}

export function analyzeFundingRate(info: FundingRateInfo): FundingAnalysis {
  const r = info.fundingRate;
  const cycles = (24 / info.collectCycle) * 365;
  const apr = r * cycles * 100;

  let regime: FundingAnalysis["regime"];
  let score: number;
  let desc: string;

  if (r < -0.0005) {
    regime = "paid_to_long";
    score = +8;
    desc = `Funding ${(r * 100).toFixed(4)}% (${apr.toFixed(1)}% APR) — shorts paying to long, contrarian bullish`;
  } else if (r < 0.0001) {
    regime = "neutral";
    score = +1;
    desc = `Funding ${(r * 100).toFixed(4)}% (${apr.toFixed(1)}% APR) — neutral`;
  } else if (r < 0.0005) {
    regime = "normal_bull";
    score = 0;
    desc = `Funding ${(r * 100).toFixed(4)}% (${apr.toFixed(1)}% APR) — normal long pressure`;
  } else if (r < 0.001) {
    regime = "crowded_long";
    score = -8;
    desc = `Funding ${(r * 100).toFixed(4)}% (${apr.toFixed(1)}% APR) — crowded long, squeeze risk if BTC drops`;
  } else {
    regime = "euphoria";
    score = -15;
    desc = `Funding ${(r * 100).toFixed(4)}% (${apr.toFixed(1)}% APR) — euphoric long positioning, high reversal risk`;
  }

  return { ratePerCycle: r, cycleHours: info.collectCycle, apr, regime, longBiasScore: score, description: desc };
}
