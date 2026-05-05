/**
 * Triple-barrier labeling + purged k-fold cross-validation.
 * Source: Marcos López de Prado, "Advances in Financial Machine Learning" (Wiley 2018).
 *
 * Why:
 *   - Standard fixed-horizon labels (e.g. "what is the return 5 bars from now?") leak
 *     information across train/test splits and produce path-independent labels.
 *   - Triple-barrier labels are PATH-DEPENDENT: they label each event by which of three
 *     barriers price hits FIRST — upper (+pt × volatility), lower (−sl × volatility), or
 *     vertical (timeout). This matches how a real trader exits.
 *   - Purged k-fold removes train samples whose target horizon overlaps the test window —
 *     prevents leakage that inflates backtest results.
 */

import type { Candle } from "./indicators.js";

export type Label = -1 | 0 | 1;

export interface BarrierEvent {
  /** Index in the candles array where the trade is initiated. */
  startIndex: number;
  /** Index where the trade was exited (one of the three barriers hit). */
  exitIndex: number;
  /** Which barrier was hit. */
  barrier: "upper" | "lower" | "vertical";
  /** Realized return at exit, fraction (e.g. +0.05 = +5%). */
  returnPct: number;
  /** Discrete label: +1 upper, -1 lower, 0 vertical (timeout neutral). */
  label: Label;
}

export interface BarrierConfig {
  /** Profit-take multiple of volatility. Typical: 2 (target = 2σ). */
  upperMult: number;
  /** Stop-loss multiple of volatility. Typical: 2. */
  lowerMult: number;
  /** Vertical-barrier horizon in bars. Typical: 5..50. */
  horizon: number;
  /** Per-bar volatility used to size the barriers; if omitted, computed from rolling stdev. */
  volatility?: number[];
  volWindow?: number;
}

const stdev = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
};

/** Rolling stdev of log returns, in fractional terms. */
export function rollingVolatility(candles: readonly Candle[], window = 20): number[] {
  if (candles.length < 2) return [];
  const logRets: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1]!.c;
    const b = candles[i]!.c;
    logRets.push(a > 0 && b > 0 ? Math.log(b / a) : 0);
  }
  const out: number[] = [];
  for (let i = 0; i < logRets.length; i++) {
    const start = Math.max(0, i - window + 1);
    out.push(stdev(logRets.slice(start, i + 1)));
  }
  // Align: candles[0] has no prior return → prepend 0
  return [0, ...out];
}

/**
 * Label each starting bar with its triple-barrier outcome.
 * Returns one event per startIndex (skips bars too close to end for full horizon).
 */
export function tripleBarrierLabel(
  candles: readonly Candle[],
  config: BarrierConfig,
): BarrierEvent[] {
  const vol = config.volatility ?? rollingVolatility(candles, config.volWindow ?? 20);
  const events: BarrierEvent[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i + config.horizon >= candles.length) break;
    const entry = candles[i]!.c;
    const sigma = vol[i] ?? 0;
    if (sigma <= 0) continue;
    const upper = entry * (1 + config.upperMult * sigma);
    const lower = entry * (1 - config.lowerMult * sigma);
    let exitIdx = i + config.horizon;
    let barrier: BarrierEvent["barrier"] = "vertical";
    for (let j = i + 1; j <= i + config.horizon; j++) {
      const c = candles[j]!;
      if (c.h >= upper) {
        exitIdx = j; barrier = "upper"; break;
      }
      if (c.l <= lower) {
        exitIdx = j; barrier = "lower"; break;
      }
    }
    const exitPrice = barrier === "upper" ? upper
      : barrier === "lower" ? lower
      : candles[exitIdx]!.c;
    const ret = (exitPrice - entry) / entry;
    const label: Label = barrier === "upper" ? 1 : barrier === "lower" ? -1 : 0;
    events.push({ startIndex: i, exitIndex: exitIdx, barrier, returnPct: ret, label });
  }
  return events;
}

/**
 * Purged k-fold cross-validation index splits.
 * Each test fold has a contiguous range; the training set excludes:
 *   (a) all samples in the test range
 *   (b) the "purge" buffer of samples whose label horizon overlaps the test range
 *
 * López de Prado, ch. 7.
 */
export interface KFoldSplit {
  trainIndices: number[];
  testIndices: number[];
}

export function purgedKFold(events: readonly BarrierEvent[], k = 5, purgeBars = 0): KFoldSplit[] {
  const n = events.length;
  if (n === 0 || k <= 1) return [];
  const splits: KFoldSplit[] = [];
  const foldSize = Math.floor(n / k);
  for (let f = 0; f < k; f++) {
    const testStart = f * foldSize;
    const testEnd = f === k - 1 ? n : testStart + foldSize;
    const testIndices: number[] = [];
    for (let i = testStart; i < testEnd; i++) testIndices.push(i);
    // Purge buffer: any sample whose horizon overlaps the test window
    const trainIndices: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i >= testStart && i < testEnd) continue; // in test
      const ev = events[i]!;
      // Sample's exit covers indices [ev.startIndex, ev.exitIndex]
      // If those indices overlap [testStart - purge, testEnd + purge], skip
      const evStartIdx = ev.startIndex;
      const evExitIdx = ev.exitIndex;
      const overlaps = evExitIdx >= testStart - purgeBars && evStartIdx <= testEnd + purgeBars - 1;
      if (overlaps) continue;
      trainIndices.push(i);
    }
    splits.push({ trainIndices, testIndices });
  }
  return splits;
}

/**
 * Class-balance summary — useful first sanity check after labeling a dataset.
 */
export function labelDistribution(events: readonly BarrierEvent[]): Record<Label, number> {
  const out: Record<Label, number> = { 1: 0, 0: 0, [-1]: 0 };
  for (const e of events) out[e.label]++;
  return out;
}
