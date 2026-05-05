/**
 * Monte Carlo permutation testing for trading-rule validation.
 * Source: David Aronson, "Evidence-Based Technical Analysis" (Wiley, 2006), Ch. 6-7.
 *
 * Aronson's question: when a backtest produces +X% return, is X meaningful or just luck
 * from data-mining bias? His answer: shuffle the price series many times, re-run the
 * strategy on each shuffle, and see how often the shuffled version beats the real one.
 * If the real return ranks in the top 5% (p-value < 0.05), the rule has statistical edge.
 *
 * This module implements a simple permutation harness:
 *   - Generate N permutations of the OHLCV series (block-shuffle preserves autocorrelation)
 *   - Run a user-supplied strategy fn on each
 *   - Compute p-value = (count of permuted returns >= real return) / N
 */

import type { Candle } from "./indicators.js";

export interface Strategy {
  /**
   * Given an OHLCV series, return total % return of the strategy
   * (or any scalar quality metric). Higher = better.
   */
  run: (candles: readonly Candle[]) => number;
}

export interface ValidationResult {
  realScore: number;
  permutationScores: number[];
  meanPermutation: number;
  stdPermutation: number;
  pValue: number;       // probability of seeing a result this good or better by chance
  significant: boolean; // p-value < 0.05
  permutations: number;
}

export interface ValidationOpts {
  permutations?: number;
  /** Block-shuffle size to preserve short-term autocorrelation. 0 = full random. */
  blockSize?: number;
  /** Significance threshold (default 0.05 per Aronson Ch. 6). */
  alpha?: number;
  /** Seedable RNG for reproducibility. */
  random?: () => number;
}

/**
 * Run permutation test.
 * Returns p-value: probability under null that random data would beat the strategy.
 */
export function permutationTest(
  candles: readonly Candle[],
  strategy: Strategy,
  opts: ValidationOpts = {},
): ValidationResult {
  const N = opts.permutations ?? 200;
  const blockSize = opts.blockSize ?? 5;
  const alpha = opts.alpha ?? 0.05;
  const rand = opts.random ?? Math.random;

  const realScore = strategy.run(candles);
  const permutationScores: number[] = [];

  for (let i = 0; i < N; i++) {
    const shuffled = blockShuffle(candles, blockSize, rand);
    permutationScores.push(strategy.run(shuffled));
  }

  const mean = permutationScores.reduce((a, b) => a + b, 0) / N;
  const variance = permutationScores.reduce((a, x) => a + (x - mean) ** 2, 0) / N;
  const std = Math.sqrt(variance);
  // p = fraction of permutations that beat or tied real
  const beatCount = permutationScores.filter((s) => s >= realScore).length;
  const pValue = beatCount / N;

  return {
    realScore,
    permutationScores,
    meanPermutation: mean,
    stdPermutation: std,
    pValue,
    significant: pValue < alpha,
    permutations: N,
  };
}

/**
 * Block-shuffle preserves short-range autocorrelation while breaking longer-range structure.
 * Returns a new candle array where the timestamps are sequential but OHLCV blocks are reordered.
 */
export function blockShuffle(
  candles: readonly Candle[],
  blockSize: number,
  rand: () => number = Math.random,
): Candle[] {
  if (candles.length === 0 || blockSize <= 0) return [...candles];
  // Cut series into blocks
  const blocks: Candle[][] = [];
  for (let i = 0; i < candles.length; i += blockSize) {
    blocks.push(candles.slice(i, i + blockSize) as Candle[]);
  }
  // Fisher-Yates on blocks
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
  }
  // Reassemble with sequential timestamps preserved from original
  const out: Candle[] = [];
  let ts = candles[0]!.t;
  const dt = candles.length > 1 ? candles[1]!.t - candles[0]!.t : 60;
  for (const block of blocks) {
    for (const c of block) {
      out.push({ ...c, t: ts });
      ts += dt;
    }
  }
  return out;
}

/** Mulberry32 — seedable PRNG for reproducible tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Common building block: trend-following strategy as a baseline strategy
 * to test the validation framework. Returns total % gain from buying the
 * close above EMA20 and selling on close below it.
 */
export function emaCrossoverStrategy(emaPeriod = 20): Strategy {
  return {
    run: (candles) => {
      if (candles.length < emaPeriod + 5) return 0;
      let position = 0;
      let entryPrice = 0;
      let totalReturn = 0;
      // Use SMA as proxy (ema function imported elsewhere)
      const closes = candles.map((c) => c.c);
      const smaArr: number[] = [];
      let sum = 0;
      for (let i = 0; i < closes.length; i++) {
        sum += closes[i]!;
        if (i >= emaPeriod) sum -= closes[i - emaPeriod]!;
        if (i >= emaPeriod - 1) smaArr.push(sum / emaPeriod);
      }
      const offset = closes.length - smaArr.length;
      for (let i = 1; i < smaArr.length; i++) {
        const price = closes[i + offset]!;
        const sma = smaArr[i]!;
        if (position === 0 && price > sma) {
          position = 1;
          entryPrice = price;
        } else if (position === 1 && price < sma) {
          totalReturn += (price - entryPrice) / entryPrice * 100;
          position = 0;
        }
      }
      // Close any open position at last price
      if (position === 1) {
        const lastPrice = closes[closes.length - 1]!;
        totalReturn += (lastPrice - entryPrice) / entryPrice * 100;
      }
      return totalReturn;
    },
  };
}
