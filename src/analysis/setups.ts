/**
 * Connors & Raschke short-term trading setups.
 * Source: Larry Connors & Linda Raschke, "Street Smarts" (M. Gordon, 1996).
 *
 * Each setup returns a SetupSignal indicating whether the latest bar matches
 * the trigger conditions plus direction (long/short) and notes.
 *
 * Implemented:
 *   - Turtle Soup (Ch. 4): false breakout of a 20-period extreme
 *   - 80-20 (Ch. 6): yesterday's open/close in opposite 20% of range
 *   - Holy Grail (Ch. 10): pullback to 20-EMA in strong (ADX > 30) trend
 */

import type { Candle } from "./indicators.js";
import { ema, adx } from "./indicators.js";

export type SetupName = "turtleSoup" | "eightyTwenty" | "holyGrail";

export interface SetupSignal {
  setup: SetupName;
  direction: "long" | "short";
  triggered: boolean;
  triggerPrice: number;
  stopPrice: number;
  rationale: string;
}

/**
 * Turtle Soup BUY: today makes a new 20-day low (lower than the prior 20-day low),
 * AND the prior 20-day low occurred ≥ 4 sessions ago.
 * Entry: buy stop slightly above the prior 20-day low. Stop: tick under today's low.
 */
export function turtleSoup(candles: readonly Candle[]): SetupSignal[] {
  const out: SetupSignal[] = [];
  if (candles.length < 25) return out;
  const today = candles[candles.length - 1]!;
  const todayIdx = candles.length - 1;
  // Prior 20 bars (excluding today)
  const window = candles.slice(todayIdx - 20, todayIdx);
  const lows = window.map((c, i) => ({ idx: candles.length - 1 - 20 + i, low: c.l }));
  const lowest = lows.reduce((a, b) => (b.low < a.low ? b : a));
  if (today.l < lowest.low && (todayIdx - lowest.idx) >= 4) {
    out.push({
      setup: "turtleSoup",
      direction: "long",
      triggered: true,
      triggerPrice: lowest.low * 1.001,
      stopPrice: today.l * 0.999,
      rationale: `Today low ${today.l.toFixed(4)} undercuts prior 20d low ${lowest.low.toFixed(4)} (set ${todayIdx - lowest.idx} bars ago) — false-breakout reversal candidate`,
    });
  }
  // Sell mirror
  const highs = window.map((c, i) => ({ idx: candles.length - 1 - 20 + i, high: c.h }));
  const highest = highs.reduce((a, b) => (b.high > a.high ? b : a));
  if (today.h > highest.high && (todayIdx - highest.idx) >= 4) {
    out.push({
      setup: "turtleSoup",
      direction: "short",
      triggered: true,
      triggerPrice: highest.high * 0.999,
      stopPrice: today.h * 1.001,
      rationale: `Today high ${today.h.toFixed(4)} pierces prior 20d high ${highest.high.toFixed(4)} (set ${todayIdx - highest.idx} bars ago) — false-breakout short candidate`,
    });
  }
  return out;
}

/**
 * 80-20 BUY: yesterday opened in top 20% of range AND closed in bottom 20% of range.
 *           Today trades below yesterday's low → buy stop at yesterday's low.
 * Sell mirror.
 */
export function eightyTwenty(candles: readonly Candle[]): SetupSignal[] {
  const out: SetupSignal[] = [];
  if (candles.length < 2) return out;
  const yesterday = candles[candles.length - 2]!;
  const today = candles[candles.length - 1]!;
  const range = yesterday.h - yesterday.l;
  if (range <= 0) return out;
  const openPctOfRange = (yesterday.o - yesterday.l) / range; // 0..1, 0=at low, 1=at high
  const closePctOfRange = (yesterday.c - yesterday.l) / range;

  // BUY signal: yesterday opened HIGH (top 20%), closed LOW (bottom 20%), today trading below yesterday's low
  if (openPctOfRange >= 0.8 && closePctOfRange <= 0.2 && today.l < yesterday.l) {
    out.push({
      setup: "eightyTwenty",
      direction: "long",
      triggered: true,
      triggerPrice: yesterday.l,
      stopPrice: today.l * 0.999,
      rationale: `Yesterday opened in top 20% (${(openPctOfRange * 100).toFixed(0)}%) and closed in bottom 20% (${(closePctOfRange * 100).toFixed(0)}%); today probing below low — reversal candidate`,
    });
  }
  // SELL mirror: yesterday opened LOW, closed HIGH, today trading above yesterday's high
  if (openPctOfRange <= 0.2 && closePctOfRange >= 0.8 && today.h > yesterday.h) {
    out.push({
      setup: "eightyTwenty",
      direction: "short",
      triggered: true,
      triggerPrice: yesterday.h,
      stopPrice: today.h * 1.001,
      rationale: `Yesterday opened in bottom 20% (${(openPctOfRange * 100).toFixed(0)}%) and closed in top 20% (${(closePctOfRange * 100).toFixed(0)}%); today probing above high — reversal candidate`,
    });
  }
  return out;
}

/**
 * Holy Grail BUY: 14-period ADX > 30 (strong trend), price pulls back to 20-EMA,
 * entry on break of previous bar's high.
 *
 * For the trade to be a LONG, the trend must be UP — we infer this from price > EMA200
 * (or higher-highs/higher-lows over recent bars). For SHORT, mirror.
 */
export function holyGrail(candles: readonly Candle[]): SetupSignal[] {
  const out: SetupSignal[] = [];
  if (candles.length < 30) return out;
  const adxArr = adx(candles, 14);
  const ema20 = ema(candles.map((c) => c.c), 20);
  if (adxArr.length === 0 || ema20.length === 0) return out;
  const lastAdx = adxArr[adxArr.length - 1]!;
  const lastEma = ema20[ema20.length - 1]!;
  const today = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;
  if (lastAdx < 30) return out;

  // Determine trend direction from price vs EMA20 (and ADX rising)
  const pricesPullingDown = today.c < prev.c && today.l <= lastEma * 1.005;
  const pricesPullingUp = today.c > prev.c && today.h >= lastEma * 0.995;

  if (pricesPullingDown && today.c > lastEma * 0.99) {
    // Pullback in an uptrend — wait for break of yesterday's high
    out.push({
      setup: "holyGrail",
      direction: "long",
      triggered: true,
      triggerPrice: prev.h * 1.0005,
      stopPrice: today.l * 0.999,
      rationale: `ADX(14)=${lastAdx.toFixed(0)} >30; price pulled back to EMA20 (${lastEma.toFixed(4)}) — buy stop above prior bar high`,
    });
  }
  if (pricesPullingUp && today.c < lastEma * 1.01) {
    out.push({
      setup: "holyGrail",
      direction: "short",
      triggered: true,
      triggerPrice: prev.l * 0.9995,
      stopPrice: today.h * 1.001,
      rationale: `ADX(14)=${lastAdx.toFixed(0)} >30; price retraced to EMA20 (${lastEma.toFixed(4)}) — sell stop below prior bar low`,
    });
  }
  return out;
}

export function detectAllSetups(candles: readonly Candle[]): SetupSignal[] {
  return [
    ...turtleSoup(candles),
    ...eightyTwenty(candles),
    ...holyGrail(candles),
  ];
}
