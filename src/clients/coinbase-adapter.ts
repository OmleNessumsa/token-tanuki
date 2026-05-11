/**
 * Coinbase Advanced Trade — spot adapter implementing ExchangeAdapter.
 *
 * Public market data only in this module (S2a). Private endpoints
 * (balances, orders) land in coinbase-private.ts in S2b.
 *
 * Spot characteristics:
 *  - No leverage, no shorts (supportsShort=false, supportsLeverage=false)
 *  - No funding rate / OI (getFundingRate omitted; ticker leaves those fields undefined)
 *  - No native 4h granularity → adapter aggregates from 1h candles
 */

import type { ExchangeAdapter, Ticker, Timeframe } from "../exchange.js";
import {
  aggregateCandles,
  findCanonicalSpot,
  getNativeCandles,
  getProduct,
  productExists,
  type CoinbaseGranularity,
} from "./coinbase.js";

interface TfMapEntry {
  granularity: CoinbaseGranularity;
  /** Aggregation factor — how many native bars to fold into one output bar. */
  factor: number;
}

const TF_TO_COINBASE: Record<Timeframe, TfMapEntry> = {
  "1m":  { granularity: "ONE_MINUTE",     factor: 1 },
  "5m":  { granularity: "FIVE_MINUTE",    factor: 1 },
  "15m": { granularity: "FIFTEEN_MINUTE", factor: 1 },
  "30m": { granularity: "THIRTY_MINUTE",  factor: 1 },
  "1h":  { granularity: "ONE_HOUR",       factor: 1 },
  "4h":  { granularity: "ONE_HOUR",       factor: 4 },   // Coinbase has no native 4h
  "8h":  { granularity: "TWO_HOUR",       factor: 4 },   // No native 8h either
  "1d":  { granularity: "ONE_DAY",        factor: 1 },
  "1w":  { granularity: "ONE_DAY",        factor: 7 },
};

export const coinbaseSpotAdapter: ExchangeAdapter = {
  id: "coinbase-spot",
  kind: "spot",
  supportsShort: false,
  supportsLeverage: false,

  async getKlines(symbol, tf, limit = 500) {
    const mapped = TF_TO_COINBASE[tf];
    const nativeLimit = limit * mapped.factor;
    const native = await getNativeCandles(symbol, mapped.granularity, nativeLimit);
    return aggregateCandles(native, mapped.factor);
  },

  async getTicker(symbol) {
    const p = await getProduct(symbol);
    if (!p) return null;
    const lastPrice = Number(p.price);
    const baseVol = Number(p.volume_24h);
    const pct = Number(p.price_percentage_change_24h);
    // Spot has no bid/ask in this endpoint — proxy with lastPrice. A book
    // call could refine it later if needed by the strategy.
    const ticker: Ticker = {
      symbol: p.product_id,
      lastPrice,
      bid: lastPrice,
      ask: lastPrice,
      // Coinbase volume_24h is base-asset units. Convert to quote for
      // apples-to-apples with MEXC quote-USDT volume convention.
      volume24Quote: Number.isFinite(baseVol) ? baseVol * lastPrice : 0,
      // 24h high/low not in product endpoint — fall back to lastPrice. A
      // ticker-book call could fill this in later.
      high24: lastPrice,
      low24: lastPrice,
      // Coinbase returns a percentage (e.g. 0.085 = 0.085%), MEXC returns a
      // fraction (e.g. 0.085 = 8.5%). Normalize to MEXC's fraction convention.
      riseFallRate: Number.isFinite(pct) ? pct / 100 : 0,
      timestamp: Date.now(),
    };
    return ticker;
  },

  symbolExists: productExists,

  findCanonicalSymbol: findCanonicalSpot,
};
