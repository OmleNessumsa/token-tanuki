/**
 * Coinbase Advanced Trade — public market data client.
 * Base: https://api.coinbase.com/api/v3/brokerage/market
 * No API key required for these endpoints.
 *
 * Symbols use dash format: "BTC-USD" (spot), not "BTCUSD".
 *
 * Docs: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis
 */

import { fetchJson } from "../http.js";
import type { Candle } from "../analysis/indicators.js";

const BASE = "https://api.coinbase.com/api/v3/brokerage/market";

/** Native Coinbase granularities for the candles endpoint. */
export type CoinbaseGranularity =
  | "ONE_MINUTE"
  | "FIVE_MINUTE"
  | "FIFTEEN_MINUTE"
  | "THIRTY_MINUTE"
  | "ONE_HOUR"
  | "TWO_HOUR"
  | "SIX_HOUR"
  | "ONE_DAY";

/** Approx seconds per native granularity bar. */
export const GRANULARITY_SECONDS: Record<CoinbaseGranularity, number> = {
  ONE_MINUTE: 60,
  FIVE_MINUTE: 300,
  FIFTEEN_MINUTE: 900,
  THIRTY_MINUTE: 1800,
  ONE_HOUR: 3600,
  TWO_HOUR: 7200,
  SIX_HOUR: 21600,
  ONE_DAY: 86400,
};

/** Max candles returned per Advanced Trade request. */
export const CANDLES_PER_REQUEST = 350;

export interface CoinbaseProduct {
  product_id: string;
  base_name: string;
  base_currency_id: string;
  quote_currency_id: string;
  price: string;
  price_percentage_change_24h: string;
  volume_24h: string;
  volume_percentage_change_24h?: string;
  base_min_size: string;
  quote_min_size: string;
  status: string;
  trading_disabled: boolean;
  is_disabled?: boolean;
  new?: boolean;
}

interface ProductsResp {
  products: CoinbaseProduct[];
  num_products: number;
}

interface CandleRaw {
  start: string;       // unix seconds as string
  low: string;
  high: string;
  open: string;
  close: string;
  volume: string;      // base-asset volume
}

interface CandlesResp {
  candles: CandleRaw[];
}

const num = (s: string | undefined | null): number => {
  if (s == null) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

export async function getProducts(): Promise<CoinbaseProduct[]> {
  try {
    const resp = await fetchJson<ProductsResp>(`${BASE}/products`);
    return resp.products ?? [];
  } catch {
    return [];
  }
}

export async function getProduct(productId: string): Promise<CoinbaseProduct | null> {
  try {
    return await fetchJson<CoinbaseProduct>(`${BASE}/products/${encodeURIComponent(productId)}`);
  } catch {
    return null;
  }
}

/**
 * Pull native-granularity candles. Coinbase requires `start` and `end` unix
 * seconds and returns at most 350 bars per call (newest first). This helper
 * pages backward to satisfy `limit`, then reverses to oldest-first to match
 * the convention used elsewhere in this codebase. Volume is converted from
 * base-asset units to quote-asset units (close * volume) for apples-to-apples
 * comparison with MEXC quote-USDT volume.
 */
export async function getNativeCandles(
  productId: string,
  granularity: CoinbaseGranularity,
  limit: number,
): Promise<Candle[]> {
  const secondsPerBar = GRANULARITY_SECONDS[granularity];
  const collected: CandleRaw[] = [];
  let end = Math.floor(Date.now() / 1000);

  while (collected.length < limit) {
    const remaining = limit - collected.length;
    const pageBars = Math.min(remaining, CANDLES_PER_REQUEST);
    const start = end - pageBars * secondsPerBar;
    const url =
      `${BASE}/products/${encodeURIComponent(productId)}/candles` +
      `?start=${start}&end=${end}&granularity=${granularity}`;
    let page: CandleRaw[] = [];
    try {
      const resp = await fetchJson<CandlesResp>(url);
      page = resp.candles ?? [];
    } catch {
      break;
    }
    if (page.length === 0) break;
    collected.push(...page);
    if (page.length < pageBars) break;
    // Walk window backward; oldest start in this page becomes the new end.
    const oldestStart = num(page[page.length - 1]!.start);
    if (!Number.isFinite(oldestStart) || oldestStart >= end) break;
    end = oldestStart;
  }

  // Coinbase returns newest first; convert to oldest first.
  const ordered = collected.slice().reverse();
  return ordered.map((c) => {
    const close = num(c.close);
    const baseVol = num(c.volume);
    return {
      t: num(c.start),
      o: num(c.open),
      h: num(c.high),
      l: num(c.low),
      c: close,
      v: close * baseVol,
    };
  });
}

/**
 * Aggregate N native candles into one. Used when the requested timeframe is
 * not a native Coinbase granularity (notably 4h — Coinbase has 2h and 6h but
 * not 4h).
 */
export function aggregateCandles(candles: Candle[], factor: number): Candle[] {
  if (factor <= 1) return candles;
  const out: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    let high = first.h, low = first.l, vol = 0;
    for (const g of group) {
      if (g.h > high) high = g.h;
      if (g.l < low) low = g.l;
      vol += g.v;
    }
    out.push({ t: first.t, o: first.o, h: high, l: low, c: last.c, v: vol });
  }
  return out;
}

let cachedProducts: Map<string, CoinbaseProduct> | null = null;
let cachedAt = 0;
const PRODUCTS_TTL = 60 * 60 * 1000;

async function getCachedProducts(): Promise<Map<string, CoinbaseProduct>> {
  if (!cachedProducts || Date.now() - cachedAt > PRODUCTS_TTL) {
    const list = await getProducts();
    cachedProducts = new Map(list.map((p) => [p.product_id, p]));
    cachedAt = Date.now();
  }
  return cachedProducts;
}

export async function productExists(productId: string): Promise<boolean> {
  const cache = await getCachedProducts();
  const p = cache.get(productId);
  return !!p && p.status === "online" && !p.trading_disabled;
}

/**
 * Try the canonical USDC spot pair first, then USD as fallback for non-EU
 * users. Coinbase EU consumer accounts cannot hold USD fiat, so USDC pairs
 * are the only ones actually tradable in EU.
 * Known aliases: MATIC → POL (Polygon rebrand).
 */
const SPOT_ALIASES: Record<string, string> = {
  MATIC: "POL",
};

export async function findCanonicalSpot(asset: string): Promise<string | null> {
  const upper = asset.toUpperCase();
  const candidates: string[] = [];
  candidates.push(`${upper}-USDC`, `${upper}-USD`);
  if (SPOT_ALIASES[upper]) {
    const aliased = SPOT_ALIASES[upper];
    candidates.push(`${aliased}-USDC`, `${aliased}-USD`);
  }
  for (const c of candidates) {
    if (await productExists(c)) return c;
  }
  return null;
}

/** Test-only: reset the products cache. */
export function _resetProductsCache(): void {
  cachedProducts = null;
  cachedAt = 0;
}
