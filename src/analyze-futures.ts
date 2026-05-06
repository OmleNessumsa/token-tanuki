/**
 * Multi-timeframe futures analysis (Phase 2 of futures pipeline).
 *
 * For 20× leveraged trading, single-timeframe analysis is dangerous:
 *   - Lower timeframes (5m / 15m) trigger entries
 *   - Higher timeframes (4h / 1d) define the regime ("am I trading WITH or AGAINST trend?")
 *   - Confluence across timeframes is what separates real setups from noise
 *
 * This module fetches MEXC perp data across 5 timeframes, runs scoreChart() on each,
 * and computes a confluence verdict. Plus integrates funding-rate context.
 */

import {
  findCanonicalPerp,
  getFuturesKlines,
  getFuturesTicker,
  getFundingRate,
  analyzeFundingRate,
  type FundingAnalysis,
  type FuturesTicker,
  type FuturesInterval,
} from "./clients/mexc-futures.js";
import { scoreChart, type ChartScore } from "./analysis/chart.js";
import { getIntermarketContext, type IntermarketContext } from "./analysis/intermarket.js";
import { trendTemplate, type TrendTemplateResult } from "./analysis/trend-template.js";
import type { Candle } from "./analysis/indicators.js";

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";

const TF_TO_MEXC: Record<Timeframe, FuturesInterval> = {
  "5m":  "Min5",
  "15m": "Min15",
  "1h":  "Min60",
  "4h":  "Hour4",
  "1d":  "Day1",
};

const TF_LIMIT: Record<Timeframe, number> = {
  "5m":  500,   // ~42 hours
  "15m": 500,   // ~5 days
  "1h":  500,   // ~21 days
  "4h":  500,   // ~83 days
  "1d":  500,   // ~16 months
};

export interface TfAnalysis {
  timeframe: Timeframe;
  candles: Candle[];
  chart: ChartScore;
  /** Convenient direction summary: "bullish" | "bearish" | "neutral". */
  direction: "bullish" | "bearish" | "neutral";
}

export interface FuturesAnalysis {
  asset: string;
  perpSymbol: string | null;
  ticker: FuturesTicker | null;
  funding: FundingAnalysis | null;
  intermarket: IntermarketContext;
  trendTemplate: TrendTemplateResult | null;  // Minervini SEPA — Stage 2 check on daily candles
  timeframes: TfAnalysis[];
  /** "with-trend" if HTF (4h+1d) and LTF (15m+1h) agree on direction. */
  confluence: {
    htfDirection: "bullish" | "bearish" | "neutral";
    ltfDirection: "bullish" | "bearish" | "neutral";
    aligned: boolean;
    score: number;        // 0..100 — composite quality of setup
    summary: string;
  };
  verdict: {
    side: "LONG" | "SHORT" | "FLAT";
    confidence: "high" | "medium" | "low";
    reasons: string[];
    caveats: string[];
  };
}

/**
 * Read a single chart's directional bias.
 * Same logic as the established-asset path in analysis/verdict.ts but exposed standalone here.
 */
/** Single-char glyph for compact MTF lines. ▲ bull · ▼ bear · = neutral. */
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

/**
 * Aggregate direction across multiple timeframes.
 * Counts bullish vs bearish; majority wins, ties → neutral.
 */
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

export async function analyzeFutures(asset: string): Promise<FuturesAnalysis> {
  const upper = asset.toUpperCase();
  const perpSymbol = await findCanonicalPerp(upper);
  const intermarket = await getIntermarketContext();

  if (!perpSymbol) {
    return {
      asset: upper,
      perpSymbol: null,
      ticker: null,
      funding: null,
      intermarket,
      timeframes: [],
      trendTemplate: null,
      confluence: { htfDirection: "neutral", ltfDirection: "neutral", aligned: false, score: 0, summary: "no perp listed" },
      verdict: { side: "FLAT", confidence: "low", reasons: [`${upper} has no MEXC futures listing`], caveats: [] },
    };
  }

  // Fetch all timeframes in parallel + ticker + funding
  const tfList: Timeframe[] = ["5m", "15m", "1h", "4h", "1d"];
  const [klinesAll, ticker, fundInfo] = await Promise.all([
    Promise.all(tfList.map((tf) => getFuturesKlines(perpSymbol, TF_TO_MEXC[tf], TF_LIMIT[tf]))),
    getFuturesTicker(perpSymbol),
    getFundingRate(perpSymbol),
  ]);

  const funding = fundInfo ? analyzeFundingRate(fundInfo) : null;

  const timeframes: TfAnalysis[] = tfList.map((tf, i) => {
    const candles = klinesAll[i] ?? [];
    // For multi-bar pattern detection scoreChart needs daily-ish series; pass current as both args
    const chart = scoreChart(candles, candles);
    return { timeframe: tf, candles, chart, direction: chartDirection(chart) };
  });

  // Minervini SEPA — run trend template on daily candles
  // Source: Minervini, "Trade Like a Stock Market Wizard" (2013)
  const dailyCandles = timeframes.find((t) => t.timeframe === "1d")?.candles ?? [];
  const tt = trendTemplate(dailyCandles);

  const htfTfs = timeframes.filter((t) => t.timeframe === "4h" || t.timeframe === "1d");
  const ltfTfs = timeframes.filter((t) => t.timeframe === "15m" || t.timeframe === "1h");
  const htfDirection = aggregateDirection(htfTfs);
  const ltfDirection = aggregateDirection(ltfTfs);
  const aligned = htfDirection !== "neutral" && htfDirection === ltfDirection;

  // Compose composite score: weighted average of TF chart scores, biased toward higher TF
  const weights = { "5m": 0.05, "15m": 0.15, "1h": 0.25, "4h": 0.30, "1d": 0.25 };
  let composite = 0;
  let totalW = 0;
  for (const t of timeframes) {
    const w = weights[t.timeframe];
    composite += t.chart.score * w;
    totalW += w;
  }
  composite = totalW > 0 ? composite / totalW : 0;

  // Apply funding-rate bias to composite (modulates the long/short outlook)
  if (funding && funding.longBiasScore !== 0) {
    composite += funding.longBiasScore * (htfDirection === "bullish" ? 0.5 : -0.3);
  }

  // Apply intermarket layer: BTC dump → close all longs
  if (intermarket.regime === "btc_dump" && perpSymbol !== "BTC_USDT" && perpSymbol !== "BTC_USD") {
    composite *= 0.3;
  } else if (intermarket.regime === "altseason" && perpSymbol !== "BTC_USDT") {
    composite *= 1.2;
  }

  // Minervini SEPA: if 6+/7 criteria pass → +5 (high-conviction "Stage 2"); 4-5 → 0; <4 → -5 for longs
  if (tt.criteriaTotal > 0) {
    const ratio = tt.criteriaPassed / tt.criteriaTotal;
    if (htfDirection === "bullish") {
      if (ratio >= 6 / 7) composite += 5;
      else if (ratio < 4 / 7) composite -= 5;
    }
  }

  composite = Math.max(0, Math.min(100, Math.round(composite)));

  // Verdict
  const reasons: string[] = [];
  const caveats: string[] = [];

  reasons.push(`Perp: ${perpSymbol} @ $${ticker?.lastPrice.toFixed(4)} (24h ${(ticker?.riseFallRate ?? 0) >= 0 ? "+" : ""}${((ticker?.riseFallRate ?? 0) * 100).toFixed(2)}%)`);
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

  // Strong funding warnings
  if (funding && funding.regime === "euphoria" && side === "LONG") {
    caveats.push("Euphoric funding — consider waiting for cooldown or reducing size");
  }
  if (funding && funding.regime === "paid_to_long" && side === "SHORT") {
    caveats.push("Shorts already crowded (paid to long) — squeeze risk");
  }

  // Minervini Stage warning for LONGs
  if (side === "LONG" && tt.criteriaTotal > 0) {
    const ratio = tt.criteriaPassed / tt.criteriaTotal;
    if (ratio < 4 / 7) {
      caveats.push(`Minervini SEPA only ${tt.criteriaPassed}/${tt.criteriaTotal} criteria — NOT in Stage 2 (counter-trend long)`);
    } else if (ratio >= 6 / 7) {
      reasons.push(`Minervini SEPA ${tt.criteriaPassed}/${tt.criteriaTotal} ✓ — confirmed Stage 2 uptrend`);
    }
  }

  return {
    asset: upper,
    perpSymbol,
    ticker,
    funding,
    intermarket,
    trendTemplate: tt,
    timeframes,
    confluence: { htfDirection, ltfDirection, aligned, score: composite, summary: `${aligned ? "ALIGNED" : "MIXED"} | composite ${composite}/100` },
    verdict: { side, confidence, reasons, caveats },
  };
}
