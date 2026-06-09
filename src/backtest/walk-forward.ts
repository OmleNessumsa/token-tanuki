/**
 * Walk-forward cross-validation orchestrator for the backtest harness v2.
 *
 * Splits a 6-month window into 3 rolling folds of (3mo train + 1mo test) plus
 * one aggregate sanity fold. Per fold:
 *   1. Build a universe snapshot AS-OF the fold's train-start (no look-ahead).
 *   2. For each universe symbol: slice the full cached series twice (once for
 *      train, once for test) and call the engine on each slice. The test
 *      slice is the FULL prefix up to testEndMs — keeps indicators warm at
 *      testStart without re-running warmup. Trades from the test pass are
 *      filtered by entry-timestamp ownership (entryMs >= testStartMs).
 *   3. Tag trades with their source symbol + entryMs (wrapper type), apply
 *      costs (fees + slippage per PRD §10 Q5), and aggregate.
 *   4. Summarize → extend with concentration / Sharpe / profitFactor.
 *
 * MONTH-LENGTH CONVENTION
 *   Calendar-month math, NOT 30-day approximations. `defineFolds(jan1, jul1)`
 *   produces:
 *     fold1: train [Jan1, Apr1), test [Apr1, May1)
 *     fold2: train [Feb1, May1), test [May1, Jun1)
 *     fold3: train [Mar1, Jun1), test [Jun1, Jul1)
 *     agg:   train [start,   start+3mo), test [start+3mo, endMs)
 *   The 1-month offset is added via UTC Date construction (year/month+1/day),
 *   which honors irregular month lengths. Matches the fold-boundaries test's
 *   exact expected timestamps (FEB1, MAR1, APR1, MAY1, JUN1, JUL1).
 *
 * ENGINE INTEGRATION CHOICE
 *   We call PR #1's `runStrategyOnSeries` directly, then tag results. We do
 *   NOT pre-compute a score-cache here for the v2 PR scope. Reasoning:
 *     (a) Architecture forbids `src/analysis/*` from importing
 *         `src/backtest/*` (one-way dependency rule). Extending
 *         `runStrategyOnSeries` to take an external `ScoreSeries` parameter
 *         would invert the dependency or require touching PR #1, both
 *         disallowed by this PR's scope.
 *     (b) For a single config (PR #3 scope), `precomputeScores` adds upfront
 *         cost without amortization — the speedup only materializes when
 *         many configs share the same fold-window cache (PR #4 grid
 *         orchestrator). Hoisting the cache into the grid layer is the
 *         architecturally correct place; PR #3 stays single-config and uses
 *         the lazy in-engine scoring already in PR #1.
 *   `precomputeScores` / `score-cache.ts` from PR #2 remain available and
 *   are intended for the future grid orchestrator (PR #4) to call once per
 *   fold across all configs.
 *
 * TRADE OWNERSHIP TAGGING
 *   Per ARCHITECTURE.md §Look-ahead Bias Audit (c), trade ownership is
 *   decided by ENTRY TIMESTAMP, not exit timestamp. We expose entryMs on the
 *   wrapper type `TaggedTrade = BacktestTrade & { symbol; entryMs }` and
 *   filter the test-slice trades to `entryMs >= fold.testStartMs &&
 *   entryMs < fold.testEndMs` after the engine pass.
 *
 * Companion docs:
 * - docs/BACKTEST_HARNESS_V2_PRD.md §5.4
 * - docs/BACKTEST_V2_ARCHITECTURE.md §walk-forward.ts, §Look-ahead Bias Audit (c)
 */

import type { Candle } from "../analysis/indicators.js";
import type { BacktestTrade } from "../analysis/backtest.js";
import { runStrategyOnSeries, summarize } from "../analysis/backtest.js";
import type { BacktestConfigV2 } from "./grid.js";
import type { CachedSeries } from "./data-fetcher.js";
import type { UniverseSnapshot } from "./universe.js";
import { buildUniverseSnapshot } from "./universe.js";
import type { ExtendedStats } from "./metrics.js";
import {
  extendStats,
  applyCosts,
  DEFAULT_COST_MODEL,
  isOosDelta as isOosDeltaFn,
} from "./metrics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Fold {
  id: "fold1" | "fold2" | "fold3" | "agg";
  /** Inclusive unix-ms start of the train window. */
  trainStartMs: number;
  /** Exclusive unix-ms end of the train window. Equal to testStartMs (adjacency, not overlap). */
  trainEndMs: number;
  /** Inclusive unix-ms start of the test window. */
  testStartMs: number;
  /** Exclusive unix-ms end of the test window. */
  testEndMs: number;
}

export interface FoldResult {
  fold: Fold;
  universe: UniverseSnapshot;
  trainStats: ExtendedStats;
  testStats: ExtendedStats;
  /** Costs already applied. Tagged with symbol + entryMs. */
  trainTrades: BacktestTrade[];
  /** Costs already applied. Tagged with symbol + entryMs. */
  testTrades: BacktestTrade[];
}

export interface WalkForwardResult {
  config: BacktestConfigV2;
  folds: FoldResult[];
  /** Unweighted mean of folds 1-3 test expectancy. Excludes the agg fold. */
  oosMeanExpectancy: number;
  /** Unweighted mean of folds 1-3 train expectancy. Excludes the agg fold. */
  isMeanExpectancy: number;
  /** Relative IS/OOS gap; >0.5 → red flag per architecture. */
  isOosDelta: number;
}

/** Public wrapper type — annotates each trade with its source symbol + entry timestamp. */
export type TaggedTrade = BacktestTrade & { symbol: string; entryMs: number };

// ---------------------------------------------------------------------------
// defineFolds — calendar-month boundaries
// ---------------------------------------------------------------------------

/**
 * Add `months` calendar months to a UTC instant, honoring irregular month
 * lengths. Uses the UTC Date constructor so the result is deterministic and
 * timezone-free.
 */
function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + months,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/**
 * Hardcoded for v2: three rolling folds of 3-month train + 1-month test, plus
 * one aggregate sanity fold spanning the entire window.
 *
 * Layout (calendar-month math) for a `[startMs, endMs)` window where
 * `endMs === startMs + 6 calendar months`:
 *   fold1: train [start+0mo, start+3mo), test [start+3mo, start+4mo)
 *   fold2: train [start+1mo, start+4mo), test [start+4mo, start+5mo)
 *   fold3: train [start+2mo, start+5mo), test [start+5mo, start+6mo)
 *   agg:   train [start+0mo, start+3mo), test [start+3mo, endMs)
 *
 * NOTE on the agg fold: per PRD §5.4 / ARCHITECTURE §(c), the aggregate fold
 * trains on the first 3 calendar months and tests on the remaining span up
 * to `endMs`. We intentionally compute `agg.trainEndMs` via calendar-month
 * arithmetic (= `start + 3 calendar months`), NOT via `(endMs - startMs)/2`,
 * so `agg.trainEndMs === fold1.trainEndMs` and `agg.testStartMs ===
 * fold1.testStartMs`. For a 6-calendar-month window, these two values may
 * differ from the bare-millisecond midpoint by up to half a day because
 * calendar months are irregular.
 *
 * Return-array order is fixed: fold1, fold2, fold3, agg.
 */
export function defineFolds(startMs: number, endMs: number): Fold[] {
  const m1 = addMonthsUtc(startMs, 1);
  const m2 = addMonthsUtc(startMs, 2);
  const m3 = addMonthsUtc(startMs, 3);
  const m4 = addMonthsUtc(startMs, 4);
  const m5 = addMonthsUtc(startMs, 5);
  const m6 = addMonthsUtc(startMs, 6);

  const fold1: Fold = {
    id: "fold1",
    trainStartMs: startMs,
    trainEndMs: m3,
    testStartMs: m3,
    testEndMs: m4,
  };
  const fold2: Fold = {
    id: "fold2",
    trainStartMs: m1,
    trainEndMs: m4,
    testStartMs: m4,
    testEndMs: m5,
  };
  const fold3: Fold = {
    id: "fold3",
    trainStartMs: m2,
    trainEndMs: m5,
    testStartMs: m5,
    testEndMs: m6,
  };
  const agg: Fold = {
    id: "agg",
    trainStartMs: startMs,
    trainEndMs: m3,
    testStartMs: m3,
    testEndMs: endMs,
  };
  return [fold1, fold2, fold3, agg];
}

// ---------------------------------------------------------------------------
// runWalkForward — composition
// ---------------------------------------------------------------------------

/**
 * Return the prefix of `candles` whose `t * 1000 < endMs`. Candles are
 * oldest-first by contract (CachedSeries invariant), so we find the first
 * out-of-window index and slice up to it.
 */
function sliceUpToMs(candles: readonly Candle[], endMs: number): Candle[] {
  let cutoff = candles.length;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i]!.t * 1000 >= endMs) {
      cutoff = i;
      break;
    }
  }
  return candles.slice(0, cutoff);
}

/**
 * Build a test slice = `[warmupBars bars before windowStartMs, ...window bars
 * with t*1000 < windowEndMs]`. The engine's loop starts at
 * `i = config.warmupBars`, which maps to the first bar of `[windowStartMs,
 * windowEndMs)` in this slice — so entries fire starting at the test-window
 * boundary, with indicators warmed by the preceding bars.
 *
 * If fewer than `warmupBars` candles exist before `windowStartMs`, we take
 * however many are available. The engine's internal warmup-guard already
 * handles short slices gracefully (returns no trades).
 */
function sliceWithWarmup(
  candles: readonly Candle[],
  windowStartMs: number,
  windowEndMs: number,
  warmupBars: number,
): Candle[] {
  // Find the index of the first window bar (first candle with t*1000 >= windowStartMs).
  let firstWindowIdx = candles.length;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i]!.t * 1000 >= windowStartMs) {
      firstWindowIdx = i;
      break;
    }
  }
  // Find the index of the first out-of-window bar (first candle with t*1000 >= windowEndMs).
  let endIdx = candles.length;
  for (let i = firstWindowIdx; i < candles.length; i++) {
    if (candles[i]!.t * 1000 >= windowEndMs) {
      endIdx = i;
      break;
    }
  }
  const sliceStart = Math.max(0, firstWindowIdx - warmupBars);
  return candles.slice(sliceStart, endIdx);
}

/**
 * Annotate engine-emitted trades with their source symbol and the entry
 * timestamp (unix-ms) corresponding to the entryIndex on the slice they were
 * run against.
 */
function tagTrades(
  trades: readonly BacktestTrade[],
  symbol: string,
  sliceCandles: readonly Candle[],
): TaggedTrade[] {
  return trades.map((t) => {
    const entryBar = sliceCandles[t.entryIndex];
    const entryMs = entryBar ? entryBar.t * 1000 : 0;
    return { ...t, symbol, entryMs };
  });
}

/**
 * Run the strategy across one fold for every symbol in the fold's universe.
 *
 * `seriesBySymbol` is the FULL 6-month series per symbol; this function does
 * the slicing internally. For each symbol:
 *   - Train run: pass the train slice (all candles whose
 *     `t * 1000 < fold.trainEndMs`) into `runStrategyOnSeries`. All emitted
 *     trades have entryMs < testStartMs by construction.
 *   - Test run: pass `[warmupBars before testStartMs, ...test_window_bars]`
 *     into `runStrategyOnSeries`. We use the OPTION (ii) slice strategy from
 *     the architecture: prepend exactly `cfg.warmupBars` bars before
 *     testStartMs so indicators have history when the engine starts at
 *     `i = warmupBars` (which corresponds to the first test-window bar).
 *     This is ~6× cheaper than feeding the full prefix and post-filtering,
 *     critical for the test's 52k-bar synthetic series. We still post-filter
 *     by `entryMs >= testStartMs && entryMs < testEndMs` as a defensive
 *     guard against any boundary off-by-one.
 *
 * Universe is selected AS-OF train start (NOT test start) per PRD §9.5.
 * This matches what a live trader would do: pick the universe at the
 * beginning of the train window and hold it constant through test.
 */
export function runWalkForward(
  cfg: BacktestConfigV2,
  seriesBySymbol: Readonly<Record<string, CachedSeries>>,
  folds: readonly Fold[],
  opts: { universeTopN: number },
): WalkForwardResult {
  const foldResults: FoldResult[] = [];

  for (const fold of folds) {
    const universe = buildUniverseSnapshot(seriesBySymbol, fold.trainStartMs, opts.universeTopN);

    const taggedTrainTrades: TaggedTrade[] = [];
    const taggedTestTrades: TaggedTrade[] = [];

    for (const symbol of universe.selected) {
      const cached = seriesBySymbol[symbol];
      if (!cached) continue;
      const fullCandles = cached.candles;

      const trainSlice = sliceUpToMs(fullCandles, fold.trainEndMs);
      const testSlice = sliceWithWarmup(fullCandles, fold.testStartMs, fold.testEndMs, cfg.warmupBars);

      // --- TRAIN run --------------------------------------------------------
      const rawTrainTrades = runStrategyOnSeries(trainSlice, cfg);
      const tagged = tagTrades(rawTrainTrades, symbol, trainSlice);
      for (const tr of tagged) taggedTrainTrades.push(tr);

      // --- TEST run ---------------------------------------------------------
      // Engine starts iteration at i=warmupBars, which corresponds to the
      // first test-window bar in this slice. The preceding warmupBars bars
      // are ineligible for entries but provide indicator warmth. We still
      // post-filter by entryMs as a defensive guard.
      const rawTestTrades = runStrategyOnSeries(testSlice, cfg);
      const testTagged = tagTrades(rawTestTrades, symbol, testSlice).filter(
        (t) => t.entryMs >= fold.testStartMs && t.entryMs < fold.testEndMs,
      );
      for (const tr of testTagged) taggedTestTrades.push(tr);
    }

    // Apply costs (fees + slippage per PRD §10 Q5) to every trade.
    const trainWithCosts: TaggedTrade[] = taggedTrainTrades.map((t) => {
      const costed = applyCosts(t, DEFAULT_COST_MODEL);
      return { ...costed, symbol: t.symbol, entryMs: t.entryMs };
    });
    const testWithCosts: TaggedTrade[] = taggedTestTrades.map((t) => {
      const costed = applyCosts(t, DEFAULT_COST_MODEL);
      return { ...costed, symbol: t.symbol, entryMs: t.entryMs };
    });

    const trainBase = summarize(trainWithCosts);
    const testBase = summarize(testWithCosts);
    const trainStats = extendStats(trainBase, trainWithCosts);
    const testStats = extendStats(testBase, testWithCosts);

    foldResults.push({
      fold,
      universe,
      trainStats,
      testStats,
      trainTrades: trainWithCosts,
      testTrades: testWithCosts,
    });
  }

  // OOS / IS aggregates: unweighted mean of folds 1-3 (excludes agg).
  const nonAgg = foldResults.filter((fr) => fr.fold.id !== "agg");
  const isMeanExpectancy = mean(nonAgg.map((fr) => fr.trainStats.expectancy));
  const oosMeanExpectancy = mean(nonAgg.map((fr) => fr.testStats.expectancy));
  const delta = isOosDeltaFn(isMeanExpectancy, oosMeanExpectancy);

  return {
    config: cfg,
    folds: foldResults,
    oosMeanExpectancy,
    isMeanExpectancy,
    isOosDelta: delta,
  };
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
