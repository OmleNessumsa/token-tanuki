/**
 * CoinGlass API client (v4).
 * Auth header: `CG-API-KEY: <key>`. Set COINGLASS_API_KEY in .env.
 *
 * Note: this user's plan does NOT include `/liquidation/heatmap/model2`
 * (returns 401 "Upgrade plan"). We use `/liquidation/aggregated-history`
 * as the alternative cascade-event source.
 */

import { config, endpoints } from "../config.js";
import { fetchJson } from "../http.js";

const BASE = endpoints.coinglass;

interface CgEnvelope<T> { code: string; msg?: string; data: T; }

function cgHeaders(): Record<string, string> {
  if (!config.coinglassKey) throw new Error("COINGLASS_API_KEY not set in env");
  return { "CG-API-KEY": config.coinglassKey };
}

async function cgGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const stringified: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) stringified[k] = String(v);
  const qs = new URLSearchParams(stringified).toString();
  const url = `${BASE}${path}?${qs}`;
  const resp = await fetchJson<CgEnvelope<T>>(url, { headers: cgHeaders() });
  if (resp.code !== "0") throw new Error(`CoinGlass ${path}: ${resp.code} ${resp.msg ?? ""}`);
  return resp.data;
}

// ── Tiny in-memory cache (per-process, TTL-keyed) ────────────────────────────
const cache = new Map<string, { value: unknown; expires: number }>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

// ── Funding rates ────────────────────────────────────────────────────────────
export interface CgFundingExchangeEntry {
  exchange: string;
  funding_rate: number;
  funding_rate_interval: number;
  next_funding_time: number;
}
interface CgFundingResp { symbol: string; stablecoin_margin_list: CgFundingExchangeEntry[]; token_margin_list?: CgFundingExchangeEntry[]; }

/** Single network call returns ALL symbols; we cache the full list and filter client-side. */
async function getAllFundingRates(): Promise<CgFundingResp[]> {
  return cached(`funding:ALL`, 60_000, () =>
    cgGet<CgFundingResp[]>("/api/futures/funding-rate/exchange-list", {}),
  );
}

export async function getFundingRates(symbol: string): Promise<CgFundingResp | null> {
  const all = await getAllFundingRates().catch(() => null);
  if (!all) return null;
  return all.find((r) => r.symbol === symbol) ?? null;
}

/** Derived: highest funding rate among major exchanges (in % per 8h). */
export interface FundingExtreme { maxPct: number; minPct: number; medianPct: number; sources: number; }

export async function getFundingExtreme(symbol: string): Promise<FundingExtreme | null> {
  const entry = await getFundingRates(symbol);
  if (!entry) return null;
  const list = entry.stablecoin_margin_list ?? [];
  if (list.length === 0) return null;
  const rates = list
    .map((e) => Number(e.funding_rate) * 100)
    .filter((r) => Number.isFinite(r))
    .sort((a, b) => a - b);
  if (rates.length === 0) return null;
  const median = rates[Math.floor(rates.length / 2)] ?? 0;
  return { maxPct: rates[rates.length - 1] ?? 0, minPct: rates[0] ?? 0, medianPct: median, sources: rates.length };
}

// ── Open interest history ────────────────────────────────────────────────────
export interface CgOiBar { time: number; open: string | number; high: string | number; low: string | number; close: string | number; }

export async function getOpenInterestHistory(symbol: string, interval = "4h", limit = 100): Promise<CgOiBar[]> {
  return cached(`oi:${symbol}:${interval}:${limit}`, 5 * 60_000, () =>
    cgGet<CgOiBar[]>("/api/futures/open-interest/aggregated-history", { symbol, interval, limit }),
  );
}

/** Derived: % change in OI close over the last N bars. */
export async function getOiChangePct(symbol: string, interval = "4h", lookback = 6): Promise<number | null> {
  const bars = await getOpenInterestHistory(symbol, interval, Math.max(lookback + 1, 10)).catch(() => null);
  if (!bars || bars.length < lookback + 1) return null;
  const last = Number(bars[bars.length - 1]!.close);
  const prev = Number(bars[bars.length - 1 - lookback]!.close);
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return null;
  return ((last - prev) / prev) * 100;
}

// ── Liquidation history (cascade events; heatmap proxy) ──────────────────────
export interface CgLiqBar { time: number; aggregated_long_liquidation_usd: number; aggregated_short_liquidation_usd: number; }

const DEFAULT_EXCHANGES = "Binance,OKX,Bybit";

export async function getLiquidationHistory(symbol: string, interval = "4h", limit = 100, exchanges = DEFAULT_EXCHANGES): Promise<CgLiqBar[]> {
  return cached(`liq:${symbol}:${interval}:${limit}:${exchanges}`, 5 * 60_000, () =>
    cgGet<CgLiqBar[]>("/api/futures/liquidation/aggregated-history", { symbol, interval, limit, exchange_list: exchanges }),
  );
}

/** Derived: ratio of long-liq to total over the last N bars. >0.7 = recent long-cascade (potential bottom). */
export async function getRecentLiqSkew(symbol: string, interval = "4h", lookback = 6): Promise<{ longShare: number; totalUsd: number } | null> {
  const bars = await getLiquidationHistory(symbol, interval, lookback).catch(() => null);
  if (!bars || bars.length === 0) return null;
  const longSum = bars.reduce((a, b) => a + b.aggregated_long_liquidation_usd, 0);
  const shortSum = bars.reduce((a, b) => a + b.aggregated_short_liquidation_usd, 0);
  const total = longSum + shortSum;
  if (total === 0) return null;
  return { longShare: longSum / total, totalUsd: total };
}

// ── Taker buy/sell volume (cumulative pressure) ──────────────────────────────
export interface CgTakerBar { time: number; aggregated_buy_volume_usd: number; aggregated_sell_volume_usd: number; }

export async function getTakerVolumeHistory(symbol: string, interval = "4h", limit = 100, exchanges = DEFAULT_EXCHANGES): Promise<CgTakerBar[]> {
  return cached(`taker:${symbol}:${interval}:${limit}:${exchanges}`, 5 * 60_000, () =>
    cgGet<CgTakerBar[]>("/api/futures/aggregated-taker-buy-sell-volume/history", { symbol, interval, limit, exchange_list: exchanges }),
  );
}

/** Derived: net buy-pressure over lookback (+1 = all buy, -1 = all sell). */
export async function getTakerPressure(symbol: string, interval = "4h", lookback = 6): Promise<number | null> {
  const bars = await getTakerVolumeHistory(symbol, interval, lookback).catch(() => null);
  if (!bars || bars.length === 0) return null;
  const buy = bars.reduce((a, b) => a + b.aggregated_buy_volume_usd, 0);
  const sell = bars.reduce((a, b) => a + b.aggregated_sell_volume_usd, 0);
  const total = buy + sell;
  if (total === 0) return null;
  return (buy - sell) / total;
}

// ── Convenience: bundled snapshot for a symbol ───────────────────────────────
export interface CgSnapshot {
  symbol: string;
  funding: FundingExtreme | null;
  oiChangePct24h: number | null;        // 24h via 6×4h bars
  liqSkew24h: { longShare: number; totalUsd: number } | null;
  takerPressure24h: number | null;      // [-1, +1]
}

export async function getSnapshot(symbol: string): Promise<CgSnapshot> {
  const [funding, oi, liq, taker] = await Promise.all([
    getFundingExtreme(symbol),
    getOiChangePct(symbol, "4h", 6),
    getRecentLiqSkew(symbol, "4h", 6),
    getTakerPressure(symbol, "4h", 6),
  ]);
  return { symbol, funding, oiChangePct24h: oi, liqSkew24h: liq, takerPressure24h: taker };
}
