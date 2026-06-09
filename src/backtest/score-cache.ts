/**
 * Per-(symbol, bar) cache of `scoreChart` output for the backtest harness v2.
 *
 * This is the single highest-leverage optimization in the harness — without
 * it, the 96-config × 4-fold × 30-symbol × ~52k-bar sweep won't finish in 4
 * hours (PRD §10 Q2, ARCHITECTURE §score-cache.ts).
 *
 * `scoreChart`'s output depends only on `candles[0..i]` — NOT on any
 * `BacktestConfig` field. So a per-bar score computed once per (symbol,
 * fold-window) is reusable across every grid cell. ~96× speedup.
 *
 * PURE module — no I/O, no clocks, no randomness.
 */

import type { Candle } from "../analysis/indicators.js";
import { sma } from "../analysis/indicators.js";
import { scoreChart } from "../analysis/chart.js";

export interface ScoreSnapshot {
  /** Composite score from scoreChart at this bar (uses only candles[0..i]). */
  score: number;
  trend: "up" | "down" | "flat";
  hasBreakout: boolean;
  /** close > SMA(stage2SmaPeriod) — precomputed once for both LONG/SHORT stage2 gating. */
  closeAboveStage2Sma: boolean;
}

/**
 * Dense array of snapshots indexed by bar position. Indices < warmupBars
 * (and any index where stage-2 SMA is not yet defined) are `null`. The array
 * length equals `candles.length`.
 */
export type ScoreSeries = ReadonlyArray<ScoreSnapshot | null>;

/**
 * Walk `candles` from bar 0 to last, computing
 * `scoreChart(candles.slice(0, i+1), candles.slice(0, i+1))` for every
 * `i >= warmupBars`.
 *
 * Replicates the EXACT no-look-ahead contract from
 * `src/analysis/backtest.ts:scoreAtBar`: the slice passed to `scoreChart` is
 * always the prefix up to and including bar `i`. Any future bar is invisible.
 *
 * INVARIANT: the output is independent of every `BacktestConfig` field
 * (thresholdComposite, stopAtrMult, horizonBars, cooldownBars, side,
 * requireBreakout, requireStage2). That's what makes the cache shareable
 * across all grid cells for one symbol+fold.
 *
 * @param candles  Oldest-first candle series for one symbol+fold window
 *                 (warmup bars already prepended by the caller).
 * @param warmupBars  First eligible bar index; everything below returns null.
 * @param stage2SmaPeriod  SMA period for the `closeAboveStage2Sma` field
 *                         (typically 150).
 */
export function precomputeScores(
  candles: readonly Candle[],
  warmupBars: number,
  stage2SmaPeriod: number,
): ScoreSeries {
  const out: Array<ScoreSnapshot | null> = new Array(candles.length).fill(null);
  if (candles.length === 0) return out;

  // Precompute SMA once over the full closes vector — sma() returns a series
  // whose index 0 corresponds to candle index (stage2SmaPeriod - 1).
  const closes = candles.map((c) => c.c);
  const smaSeries = sma(closes, stage2SmaPeriod);

  for (let i = warmupBars; i < candles.length; i++) {
    // Look-ahead boundary: slice is [0..i] inclusive, NEVER beyond.
    const slice = candles.slice(0, i + 1);
    const result = scoreChart(slice, slice);

    let closeAboveStage2Sma = false;
    const smaIdx = i - (stage2SmaPeriod - 1);
    if (smaIdx >= 0) {
      const smaValue = smaSeries[smaIdx];
      if (smaValue !== undefined) {
        closeAboveStage2Sma = candles[i]!.c > smaValue;
      }
    }

    out[i] = {
      score: result.score,
      trend: result.trend,
      hasBreakout: result.breakout !== null,
      closeAboveStage2Sma,
    };
  }
  return out;
}

/**
 * Cheap O(1) lookup. Returns `null` for warmup bars, out-of-range indices,
 * or any bar the cache did not populate.
 */
export function getScoreAt(series: ScoreSeries, barIndex: number): ScoreSnapshot | null {
  if (barIndex < 0 || barIndex >= series.length) return null;
  return series[barIndex] ?? null;
}
