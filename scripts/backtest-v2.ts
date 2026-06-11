/**
 * Backtest harness v2 — CLI orchestrator.
 *
 * Composes the data-fetcher, score-cache, grid expander, walk-forward engine,
 * metrics layer, and reporter into one end-to-end pipeline. The single
 * highest-leverage optimization (per PRD §10 Q2) lives in this script: the
 * **score-cache hoist** — `precomputeScores` runs ONCE per (symbol, fold)
 * and the resulting `ScoreSeries` is reused across every grid cell, killing
 * the ~96× redundant `scoreChart` work the naive nesting would incur.
 *
 * Usage:
 *   npx tsx scripts/backtest-v2.ts --smoke
 *   npx tsx scripts/backtest-v2.ts --window-days 180 --top-n 30
 *   npx tsx scripts/backtest-v2.ts --cache-only
 *
 * For the full flag set, see `parseArgs` below or run `--help`.
 *
 * Companion docs:
 * - docs/BACKTEST_HARNESS_V2_PRD.md §4
 * - docs/BACKTEST_V2_ARCHITECTURE.md §scripts/backtest-v2.ts
 */

import type { Candle } from "../src/analysis/indicators.js";
import type { BacktestTrade, BarScore, BarScoreLookup } from "../src/analysis/backtest.js";
import { runStrategyOnSeries, summarize } from "../src/analysis/backtest.js";

import {
  fetchSeriesCached,
  loadCachedSeries,
  type CachedSeries,
} from "../src/backtest/data-fetcher.js";
import { expandGrid, configId, type BacktestConfigV2, type GridSpec } from "../src/backtest/grid.js";
import { buildUniverseSnapshot, type UniverseSnapshot } from "../src/backtest/universe.js";
import {
  precomputeScores,
  getScoreAt,
  type ScoreSeries,
  type ScoreSnapshot,
} from "../src/backtest/score-cache.js";
import {
  defineFolds,
  type Fold,
  type FoldResult,
  type WalkForwardResult,
} from "../src/backtest/walk-forward.js";
import {
  applyCosts,
  DEFAULT_COST_MODEL,
  extendStats,
  isOosDelta as isOosDeltaFn,
} from "../src/backtest/metrics.js";
import { renderReport, renderCertifiedConfigJson } from "../src/backtest/reporter.js";

import { BLOFIN_TOP30_PERP } from "../src/whitelist.js";

// ---------------------------------------------------------------------------
// Argument parsing — mirrors `scripts/backtest.ts:parseArgs`
// ---------------------------------------------------------------------------

interface CliArgs {
  smoke: boolean;
  windowDays: number;
  topN: number;
  cacheOnly: boolean;
  output: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Record<string, string | true> = {};
  const flagOnlyKeys = new Set(["smoke", "cache-only", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--") && !flagOnlyKeys.has(key)) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  const smoke = args["smoke"] === true;
  const help = args["help"] === true;
  // Smoke defaults override unless explicitly given.
  const defaultWindowDays = smoke ? 30 : 180;
  const defaultTopN = smoke ? 5 : 30;
  return {
    smoke,
    windowDays: typeof args["window-days"] === "string" ? parseInt(args["window-days"] as string, 10) : defaultWindowDays,
    topN: typeof args["top-n"] === "string" ? parseInt(args["top-n"] as string, 10) : defaultTopN,
    cacheOnly: args["cache-only"] === true,
    output: typeof args["output"] === "string" ? (args["output"] as string) : "docs/BACKTEST_V2_RESULTS.md",
    help,
  };
}

function printHelp(): void {
  const lines = [
    "Usage: npx tsx scripts/backtest-v2.ts [flags]",
    "",
    "Flags:",
    "  --smoke              Smoke modus: 1 month window, 5 symbols, 16 configs, 1 fold.",
    "                       Designed for a ~45 min wall-clock budget on an M-series Mac.",
    "  --window-days <N>    Window length in days. Default 180 (smoke: 30).",
    "  --top-n <N>          Universe size. Default 30 (smoke: 5).",
    "  --cache-only         Skip network. Fail per-symbol if the cache file is missing.",
    "  --output <PATH>      Markdown report output path.",
    "                       Default: docs/BACKTEST_V2_RESULTS.md",
    "  --help               Show this message and exit.",
    "",
    "Examples:",
    "  npx tsx scripts/backtest-v2.ts --smoke",
    "  npx tsx scripts/backtest-v2.ts --window-days 180 --top-n 30",
    "  npx tsx scripts/backtest-v2.ts --cache-only --output /tmp/v2-results.md",
  ];
  for (const l of lines) console.log(l);
}

// ---------------------------------------------------------------------------
// Grid specs
// ---------------------------------------------------------------------------

/**
 * Smoke grid: 16 configs total (4 × 2 × 2 × 1 × 1 × 2).
 * Drops the `horizonBars` and `cooldownBars` dimensions per the PR scope.
 *
 * Composition:
 *   thresholdComposite: [55, 60, 65, 70]   → 4
 *   requireStage2:      [true, false]       → 2
 *   stopAtrMult:        [1.5, 2.5]          → 2
 *   horizonBars:        [36]                → 1 (3h on 5m)
 *   cooldownBars:       [12]                → 1 (1h)
 *   side:               ["LONG", "SHORT"]   → 2
 */
const SMOKE_GRID: GridSpec = {
  thresholdComposite: [55, 60, 65, 70],
  requireStage2: [true, false],
  stopAtrMult: [1.5, 2.5],
  horizonBars: [36],
  cooldownBars: [12],
  side: ["LONG", "SHORT"],
  fixed: {
    warmupBars: 200,
    stage2SmaPeriod: 150,
    requireBreakout: false,
  },
};

/**
 * Full grid: 96 configs (4 × 2 × 3 × 2 × 1 × 2) per ARCHITECTURE §10 Q1
 * Stage 2 recommendation. Single cooldown value, both horizons, all
 * thresholds.
 */
const FULL_GRID: GridSpec = {
  thresholdComposite: [55, 60, 65, 70],
  requireStage2: [true, false],
  stopAtrMult: [1.5, 2.0, 2.5],
  horizonBars: [36, 144],
  cooldownBars: [72],
  side: ["LONG", "SHORT"],
  fixed: {
    warmupBars: 200,
    stage2SmaPeriod: 150,
    requireBreakout: false,
  },
};

// ---------------------------------------------------------------------------
// Fold definition (smoke ad-hoc + standard 6mo path)
// ---------------------------------------------------------------------------

/**
 * For smoke modus (1-month window): a single ad-hoc fold with 75% train / 25%
 * test. Statistically NOT a valid CV — smoke is purely an integration check.
 * Reporter will see exactly one fold per config and the agg fold sanity check
 * is skipped.
 */
function defineSmokeFold(startMs: number, endMs: number): Fold[] {
  const span = endMs - startMs;
  const cut = startMs + Math.floor(span * 0.75);
  const fold1: Fold = {
    id: "fold1",
    trainStartMs: startMs,
    trainEndMs: cut,
    testStartMs: cut,
    testEndMs: endMs,
  };
  return [fold1];
}

// ---------------------------------------------------------------------------
// Score-cache hoist: per (symbol, fold)
// ---------------------------------------------------------------------------

/**
 * Key for the score-cache map. The cache spans the (symbol, fold-window)
 * superset slice — see `buildHoistedScoreCache` for the exact slice used.
 */
type CacheKey = string;
function cacheKey(symbol: string, foldId: string): CacheKey {
  return `${symbol}|${foldId}`;
}

/**
 * Cached entry: the precomputed score series for one (symbol, fold) plus the
 * slice metadata needed to translate engine bar-indices back into the original
 * `CachedSeries`.
 */
interface CachedScores {
  /** The slice candles passed into `precomputeScores`. */
  sliceCandles: Candle[];
  /** Score series aligned with `sliceCandles`. */
  series: ScoreSeries;
  /** Index in `sliceCandles` corresponding to the first test-window bar. */
  firstTestIdx: number;
}

/**
 * Slice a series to candles whose `t * 1000 < endMs`. Oldest-first input.
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
 * Build a (test) slice = [warmupBars before testStartMs, ...test_window_bars].
 * Mirrors `walk-forward.ts:sliceWithWarmup` exactly so trade ownership math
 * stays consistent across the hoisted-cache path.
 */
function sliceWithWarmup(
  candles: readonly Candle[],
  windowStartMs: number,
  windowEndMs: number,
  warmupBars: number,
): { slice: Candle[]; firstWindowIdxInSlice: number } {
  let firstWindowIdx = candles.length;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i]!.t * 1000 >= windowStartMs) {
      firstWindowIdx = i;
      break;
    }
  }
  let endIdx = candles.length;
  for (let i = firstWindowIdx; i < candles.length; i++) {
    if (candles[i]!.t * 1000 >= windowEndMs) {
      endIdx = i;
      break;
    }
  }
  const sliceStart = Math.max(0, firstWindowIdx - warmupBars);
  return {
    slice: candles.slice(sliceStart, endIdx),
    firstWindowIdxInSlice: firstWindowIdx - sliceStart,
  };
}

/**
 * Precompute the score series for every (symbol, fold) in `universeBySplit`.
 *
 * The cache spans the SUPERSET window per fold:
 *   train: full prefix up to `trainEndMs`
 *   test:  `[warmupBars before testStartMs, ...test_window_bars]`
 * — exactly the slices the engine receives during execution. We cache one
 * series per (symbol, fold-train) and one per (symbol, fold-test), keyed by
 * `${symbol}|${foldId}-train` and `${symbol}|${foldId}-test` respectively.
 *
 * INVARIANT (per ARCHITECTURE.md §score-cache.ts): the output is independent
 * of every `BacktestConfigV2` field. We use the GRID's `fixed.warmupBars` and
 * `fixed.stage2SmaPeriod` (shared across all configs) to populate the cache —
 * any per-cell variation in those fields would break the invariant. The grid
 * specs in this script keep them in `fixed`, so we're safe.
 */
function buildHoistedScoreCache(
  symbolsToFolds: ReadonlyArray<{ symbol: string; folds: readonly Fold[]; cached: CachedSeries }>,
  warmupBars: number,
  stage2SmaPeriod: number,
  onProgress: (current: number, total: number, label: string) => void,
): Map<CacheKey, CachedScores> {
  const cache = new Map<CacheKey, CachedScores>();
  let work = 0;
  const totalWork = symbolsToFolds.reduce((acc, x) => acc + x.folds.length * 2, 0);

  for (const entry of symbolsToFolds) {
    for (const fold of entry.folds) {
      // TRAIN slice
      const trainSlice = sliceUpToMs(entry.cached.candles, fold.trainEndMs);
      const trainSeries = precomputeScores(trainSlice, warmupBars, stage2SmaPeriod);
      cache.set(cacheKey(entry.symbol, `${fold.id}-train`), {
        sliceCandles: trainSlice,
        series: trainSeries,
        firstTestIdx: 0, // unused for train
      });
      work += 1;
      onProgress(work, totalWork, `${entry.symbol}/${fold.id}/train`);

      // TEST slice
      const { slice: testSlice, firstWindowIdxInSlice } = sliceWithWarmup(
        entry.cached.candles,
        fold.testStartMs,
        fold.testEndMs,
        warmupBars,
      );
      const testSeries = precomputeScores(testSlice, warmupBars, stage2SmaPeriod);
      cache.set(cacheKey(entry.symbol, `${fold.id}-test`), {
        sliceCandles: testSlice,
        series: testSeries,
        firstTestIdx: firstWindowIdxInSlice,
      });
      work += 1;
      onProgress(work, totalWork, `${entry.symbol}/${fold.id}/test`);
    }
  }
  return cache;
}

/**
 * Build a `BarScoreLookup` closure over a `ScoreSeries`. The structural type
 * `BarScore` is identical to `ScoreSnapshot` — straight pass-through.
 */
function lookupFor(series: ScoreSeries): BarScoreLookup {
  return (i: number): BarScore | null => {
    const snap: ScoreSnapshot | null = getScoreAt(series, i);
    if (snap === null) return null;
    return snap; // structural identity — same fields
  };
}

// ---------------------------------------------------------------------------
// Walk-forward with the hoisted score cache
// ---------------------------------------------------------------------------

/**
 * Replicates `runWalkForward` (from `src/backtest/walk-forward.ts`) but uses
 * the pre-built score cache, eliminating the per-bar `scoreChart` redundancy
 * across configs.
 *
 * We REPLICATE rather than extend the walk-forward module because:
 *   (a) The hoist needs to be lifted ABOVE the config loop (the cache must be
 *       reused across all 16+ configs for one fold-symbol). Extending
 *       `runWalkForward` to accept a precomputed cache would require either
 *       passing the cache in per-call (which works but moves the cache-build
 *       call site into the orchestrator regardless), or moving the cache
 *       construction inside `runWalkForward` (which couples it to the grid
 *       layer and breaks the "one symbol at a time" semantics of the function).
 *   (b) The orchestrator is the place where the cache lives — it knows the
 *       grid AND the folds. Keeping the hoist in this script makes the
 *       speedup mechanism explicit at the call site and leaves
 *       `walk-forward.ts` (which is also called from tests + future
 *       single-config runs) unchanged.
 */
function runWalkForwardCached(
  cfg: BacktestConfigV2,
  seriesBySymbol: Readonly<Record<string, CachedSeries>>,
  folds: readonly Fold[],
  opts: { universeTopN: number },
  scoreCache: Map<CacheKey, CachedScores>,
): WalkForwardResult {
  const foldResults: FoldResult[] = [];

  for (const fold of folds) {
    const universe: UniverseSnapshot = buildUniverseSnapshot(seriesBySymbol, fold.trainStartMs, opts.universeTopN);

    type Tagged = BacktestTrade & { symbol: string; entryMs: number };
    const trainTagged: Tagged[] = [];
    const testTagged: Tagged[] = [];

    for (const symbol of universe.selected) {
      const cached = seriesBySymbol[symbol];
      if (!cached) continue;

      // TRAIN
      const trainCacheEntry = scoreCache.get(cacheKey(symbol, `${fold.id}-train`));
      if (trainCacheEntry) {
        const trainTrades = runStrategyOnSeries(
          trainCacheEntry.sliceCandles,
          cfg,
          lookupFor(trainCacheEntry.series),
        );
        for (const t of trainTrades) {
          const entryBar = trainCacheEntry.sliceCandles[t.entryIndex];
          const entryMs = entryBar ? entryBar.t * 1000 : 0;
          trainTagged.push({ ...t, symbol, entryMs });
        }
      }

      // TEST
      const testCacheEntry = scoreCache.get(cacheKey(symbol, `${fold.id}-test`));
      if (testCacheEntry) {
        const testTrades = runStrategyOnSeries(
          testCacheEntry.sliceCandles,
          cfg,
          lookupFor(testCacheEntry.series),
        );
        for (const t of testTrades) {
          const entryBar = testCacheEntry.sliceCandles[t.entryIndex];
          const entryMs = entryBar ? entryBar.t * 1000 : 0;
          if (entryMs >= fold.testStartMs && entryMs < fold.testEndMs) {
            testTagged.push({ ...t, symbol, entryMs });
          }
        }
      }
    }

    // Apply costs (fees + slippage) to every trade. Same logic as
    // `walk-forward.ts:runWalkForward`.
    const trainWithCosts: Tagged[] = trainTagged.map((t) => {
      const costed = applyCosts(t, DEFAULT_COST_MODEL);
      return { ...costed, symbol: t.symbol, entryMs: t.entryMs };
    });
    const testWithCosts: Tagged[] = testTagged.map((t) => {
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

// ---------------------------------------------------------------------------
// Data fetch — universe candidate pool
// ---------------------------------------------------------------------------

/**
 * Resolve the candidate universe instIds.
 *
 * Smoke modus: candidate pool = `max(args.topN * 2, 5)` from `BLOFIN_TOP30_PERP`.
 *   The pool must be a strict superset of the per-fold target topN so the
 *   as-of-volume ranker has real selection room. Doubling gives the universe
 *   step something to actually rank; if the user asks for top-15 we hand it
 *   30 candidates, not 5.
 * Full modus: the full `BLOFIN_TOP30_PERP` (30 perps). The architecture's
 *   "top-50 superset" decision (PRD §10 Q6) is approximated here using the
 *   curated top-30 — we have no published #31-50 list, and the per-fold
 *   universe selection still picks top-`topN` dynamically from each fold's
 *   as-of volume rank within whatever pool we hand it.
 */
function resolveCandidateInstIds(args: CliArgs): string[] {
  if (args.smoke) {
    const poolSize = Math.min(BLOFIN_TOP30_PERP.length, Math.max(args.topN * 2, 5));
    return [...BLOFIN_TOP30_PERP].slice(0, poolSize);
  }
  return [...BLOFIN_TOP30_PERP];
}

/**
 * Fetch every candidate symbol's series. Logs progress to stderr.
 *
 * `--cache-only` mode: never touches the network. Symbols with no cache file
 * are skipped (with a stderr warning).
 */
async function loadAllSeries(
  candidates: readonly string[],
  range: { fromMs: number; toMs: number },
  cacheOnly: boolean,
): Promise<Record<string, CachedSeries>> {
  const out: Record<string, CachedSeries> = {};
  for (let i = 0; i < candidates.length; i++) {
    const instId = candidates[i]!;
    process.stderr.write(`[fetch ${i + 1}/${candidates.length}] ${instId}... `);
    try {
      let series: CachedSeries | null;
      if (cacheOnly) {
        series = await loadCachedSeries(instId);
        if (!series) {
          process.stderr.write("no cache (skip)\n");
          continue;
        }
        // Filter to window.
        series = {
          ...series,
          candles: series.candles.filter(
            (c) => c.t * 1000 >= range.fromMs && c.t * 1000 < range.toMs,
          ),
        };
      } else {
        series = await fetchSeriesCached(instId, range);
      }
      out[instId] = series;
      process.stderr.write(`${series.candles.length} bars\n`);
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const windowMs = args.windowDays * 86_400_000;
  const endMs = startedAtMs;
  const startMs = endMs - windowMs;

  const spec = args.smoke ? SMOKE_GRID : FULL_GRID;
  const configs = expandGrid(spec);
  const folds = args.smoke ? defineSmokeFold(startMs, endMs) : defineFolds(startMs, endMs);

  process.stderr.write("=".repeat(72) + "\n");
  process.stderr.write(`backtest-v2 ${args.smoke ? "(SMOKE)" : "(FULL)"}\n`);
  process.stderr.write(`window      ${new Date(startMs).toISOString().slice(0, 10)} -> ${new Date(endMs).toISOString().slice(0, 10)} (${args.windowDays}d)\n`);
  process.stderr.write(`top-n       ${args.topN}\n`);
  process.stderr.write(`grid size   ${configs.length} configs\n`);
  process.stderr.write(`folds       ${folds.length}\n`);
  process.stderr.write(`output      ${args.output}\n`);
  if (args.smoke) {
    process.stderr.write(`NOTE: smoke modus uses a single ad-hoc 75/25 train/test split.\n`);
    process.stderr.write(`      NOT statistically valid cross-validation. Integration smoke only.\n`);
  }
  process.stderr.write("=".repeat(72) + "\n\n");

  // 1. Fetch series
  const candidates = resolveCandidateInstIds(args);
  process.stderr.write(`[1/4] fetching ${candidates.length} candidate series...\n`);
  const seriesBySymbol = await loadAllSeries(candidates, { fromMs: startMs, toMs: endMs }, args.cacheOnly);
  const fetchedCount = Object.keys(seriesBySymbol).length;
  process.stderr.write(`      fetched ${fetchedCount}/${candidates.length} symbols\n\n`);
  if (fetchedCount === 0) {
    process.stderr.write("FATAL: no series available — nothing to run.\n");
    return 1;
  }

  // 2. Score-cache hoist
  process.stderr.write(`[2/4] hoisting score-cache (precompute scoreChart per symbol-fold)...\n`);
  const cacheEntries = Object.entries(seriesBySymbol).map(([symbol, cached]) => ({
    symbol,
    folds,
    cached,
  }));
  const scoreCache = buildHoistedScoreCache(
    cacheEntries,
    spec.fixed.warmupBars,
    spec.fixed.stage2SmaPeriod ?? 150,
    (current, total, label) => {
      if (current === total || current % 5 === 0) {
        process.stderr.write(`      [${current}/${total}] ${label}\n`);
      }
    },
  );
  process.stderr.write(`      built ${scoreCache.size} cached score series\n\n`);

  // 3. Grid sweep with hoisted cache
  process.stderr.write(`[3/4] running ${configs.length} configs across ${folds.length} fold(s)...\n`);
  const sweepStartMs = Date.now();
  const results: WalkForwardResult[] = [];
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]!;
    process.stderr.write(`      [${i + 1}/${configs.length}] ${configId(cfg)}... `);
    const t0 = Date.now();
    const r = runWalkForwardCached(cfg, seriesBySymbol, folds, { universeTopN: args.topN }, scoreCache);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stderr.write(`OOS exp ${r.oosMeanExpectancy.toFixed(3)}R (${dt}s)\n`);
    results.push(r);
  }
  const sweepSec = ((Date.now() - sweepStartMs) / 1000).toFixed(1);
  process.stderr.write(`      sweep done in ${sweepSec}s\n\n`);

  // 4. Trim trade arrays for non-top-10 configs to keep memory + report size bounded.
  // PRD §10 Q3: retain trade arrays only for top-10 by OOS expectancy.
  const ranked = [...results].sort((a, b) => b.oosMeanExpectancy - a.oosMeanExpectancy);
  const top10Set = new Set(ranked.slice(0, 10).map((r) => configId(r.config)));
  for (const r of results) {
    if (!top10Set.has(configId(r.config))) {
      for (const f of r.folds) {
        f.trainTrades = [];
        f.testTrades = [];
      }
    }
  }

  // 5. Write report
  process.stderr.write(`[4/4] rendering report to ${args.output}...\n`);
  const durationSec = (Date.now() - startedAtMs) / 1000;
  await renderReport(results, {
    outputPath: args.output,
    runMetadata: {
      startedAt: startedAtIso,
      durationSec,
      gridSize: configs.length,
      universeTopN: args.topN,
      windowStartMs: startMs,
      windowEndMs: endMs,
    },
    certificationGates: {
      minOosExpectancy: 0.1,
      minOosSharpe: 1.0,
      maxDrawdownR: 20,
      maxTopSymbolShare: 0.5,
    },
  });
  process.stderr.write(`      report written.\n\n`);

  // 6. Emit certified-config JSON to stdout (consumed by paper-trader.ts as a copy-paste step).
  const jsonBlock = renderCertifiedConfigJson(results);
  if (jsonBlock.length > 0) {
    process.stderr.write("Certified winning config:\n");
    console.log(jsonBlock);
  } else {
    process.stderr.write("No config passed all certification gates — see report for details.\n");
  }

  process.stderr.write(`\nTotal wall-clock: ${durationSec.toFixed(1)}s\n`);
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
