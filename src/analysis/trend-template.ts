/**
 * Minervini SEPA Trend Template + Volatility Contraction Pattern (VCP).
 * Source: Mark Minervini, "Trade Like a Stock Market Wizard" (McGraw-Hill, 2013).
 *
 * The Trend Template is 8 numeric criteria that must ALL be true for a stock
 * to be considered in a confirmed Stage-2 uptrend. Minervini won't go long
 * any stock that fails the template.
 *
 * Criterion 8 (IBD Relative Strength rank ≥ 70) requires market-relative data
 * we don't have for a single token. We expose it as `relativeStrengthOk?` —
 * caller can supply it (e.g., from a BTC.D / token-vs-market comparison).
 */

import type { Candle } from "./indicators.js";
import { sma } from "./indicators.js";

export interface TrendTemplateResult {
  passed: boolean;
  criteriaPassed: number;       // 0..8 (or 0..7 if relativeStrengthOk omitted)
  criteriaTotal: number;
  details: Array<{ criterion: string; pass: boolean; reason: string }>;
}

export interface TrendTemplateOpts {
  /**
   * Optional: result of an IBD-style relative-strength rank check (true if RS ≥ 70).
   * Pass undefined to skip criterion 8.
   */
  relativeStrengthOk?: boolean;
}

export function trendTemplate(candles: readonly Candle[], opts: TrendTemplateOpts = {}): TrendTemplateResult {
  const details: TrendTemplateResult["details"] = [];

  if (candles.length < 200) {
    return {
      passed: false,
      criteriaPassed: 0,
      criteriaTotal: opts.relativeStrengthOk === undefined ? 7 : 8,
      details: [{ criterion: "Sufficient data", pass: false, reason: `need ≥200 bars, have ${candles.length}` }],
    };
  }

  const closes = candles.map((c) => c.c);
  const ma50 = sma(closes, 50);
  const ma150 = sma(closes, 150);
  const ma200 = sma(closes, 200);
  const last = closes[closes.length - 1]!;
  const lastMa50 = ma50[ma50.length - 1]!;
  const lastMa150 = ma150[ma150.length - 1]!;
  const lastMa200 = ma200[ma200.length - 1]!;

  // 1. Price > MA150 AND price > MA200
  const c1 = last > lastMa150 && last > lastMa200;
  details.push({
    criterion: "1. Price above 150d AND 200d MA",
    pass: c1,
    reason: `price ${last.toFixed(4)} vs MA150 ${lastMa150.toFixed(4)}, MA200 ${lastMa200.toFixed(4)}`,
  });

  // 2. MA150 > MA200
  const c2 = lastMa150 > lastMa200;
  details.push({
    criterion: "2. MA150 above MA200",
    pass: c2,
    reason: `MA150 ${lastMa150.toFixed(4)}, MA200 ${lastMa200.toFixed(4)}`,
  });

  // 3. MA200 trending up for ≥ 1 month (preferably 4-5 months)
  // Approximation: current MA200 > MA200 from ~22 bars ago.
  let c3 = false;
  let c3Reason = "insufficient MA200 history";
  if (ma200.length > 22) {
    const ma200Earlier = ma200[ma200.length - 23]!;
    c3 = lastMa200 > ma200Earlier;
    c3Reason = `MA200 now ${lastMa200.toFixed(4)} vs 22 bars ago ${ma200Earlier.toFixed(4)}`;
  }
  details.push({ criterion: "3. MA200 trending up ≥ 1 month", pass: c3, reason: c3Reason });

  // 4. MA50 above both MA150 and MA200
  const c4 = lastMa50 > lastMa150 && lastMa50 > lastMa200;
  details.push({
    criterion: "4. MA50 above MA150 AND MA200",
    pass: c4,
    reason: `MA50 ${lastMa50.toFixed(4)}, MA150 ${lastMa150.toFixed(4)}, MA200 ${lastMa200.toFixed(4)}`,
  });

  // 5. Price above MA50
  const c5 = last > lastMa50;
  details.push({ criterion: "5. Price above 50d MA", pass: c5, reason: `${last.toFixed(4)} vs ${lastMa50.toFixed(4)}` });

  // 6. Price ≥ 30% above 52-week low
  const yearWindow = closes.slice(-Math.min(252, closes.length));
  const yearLow = Math.min(...yearWindow);
  const yearHigh = Math.max(...yearWindow);
  const aboveLow = (last - yearLow) / yearLow * 100;
  const c6 = aboveLow >= 30;
  details.push({ criterion: "6. ≥30% above 52w low", pass: c6, reason: `${aboveLow.toFixed(0)}% above low ${yearLow.toFixed(4)}` });

  // 7. Price within 25% of 52-week high
  const distHigh = (yearHigh - last) / yearHigh * 100;
  const c7 = distHigh <= 25;
  details.push({ criterion: "7. Within 25% of 52w high", pass: c7, reason: `${distHigh.toFixed(0)}% below high ${yearHigh.toFixed(4)}` });

  let total = 7;
  let passed = c1 && c2 && c3 && c4 && c5 && c6 && c7;
  let count = [c1, c2, c3, c4, c5, c6, c7].filter(Boolean).length;
  if (opts.relativeStrengthOk !== undefined) {
    total = 8;
    details.push({
      criterion: "8. RS rank ≥ 70 (vs market)",
      pass: opts.relativeStrengthOk,
      reason: opts.relativeStrengthOk ? "relative strength confirmed" : "RS below 70",
    });
    passed = passed && opts.relativeStrengthOk;
    if (opts.relativeStrengthOk) count++;
  }

  return { passed, criteriaPassed: count, criteriaTotal: total, details };
}

/**
 * Volatility Contraction Pattern (VCP).
 * A stock builds a base of progressively tighter pullbacks, each pullback
 * shallower than the previous. Minervini: 3-5 contractions of decreasing
 * depth (e.g., 25% → 15% → 8%) preceding a breakout.
 */
export interface VcpResult {
  detected: boolean;
  contractionCount: number;
  contractionDepths: number[];   // % each, in order
  baseStartIndex: number | null;
  pivotPrice: number | null;     // breakout level (typically the latest local high)
  description: string;
}

export function detectVCP(candles: readonly Candle[], minContractions = 2): VcpResult {
  if (candles.length < 30) {
    return { detected: false, contractionCount: 0, contractionDepths: [], baseStartIndex: null, pivotPrice: null, description: "insufficient data" };
  }
  const window = Math.min(80, candles.length);
  const slice = candles.slice(-window);
  const offset = candles.length - window;

  // Find swing highs and lows in the recent window with a small lookback so we
  // catch the base structure rather than only the macro highs.
  const lookback = 2;
  const swings: Array<{ index: number; price: number; kind: "high" | "low" }> = [];
  for (let i = lookback; i < slice.length - lookback; i++) {
    const c = slice[i]!;
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (slice[i - j]!.h >= c.h || slice[i + j]!.h >= c.h) isHigh = false;
      if (slice[i - j]!.l <= c.l || slice[i + j]!.l <= c.l) isLow = false;
    }
    if (isHigh) swings.push({ index: i + offset, price: c.h, kind: "high" });
    else if (isLow) swings.push({ index: i + offset, price: c.l, kind: "low" });
  }

  // Walk pairs (high → next low) to compute contraction depths
  const depths: number[] = [];
  let lastHigh: { index: number; price: number } | null = null;
  for (const s of swings) {
    if (s.kind === "high") {
      lastHigh = s;
    } else if (lastHigh) {
      const drop = (lastHigh.price - s.price) / lastHigh.price * 100;
      if (drop > 0.5) depths.push(drop);
      lastHigh = null;
    }
  }

  // Check: depths sequence is monotonically decreasing
  let decreasing = true;
  for (let i = 1; i < depths.length; i++) {
    if (depths[i]! >= depths[i - 1]!) { decreasing = false; break; }
  }

  const detected = depths.length >= minContractions && decreasing && depths[depths.length - 1]! < 15;
  const lastSwingHigh = [...swings].reverse().find((s) => s.kind === "high") ?? null;

  return {
    detected,
    contractionCount: depths.length,
    contractionDepths: depths,
    baseStartIndex: swings.length > 0 ? swings[0]!.index : null,
    pivotPrice: lastSwingHigh ? lastSwingHigh.price : null,
    description: detected
      ? `VCP base: ${depths.length} contractions (${depths.map((d) => d.toFixed(1) + "%").join(" → ")}). Pivot ${lastSwingHigh?.price.toFixed(4)}.`
      : `No VCP. ${depths.length} contractions found, depths ${depths.map((d) => d.toFixed(1) + "%").join("/")}.`,
  };
}
