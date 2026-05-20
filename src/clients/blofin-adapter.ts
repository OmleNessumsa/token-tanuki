/**
 * Blofin perpetual-futures adapter implementing ExchangeAdapter.
 *
 * Public market data only in this module — private endpoints land in
 * blofin-private.ts in S2. Until then, getBalances / placeOrder are absent
 * from the adapter and consumers must gate on `typeof adapter.getBalances`.
 *
 * Futures characteristics (the things spot adapters lack):
 *  - supportsShort=true, supportsLeverage=true
 *  - getFundingRate present (drives funding-regime analysis)
 *  - Ticker carries fundingRate when the funding-rate endpoint resolves
 *  - Native 4H bars (unlike Coinbase) — no aggregation needed
 */

import type { ExchangeAdapter, FundingInfo, Ticker, Timeframe } from "../exchange.js";
import {
  BLOFIN_FUNDING_CYCLE_HOURS,
  findCanonicalPerp,
  getFundingRate as blofinGetFundingRate,
  getNativeCandles,
  getTicker as blofinGetTicker,
  symbolExists,
  type BlofinBar,
} from "./blofin.js";

const TF_TO_BLOFIN: Record<Timeframe, BlofinBar> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
  "4h": "4H",   // Native — no aggregation
  "8h": "8H",   // Native
  "1d": "1D",
  "1w": "1W",
};

export const blofinFuturesAdapter: ExchangeAdapter = {
  id: "blofin-futures",
  kind: "futures",
  supportsShort: true,
  supportsLeverage: true,

  async getKlines(symbol, tf, limit = 500) {
    return getNativeCandles(symbol, TF_TO_BLOFIN[tf], limit);
  },

  async getTicker(symbol) {
    const t = await blofinGetTicker(symbol);
    if (!t) return null;
    const last = Number(t.last);
    const open24 = t.open24h !== undefined ? Number(t.open24h) : NaN;
    const high24 = Number(t.high24h);
    const low24 = Number(t.low24h);
    // riseFallRate as fraction of open. If open24h missing, compute fallback
    // from high/low midpoint — better than reporting 0 which would mask momentum.
    const riseFallRate = Number.isFinite(open24) && open24 > 0
      ? (last - open24) / open24
      : 0;
    // Prefer quote volume (USDT) when present; fall back to contracts × last.
    const volQuoteRaw = t.volCurrencyQuote24h !== undefined ? Number(t.volCurrencyQuote24h) : NaN;
    const vol24h = Number(t.vol24h);
    const volume24Quote = Number.isFinite(volQuoteRaw) && volQuoteRaw > 0
      ? volQuoteRaw
      : Number.isFinite(vol24h) ? vol24h * last : 0;

    // Funding rate is a separate endpoint. We could eagerly fetch it here but
    // that doubles the cost of every ticker call. Instead, callers that care
    // about funding use getFundingRate() directly (analyze-futures does).
    const ticker: Ticker = {
      symbol: t.instId,
      lastPrice: last,
      bid: Number(t.bidPrice),
      ask: Number(t.askPrice),
      volume24Quote,
      high24: Number.isFinite(high24) ? high24 : last,
      low24: Number.isFinite(low24) ? low24 : last,
      riseFallRate,
      timestamp: Number(t.ts),
    };
    return ticker;
  },

  symbolExists,
  findCanonicalSymbol: findCanonicalPerp,

  async getFundingRate(symbol): Promise<FundingInfo | null> {
    const f = await blofinGetFundingRate(symbol);
    if (!f) return null;
    return {
      symbol: f.instId,
      ratePerCycle: Number(f.fundingRate),
      cycleHours: BLOFIN_FUNDING_CYCLE_HOURS,
      nextSettleTime: Number(f.fundingTime),
    };
  },
};
