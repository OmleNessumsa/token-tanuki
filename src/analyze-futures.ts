/**
 * Multi-timeframe analysis (Phase 2 of the pipeline).
 *
 * For 20× leveraged trading, single-timeframe analysis is dangerous:
 *   - Lower timeframes (5m / 15m) trigger entries
 *   - Higher timeframes (4h / 1d) define the regime ("am I trading WITH or AGAINST trend?")
 *   - Confluence across timeframes is what separates real setups from noise
 *
 * Exchange-agnostic via the ExchangeAdapter interface — pass a futures
 * adapter (MEXC) or a spot adapter (Coinbase). Funding-rate analysis is
 * automatically skipped on spot adapters; Stage 2 daily SMA-150 gate still
 * applies because it's price-derived.
 */

import { analyzeFundingRate, type FundingAnalysis } from "./clients/mexc-futures.js";
import { mexcFuturesAdapter } from "./clients/mexc-adapter.js";
import type { ExchangeAdapter, Ticker, Timeframe } from "./exchange.js";
import { scoreChart, type ChartScore } from "./analysis/chart.js";
import { getIntermarketContext, type IntermarketContext } from "./analysis/intermarket.js";
import { trendTemplate, type TrendTemplateResult } from "./analysis/trend-template.js";
import type { Candle } from "./analysis/indicators.js";

export type { Timeframe };

const TF_LIST: readonly Timeframe[] = ["5m", "15m", "1h", "4h", "1d"] as const;

const TF_LIMIT: Record<Timeframe, number> = {
  "1m":  500,
  "5m":  500,   // ~42 hours
  "15m": 500,   // ~5 days
  "30m": 500,
  "1h":  500,   // ~21 days
  "4h":  500,   // ~83 days
  "8h":  500,
  "1d":  500,   // ~16 months
  "1w":  100,
};

export interface TfAnalysis {
  timeframe: Timeframe;
  candles: Candle[];
  chart: ChartScore;
  direction: "bullish" | "bearish" | "neutral";
}

export interface FuturesAnalysis {
  asset: string;
  exchangeId: string;
  /** Resolved symbol on the chosen exchange (e.g. "BTC_USDT" on MEXC, "BTC-USDC" on Coinbase). */
  perpSymbol: string | null;
  ticker: Ticker | null;
  funding: FundingAnalysis | null;
  intermarket: IntermarketContext;
  trendTemplate: TrendTemplateResult | null;
  timeframes: TfAnalysis[];
  confluence: {
    htfDirection: "bullish" | "bearish" | "neutral";
    ltfDirection: "bullish" | "bearish" | "neutral";
    aligned: boolean;
    score: number;
    summary: string;
  };
  verdict: {
    side: "LONG" | "SHORT" | "FLAT";
    confidence: "high" | "medium" | "low";
    reasons: string[];
    caveats: string[];
  };
  naturalSide: "LONG" | "SHORT" | "FLAT";
  stage2: boolean | null;
}

function dirGlyph(d: "bullish" | "bearish" | "neutral"): string {
  return d === "bullish" ? "▲" : d === "bearish" ? "▼" : "=";
}

function chartDirection(chart: ChartScore): "bullish" | "bearish" | "neutral" {
  const rsi = chart.rsi ?? 50;
  if (chart.breakout?.state === "broken_out" && chart.breakout.volumeConfirmed) return "bullish";
  if (chart.breakout?.state === "below_breakdown" && chart.breakout.volumeConfirmed) return "bearish";
  if (chart.rsiDivergence === "bullish") return "bullish";
  if (chart.rsiDivergence === "bearish") return "bearish";
  if (chart.trend === "up" && rsi < 75) return "bullish";
  if (chart.trend === "up") return "neutral";
  if (chart.trend === "down" && rsi <= 32) return "bullish";
  if (chart.trend === "down") return "bearish";
  if (rsi < 35) return "bullish";
  if (rsi > 70) return "bearish";
  return "neutral";
}

function aggregateDirection(tfs: TfAnalysis[]): "bullish" | "bearish" | "neutral" {
  let bull = 0, bear = 0;
  for (const t of tfs) {
    if (t.direction === "bullish") bull++;
    else if (t.direction === "bearish") bear++;
  }
  if (bull > bear) return "bullish";
  if (bear > bull) return "bearish";
  return "neutral";
}

export async function analyzeFutures(
  asset: string,
  adapter: ExchangeAdapter = mexcFuturesAdapter,
): Promise<FuturesAnalysis> {
  const upper = asset.toUpperCase();
  const perpSymbol = await adapter.findCanonicalSymbol(upper);
  const intermarket = await getIntermarketContext();

  if (!perpSymbol) {
    return {
      asset: upper,
      exchangeId: adapter.id,
      perpSymbol: null,
      ticker: null,
      funding: null,
      intermarket,
      timeframes: [],
      trendTemplate: null,
      confluence: { htfDirection: "neutral", ltfDirection: "neutral", aligned: false, score: 0, summary: "no symbol listed" },
      verdict: { side: "FLAT", confidence: "low", reasons: [`${upper} not listed on ${adapter.id}`], caveats: [] },
      naturalSide: "FLAT",
      stage2: null,
    };
  }

  const fundingPromise = adapter.getFundingRate
    ? adapter.getFundingRate(perpSymbol)
    : Promise.resolve(null);
  const [klinesAll, ticker, fInfo] = await Promise.all([
    Promise.all(TF_LIST.map((tf) => adapter.getKlines(perpSymbol, tf, TF_LIMIT[tf]))),
    adapter.getTicker(perpSymbol),
    fundingPromise,
  ]);

  // Adapt to the FundingRateInfo shape that analyzeFundingRate expects.
  const funding = fInfo
    ? analyzeFundingRate({
        symbol: fInfo.symbol,
        fundingRate: fInfo.ratePerCycle,
        maxFundingRate: 0,
        minFundingRate: 0,
        collectCycle: fInfo.cycleHours,
        nextSettleTime: fInfo.nextSettleTime,
      })
    : null;

  const timeframes: TfAnalysis[] = TF_LIST.map((tf, i) => {
    const candles = klinesAll[i] ?? [];
    const chart = scoreChart(candles, candles);
    return { timeframe: tf, candles, chart, direction: chartDirection(chart) };
  });

  const dailyCandles = timeframes.find((t) => t.timeframe === "1d")?.candles ?? [];
  const tt = trendTemplate(dailyCandles);

  const htfTfs = timeframes.filter((t) => t.timeframe === "4h" || t.timeframe === "1d");
  const ltfTfs = timeframes.filter((t) => t.timeframe === "15m" || t.timeframe === "1h");
  const htfDirection = aggregateDirection(htfTfs);
  const ltfDirection = aggregateDirection(ltfTfs);
  const aligned = htfDirection !== "neutral" && htfDirection === ltfDirection;

  const weights = { "5m": 0.05, "15m": 0.15, "1h": 0.25, "4h": 0.30, "1d": 0.25 } as const;
  let composite = 0;
  let totalW = 0;
  for (const t of timeframes) {
    const w = weights[t.timeframe as keyof typeof weights] ?? 0;
    composite += t.chart.score * w;
    totalW += w;
  }
  composite = totalW > 0 ? composite / totalW : 0;

  if (funding && funding.longBiasScore !== 0) {
    composite += funding.longBiasScore * (htfDirection === "bullish" ? 0.5 : -0.3);
  }

  // Intermarket layer applies regardless of exchange, since BTC.D is global.
  const isBtc = perpSymbol === "BTC_USDT" || perpSymbol === "BTC_USD" || perpSymbol === "BTC-USDC" || perpSymbol === "BTC-USD";
  if (intermarket.regime === "btc_dump" && !isBtc) {
    composite *= 0.3;
  } else if (intermarket.regime === "altseason" && !isBtc) {
    composite *= 1.2;
  }

  if (tt.criteriaTotal > 0) {
    const ratio = tt.criteriaPassed / tt.criteriaTotal;
    if (htfDirection === "bullish") {
      if (ratio >= 6 / 7) composite += 5;
      else if (ratio < 4 / 7) composite -= 5;
    }
  }

  composite = Math.max(0, Math.min(100, Math.round(composite)));

  const reasons: string[] = [];
  const caveats: string[] = [];

  if (ticker) {
    const pct = ticker.riseFallRate * 100;
    const oiPart = ticker.openInterest !== undefined ? ` · OI ${ticker.openInterest.toLocaleString()} contracts` : "";
    reasons.push(`Symbol: ${perpSymbol} @ $${ticker.lastPrice.toFixed(4)} (24h ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)${oiPart}`);
  }
  reasons.push(`HTF (4h/1d): ${htfDirection} | LTF (15m/1h): ${ltfDirection} | aligned: ${aligned ? "YES" : "no"}`);
  reasons.push(`Per-TF: ${timeframes.map((t) => `${t.timeframe}=${dirGlyph(t.direction)}${Math.round(t.chart.score)}`).join(" ")}`);
  if (funding) reasons.push(`Funding: ${funding.description}`);
  if (intermarket.regime !== "neutral" && intermarket.regime !== "unknown") reasons.push(`Intermarket: ${intermarket.description}`);

  let side: "LONG" | "SHORT" | "FLAT";
  let confidence: "high" | "medium" | "low";

  if (aligned && htfDirection === "bullish") {
    side = "LONG";
    confidence = composite >= 65 ? "high" : composite >= 50 ? "medium" : "low";
  } else if (aligned && htfDirection === "bearish") {
    side = "SHORT";
    confidence = composite >= 65 ? "high" : composite >= 50 ? "medium" : "low";
  } else if (htfDirection === "bullish" && ltfDirection !== "bearish") {
    side = "LONG";
    confidence = "low";
    caveats.push("LTF not yet confirming HTF — entry against weak agreement");
  } else if (htfDirection === "bearish" && ltfDirection !== "bullish") {
    side = "SHORT";
    confidence = "low";
    caveats.push("LTF not yet confirming HTF — entry against weak agreement");
  } else {
    side = "FLAT";
    confidence = "low";
    reasons.push("No clear directional alignment — wait for HTF to commit");
  }

  if (funding && funding.regime === "euphoria" && side === "LONG") {
    caveats.push("Euphoric funding — consider waiting for cooldown or reducing size");
  }
  if (funding && funding.regime === "paid_to_long" && side === "SHORT") {
    caveats.push("Shorts already crowded (paid to long) — squeeze risk");
  }

  // Spot adapters can't short — demote any SHORT verdict to FLAT and surface why.
  if (side === "SHORT" && !adapter.supportsShort) {
    side = "FLAT";
    confidence = "low";
    caveats.push(`${adapter.id} does not support short — SHORT signal suppressed`);
  }

  if (side === "LONG" && tt.criteriaTotal > 0) {
    const ratio = tt.criteriaPassed / tt.criteriaTotal;
    if (ratio < 4 / 7) {
      caveats.push(`Minervini SEPA only ${tt.criteriaPassed}/${tt.criteriaTotal} criteria — NOT in Stage 2 (counter-trend long)`);
    } else if (ratio >= 6 / 7) {
      reasons.push(`Minervini SEPA ${tt.criteriaPassed}/${tt.criteriaTotal} ✓ — confirmed Stage 2 uptrend`);
    }
  }

  const dailyTf = timeframes.find((t) => t.timeframe === "1d");
  const stage2 = dailyTf?.chart.stage2 ?? null;
  const naturalSide: "LONG" | "SHORT" | "FLAT" = side;
  if (side === "LONG" && stage2 === false) {
    side = "FLAT";
    confidence = "low";
    reasons.push("Stage 2 gate FAILED — daily close ≤ 150d SMA. LONG suppressed (backtest-validated).");
  } else if (side === "LONG" && stage2 === true) {
    reasons.push("Stage 2 confirmed — daily close > 150d SMA");
  }

  return {
    asset: upper,
    exchangeId: adapter.id,
    perpSymbol,
    ticker,
    funding,
    intermarket,
    trendTemplate: tt,
    timeframes,
    confluence: { htfDirection, ltfDirection, aligned, score: composite, summary: `${aligned ? "ALIGNED" : "MIXED"} | composite ${composite}/100` },
    verdict: { side, confidence, reasons, caveats },
    naturalSide,
    stage2,
  };
}
