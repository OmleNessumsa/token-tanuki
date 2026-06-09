/**
 * Bar-by-bar backtest harness.
 * Source concept: David Aronson, "Evidence-Based Technical Analysis" (Wiley, 2006).
 *
 * For each historical bar, simulates what scoreChart would have produced using
 * ONLY data available up to that bar (no look-ahead). Then walks forward to
 * compute realized return at horizon, with stop-loss honored.
 *
 * Then: block-shuffle the candle series and re-run, building a null distribution
 * → compute p-value.
 */

import type { Candle } from "./indicators.js";
import { atr, sma } from "./indicators.js";
import { scoreChart } from "./chart.js";
import { blockShuffle, mulberry32 } from "./validation.js";

export interface BacktestTrade {
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  /** R = realized P/L / initial risk (in price units, then ratio) */
  rMultiple: number;
  exitReason: "stop" | "horizon";
  composite: number;
  side: "LONG" | "SHORT";
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  expectancy: number;       // R per trade
  totalR: number;
  rDistribution: number[];
  maxDrawdownR: number;
}

export interface BacktestConfig {
  /** Minimum chart score to enter a trade. */
  thresholdComposite: number;
  /** How many bars to hold before time-based exit. */
  horizonBars: number;
  /** Stop = 2 * ATR(14) below entry by default. */
  stopAtrMult: number;
  /** Bar index to start sampling (need lookback for indicators). */
  warmupBars: number;
  /** Optional: minimum bars between entries on same instrument. */
  cooldownBars: number;
  /** If true, only fire when scoreChart's Donchian breakout signal is present. */
  requireBreakout?: boolean;
  /** If true, only fire when close > SMA(stage2SmaPeriod) (Weinstein/Minervini Stage 2 trend). */
  requireStage2?: boolean;
  /** SMA period for Stage 2 filter. 150 daily bars ≈ 30 weeks. */
  stage2SmaPeriod?: number;
  /** Direction filter. Defaults to "LONG" to preserve legacy behavior. */
  side?: "LONG" | "SHORT";
}

const DEFAULT_CONFIG: BacktestConfig = {
  thresholdComposite: 75,
  horizonBars: 7,
  stopAtrMult: 2,
  warmupBars: 200,
  cooldownBars: 5,
  requireBreakout: false,
  requireStage2: false,
  stage2SmaPeriod: 150,
};

/**
 * Simulate the daily-chart-score at a specific bar index using only candles[0..i].
 * Returns the same shape scoreChart returns for the slice.
 */
function scoreAtBar(candles: readonly Candle[], i: number): { score: number; trend: "up" | "down" | "flat"; hasBreakout: boolean } {
  const slice = candles.slice(0, i + 1);
  const result = scoreChart(slice, slice);
  return { score: result.score, trend: result.trend, hasBreakout: result.breakout !== null };
}

/**
 * Run the strategy on a single perp's candle series.
 * Returns trades that fired + their realized R.
 */
export function runStrategyOnSeries(
  candles: readonly Candle[],
  config: BacktestConfig = DEFAULT_CONFIG,
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  if (candles.length <= config.warmupBars + config.horizonBars) return trades;

  const atrSeries = atr(candles, 14);
  const stage2Period = config.stage2SmaPeriod ?? 150;
  const closes = candles.map((c) => c.c);
  const smaSeries = config.requireStage2 ? sma(closes, stage2Period) : null;
  const side: "LONG" | "SHORT" = config.side ?? "LONG";
  const isShort = side === "SHORT";
  let lastEntryIdx = -Infinity;

  for (let i = config.warmupBars; i < candles.length - config.horizonBars; i++) {
    if (i - lastEntryIdx < config.cooldownBars) continue;

    const score = scoreAtBar(candles, i);
    if (score.score < config.thresholdComposite) continue;
    if (isShort) {
      // SHORT: directional gate inverted — require down trend.
      if (score.trend !== "down") continue;
    } else {
      // LONG: existing behavior — reject clear downtrend.
      if (score.trend === "down") continue;
    }
    if (config.requireBreakout && !score.hasBreakout) continue;
    if (smaSeries) {
      const smaIdx = i - (stage2Period - 1);
      const smaValue = smaIdx >= 0 ? smaSeries[smaIdx] : undefined;
      if (smaValue === undefined) continue;
      if (isShort) {
        // SHORT stage-2 = close BELOW SMA (downtrend regime, Stage 4 in Weinstein terms).
        if (candles[i]!.c >= smaValue) continue;
      } else {
        if (candles[i]!.c <= smaValue) continue;
      }
    }

    const entryPrice = candles[i]!.c;
    const atrIdx = i - 1; // ATR series starts at index 14, so atrSeries[i - 14] for bar i
    const atrValue = atrSeries[Math.max(0, atrIdx - 14)] ?? 0;
    if (atrValue <= 0) continue;
    const stopPrice = isShort
      ? entryPrice + config.stopAtrMult * atrValue
      : entryPrice - config.stopAtrMult * atrValue;
    if (stopPrice <= 0) continue;

    // Walk forward: hit stop → exit at stop. Else exit at horizon close.
    let exitIdx = i + config.horizonBars;
    let exitPrice = candles[exitIdx]!.c;
    let exitReason: "stop" | "horizon" = "horizon";

    for (let j = i + 1; j <= i + config.horizonBars; j++) {
      const bar = candles[j]!;
      const stopHit = isShort ? bar.h >= stopPrice : bar.l <= stopPrice;
      if (stopHit) {
        exitIdx = j;
        exitPrice = stopPrice;
        exitReason = "stop";
        break;
      }
    }

    const initialRisk = isShort ? stopPrice - entryPrice : entryPrice - stopPrice;
    const realizedPnl = isShort ? entryPrice - exitPrice : exitPrice - entryPrice;
    const rMultiple = realizedPnl / initialRisk;

    trades.push({
      entryIndex: i,
      exitIndex: exitIdx,
      entryPrice,
      exitPrice,
      stopPrice,
      rMultiple,
      exitReason,
      composite: score.score,
      side,
    });

    lastEntryIdx = i;
  }
  return trades;
}

export function summarize(trades: readonly BacktestTrade[]): BacktestStats {
  if (trades.length === 0) {
    return { trades: 0, wins: 0, losses: 0, winRate: 0, avgWinR: 0, avgLossR: 0, expectancy: 0, totalR: 0, rDistribution: [], maxDrawdownR: 0 };
  }
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple <= 0);
  const totalR = trades.reduce((acc, t) => acc + t.rMultiple, 0);
  const avgWinR = wins.length > 0 ? wins.reduce((a, t) => a + t.rMultiple, 0) / wins.length : 0;
  const avgLossR = losses.length > 0 ? losses.reduce((a, t) => a + t.rMultiple, 0) / losses.length : 0;
  const expectancy = totalR / trades.length;

  // Max drawdown in R
  let runningR = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    runningR += t.rMultiple;
    if (runningR > peak) peak = runningR;
    const dd = peak - runningR;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / trades.length,
    avgWinR,
    avgLossR,
    expectancy,
    totalR,
    rDistribution: trades.map((t) => t.rMultiple),
    maxDrawdownR: maxDd,
  };
}

export interface PermutationResult {
  realStats: BacktestStats;
  permutedTotalRs: number[];
  meanPermuted: number;
  stdPermuted: number;
  pValue: number;
  significant: boolean;
}

/**
 * Run the strategy on shuffled versions of the input series and compute p-value.
 *
 * Block-shuffle preserves short-term autocorrelation (so candlestick patterns are
 * still locally valid) while breaking long-term predictability — exactly what
 * Aronson's permutation methodology requires.
 */
export function permutationTest(
  candleSetsBySymbol: Record<string, Candle[]>,
  config: BacktestConfig,
  permutations = 200,
  blockSize = 5,
  seed = 42,
): PermutationResult {
  // Real
  const realTrades: BacktestTrade[] = [];
  for (const candles of Object.values(candleSetsBySymbol)) {
    realTrades.push(...runStrategyOnSeries(candles, config));
  }
  const realStats = summarize(realTrades);

  // Permuted
  const rand = mulberry32(seed);
  const permutedTotalRs: number[] = [];
  for (let p = 0; p < permutations; p++) {
    const permTrades: BacktestTrade[] = [];
    for (const candles of Object.values(candleSetsBySymbol)) {
      const shuffled = blockShuffle(candles, blockSize, rand);
      permTrades.push(...runStrategyOnSeries(shuffled, config));
    }
    const summ = summarize(permTrades);
    permutedTotalRs.push(summ.totalR);
  }

  const mean = permutedTotalRs.reduce((a, b) => a + b, 0) / permutations;
  const variance = permutedTotalRs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / permutations;
  const std = Math.sqrt(variance);
  const beatCount = permutedTotalRs.filter((s) => s >= realStats.totalR).length;
  const pValue = beatCount / permutations;

  return {
    realStats,
    permutedTotalRs,
    meanPermuted: mean,
    stdPermuted: std,
    pValue,
    significant: pValue < 0.05,
  };
}
