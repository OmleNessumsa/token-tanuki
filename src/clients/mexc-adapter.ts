/**
 * MEXC futures adapter — wraps the existing mexc-futures.ts client behind the
 * ExchangeAdapter interface. Zero behavior change for existing call sites; the
 * adapter is purely additive until S2 swaps consumers over.
 */

import type {
  ExchangeAdapter,
  FundingInfo,
  Ticker,
  Timeframe,
} from "../exchange.js";
import {
  findCanonicalPerp,
  getFundingRate as mexcGetFundingRate,
  getFuturesKlines,
  getFuturesTicker,
  symbolExists as mexcSymbolExists,
  type FuturesInterval,
} from "./mexc-futures.js";

const TF_TO_MEXC: Record<Timeframe, FuturesInterval> = {
  "1m": "Min1",
  "5m": "Min5",
  "15m": "Min15",
  "30m": "Min30",
  "1h": "Min60",
  "4h": "Hour4",
  "8h": "Hour8",
  "1d": "Day1",
  "1w": "Week1",
};

export const mexcFuturesAdapter: ExchangeAdapter = {
  id: "mexc-futures",
  kind: "futures",
  supportsShort: true,
  supportsLeverage: true,

  async getKlines(symbol, tf, limit = 500) {
    return getFuturesKlines(symbol, TF_TO_MEXC[tf], limit);
  },

  async getTicker(symbol) {
    const t = await getFuturesTicker(symbol);
    if (!t) return null;
    const ticker: Ticker = {
      symbol: t.symbol,
      lastPrice: t.lastPrice,
      bid: t.bid1,
      ask: t.ask1,
      volume24Quote: t.amount24,
      high24: t.high24Price,
      low24: t.lower24Price,
      riseFallRate: t.riseFallRate,
      timestamp: t.timestamp,
      openInterest: t.holdVol,
      fundingRate: t.fundingRate,
      indexPrice: t.indexPrice,
      fairPrice: t.fairPrice,
    };
    return ticker;
  },

  symbolExists: mexcSymbolExists,

  findCanonicalSymbol: findCanonicalPerp,

  async getFundingRate(symbol): Promise<FundingInfo | null> {
    const f = await mexcGetFundingRate(symbol);
    if (!f) return null;
    return {
      symbol: f.symbol,
      ratePerCycle: f.fundingRate,
      cycleHours: f.collectCycle,
      nextSettleTime: f.nextSettleTime,
    };
  },
};
