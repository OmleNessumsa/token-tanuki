# Backtest Harness v2 — Architecture

**Author:** architect-morty
**Status:** Design (pre-implementation)
**Companion to:** `docs/BACKTEST_HARNESS_V2_PRD.md` (source of truth — locked decisions in §9)
**Created:** 2026-06-09

This document specifies module boundaries, public APIs, look-ahead invariants, the SHORT-side extension, the caching layer, the test plan, and the open questions blocking implementation. Implementation guidance for backend-morty and tester-morty lives here; the cross-team contract lives in `INTEGRATION_CONTRACT.md`.

Goal: design once, dispatch in parallel, merge cleanly.

---

## Module Map

| File (absolute) | Purpose (one sentence) | Public exports | Depends on | MUST NOT depend on |
|---|---|---|---|---|
| `/Users/elmo.asmussen/Projects/Crypto/src/backtest/data-fetcher.ts` | Paginated 5m OHLCV fetch from Blofin with persistent JSONL.gz cache and resume support. | `type CachedSeries`, `type FetchRange`, `fetchSeriesCached(instId, fromMs, toMs)`, `loadCachedSeries(instId)`, `cacheDir()` | `src/clients/blofin.ts`, `src/analysis/indicators.ts` (`Candle`), Node `fs`/`zlib` | `walk-forward.ts`, `grid.ts`, `metrics.ts`, `reporter.ts`, `scoreChart` |
| `/Users/elmo.asmussen/Projects/Crypto/src/backtest/universe.ts` | Build the as-of-fold-start top-N volume universe without look-ahead by computing rolling 24h quote-volume from cached 5m bars. | `type UniverseSnapshot`, `buildUniverseSnapshot(seriesBySymbol, asOfMs, topN)`, `rollingQuoteVolume24h(candles, asOfMs)` | `data-fetcher.ts`, `indicators.ts` | `walk-forward.ts`, `grid.ts`, Blofin live ticker API |
| `/Users/elmo.asmussen/Projects/Crypto/src/backtest/grid.ts` | Expand a declarative grid spec into an array of `BacktestConfigV2` objects with deterministic ordering. | `type GridSpec`, `type BacktestConfigV2`, `expandGrid(spec)`, `configId(cfg)` | `src/analysis/backtest.ts` (`BacktestConfig`) | everything else |
| `/Users/elmo.asmussen/Projects/Crypto/src/backtest/score-cache.ts` | Per-(symbol, bar) cache of `scoreChart` output, populated once per fold-window and shared across all grid configs. Single highest-leverage optimization (~96× speedup). | `type ScoreSnapshot`, `type ScoreSeries`, `precomputeScores(candles, warmupBars)`, `getScoreAt(series, barIndex)` | `src/analysis/chart.ts` (`scoreChart`), `src/analysis/indicators.ts` (`Candle`) | `walk-forward.ts`, `grid.ts`, `metrics.ts`, `data-fetcher.ts`, network/disk |
| `/Users/elmo.asmussen/Projects/Crypto/src/backtest/walk-forward.ts` | Split a 6-month window into 3 train/test folds + 1 aggregate sanity fold, and run the engine per fold per symbol. | `type Fold`, `type FoldResult`, `type WalkForwardResult`, `defineFolds(startMs, endMs)`, `runWalkForward(cfg, universe, seriesBySymbol, folds)` | `src/analysis/backtest.ts`, `universe.ts`, `grid.ts` (types), `metrics.ts` | `data-fetcher.ts` (must be passed pre-fetched series), `reporter.ts` |
| `/Users/elmo.asmussen/Projects/Crypto/src/backtest/metrics.ts` | Pure functions that compute Sharpe, profit factor, max DD, concentration share, and the IS/OOS delta from arrays of trades. | `type ExtendedStats`, `type ConcentrationReport`, `extendStats(stats, trades)`, `sharpe(rDistribution)`, `profitFactor(trades)`, `symbolConcentration(trades)`, `isOosDelta(is, oos)` | `src/analysis/backtest.ts` (`BacktestTrade`, `BacktestStats`) | I/O of any kind, `reporter.ts` |
| `/Users/elmo.asmussen/Projects/Crypto/src/backtest/reporter.ts` | Render `WalkForwardResult[]` to Markdown matching `BACKTEST_RESULTS.md` style + emit certified-config JSON block. | `renderReport(results, opts)`, `renderCertifiedConfigJson(top)`, `type ReportOptions` | `metrics.ts`, `walk-forward.ts` (types), `grid.ts` (types) | `data-fetcher.ts`, network, the engine itself |
| `/Users/elmo.asmussen/Projects/Crypto/scripts/backtest-v2.ts` | CLI orchestrator: parse args → fetch → build universe per fold → expand grid → run → write report. | `main()` (default export-less; tsx script) | every `src/backtest/*` module, `src/analysis/backtest.ts` | nothing in `src/` reaches up into this script |
| `/Users/elmo.asmussen/Projects/Crypto/src/analysis/backtest.ts` (EXTEND) | Existing engine, generalized so `runStrategyOnSeries` accepts a `side: "LONG" \| "SHORT"` and emits SHORT-side trades with symmetric R-math. | (additive) `side` widened on `BacktestTrade`, new optional `side` on `BacktestConfig`, plus `runStrategyOnSeries` accepting it. Existing exports preserved. | unchanged | unchanged |

### Dependency direction (one-line summary)

```
scripts/backtest-v2.ts
    → data-fetcher → universe → walk-forward → metrics → reporter
                                     ↑   ↑
                              score-cache grid
                                     ↑
                            src/analysis/backtest.ts (extended)
                            src/analysis/chart.ts (read-only, via score-cache only)
```

No module ever imports something from a layer below it (no cycles). `metrics.ts` and `grid.ts` are pure — no I/O, no clocks, no randomness. `data-fetcher.ts` is the only network/disk module in `src/backtest/`.

---

## Public API Signatures

The signatures below are normative — tester-morty writes tests against these exact shapes. Any backend-morty deviation must be raised before merge.

### `src/backtest/data-fetcher.ts`

```ts
import type { Candle } from "../analysis/indicators.js";

export interface FetchRange {
  /** Inclusive start, unix ms. */
  fromMs: number;
  /** Exclusive end, unix ms. */
  toMs: number;
}

export interface CachedSeries {
  instId: string;            // "BTC-USDT"
  bar: "5m";                 // only 5m for v2
  candles: Candle[];         // oldest-first, t in seconds (matches Candle convention)
  coverage: FetchRange;      // [first.t*1000, last.t*1000 + 5*60*1000)
}

/**
 * Fetch the 5m series for `instId` covering [fromMs, toMs).
 * - Reads cache first; only fetches the missing prefix/suffix slices.
 * - JSONL.gz on disk, one file per symbol: `<cacheDir>/<instId>.5m.jsonl.gz`.
 * - Returns oldest-first, deduplicated, gap-tolerant (gaps are reported via stderr; bars stay sparse rather than synthesized).
 */
export function fetchSeriesCached(
  instId: string,
  range: FetchRange,
  opts?: { rateLimitRps?: number; signal?: AbortSignal },
): Promise<CachedSeries>;

/** Pure load (no network). Returns null if no cache file exists. */
export function loadCachedSeries(instId: string): Promise<CachedSeries | null>;

/** Resolve the cache directory; honors `$CRYPTOTRADER_STATE_DIR`, defaults to `~/.cryptotrader-data/blofin-5m/`. */
export function cacheDir(): string;
```

### `src/backtest/universe.ts`

```ts
import type { CachedSeries } from "./data-fetcher.js";

export interface UniverseSnapshot {
  /** Bar timestamp (ms, inclusive) at which the snapshot is taken — the fold-start. */
  asOfMs: number;
  /** Symbols ranked desc by 24h trailing quote volume as of asOfMs. */
  ranked: Array<{ instId: string; quoteVol24h: number }>;
  /** First `topN` of `ranked`. */
  selected: string[];
}

/**
 * Compute the 24h trailing quote-volume sum ending at the LAST CLOSED bar before `asOfMs`.
 * Uses only candles whose close-time (t*1000 + 5*60*1000) is <= asOfMs.
 * Returns 0 if the symbol has <288 5m bars before asOfMs (288 = 24h of 5m bars).
 */
export function rollingQuoteVolume24h(
  candles: readonly Candle[],
  asOfMs: number,
): number;

/**
 * Build the per-fold universe. PURE: no clocks, no I/O.
 * Determinism: tie-break by instId asc to keep the snapshot reproducible across runs.
 */
export function buildUniverseSnapshot(
  seriesBySymbol: Readonly<Record<string, CachedSeries>>,
  asOfMs: number,
  topN: number,
): UniverseSnapshot;
```

### `src/backtest/score-cache.ts`

```ts
import type { Candle } from "../analysis/indicators.js";

export interface ScoreSnapshot {
  /** Composite score from scoreChart at this bar (uses only candles[0..i]). */
  score: number;
  trend: "up" | "down" | "flat";
  hasBreakout: boolean;
  /** Close > SMA(150) — precomputed once for both LONG/SHORT stage2 gating. */
  closeAboveStage2Sma: boolean;
}

/** Dense array of snapshots; index = bar index. Snapshots before warmupBars are null. */
export type ScoreSeries = ReadonlyArray<ScoreSnapshot | null>;

/**
 * Walk `candles` from bar 0 to last, computing `scoreChart(candles.slice(0, i+1))`
 * for every i >= warmupBars. PURE: no I/O.
 *
 * INVARIANT: this function's output is independent of any BacktestConfig field
 * (threshold, stop, horizon, cooldown, side). The cache is shared across all
 * configs in the grid — that's where the ~96× speedup comes from.
 */
export function precomputeScores(
  candles: readonly Candle[],
  warmupBars: number,
  stage2SmaPeriod: number,
): ScoreSeries;

/** Cheap lookup. Returns null for warmup bars or out-of-range indices. */
export function getScoreAt(series: ScoreSeries, barIndex: number): ScoreSnapshot | null;
```

### `src/backtest/grid.ts`

```ts
import type { BacktestConfig } from "../analysis/backtest.js";

export interface GridSpec {
  thresholdComposite: number[];
  requireStage2: boolean[];
  stopAtrMult: number[];
  horizonBars: number[];
  cooldownBars: number[];
  side: Array<"LONG" | "SHORT">;
  /** Shared across every cell. */
  fixed: Pick<BacktestConfig, "warmupBars" | "stage2SmaPeriod" | "requireBreakout">;
}

export interface BacktestConfigV2 extends BacktestConfig {
  side: "LONG" | "SHORT";
}

/** Deterministic Cartesian expansion; ordering is the lexicographic order of `Object.keys(spec)` above. */
export function expandGrid(spec: GridSpec): BacktestConfigV2[];

/** Stable hash for caching per-config fold results. e.g. `LONG-c60-s2T-atr2.0-h36-cd12`. */
export function configId(cfg: BacktestConfigV2): string;
```

### `src/backtest/walk-forward.ts`

```ts
import type { BacktestTrade } from "../analysis/backtest.js";
import type { BacktestConfigV2 } from "./grid.js";
import type { CachedSeries } from "./data-fetcher.js";
import type { UniverseSnapshot } from "./universe.js";
import type { ExtendedStats } from "./metrics.js";

export interface Fold {
  id: "fold1" | "fold2" | "fold3" | "agg";
  trainStartMs: number;
  trainEndMs: number;    // exclusive
  testStartMs: number;
  testEndMs: number;     // exclusive
}

export interface FoldResult {
  fold: Fold;
  universe: UniverseSnapshot;
  trainStats: ExtendedStats;
  testStats: ExtendedStats;
  trainTrades: BacktestTrade[];
  testTrades: BacktestTrade[];
}

export interface WalkForwardResult {
  config: BacktestConfigV2;
  folds: FoldResult[];
  /** Unweighted mean of folds 1-3 test expectancy. */
  oosMeanExpectancy: number;
  /** Unweighted mean of folds 1-3 train expectancy. */
  isMeanExpectancy: number;
  /** abs(IS - OOS) / max(|IS|, |OOS|, 1e-9). > 0.5 → red flag. */
  isOosDelta: number;
}

/** Hardcoded for v2: 3 rolling folds of 3mo train + 1mo test, plus one 6mo-aggregate sanity fold. */
export function defineFolds(startMs: number, endMs: number): Fold[];

/**
 * Runs the engine for one (config × fold × symbol-in-universe), aggregating trades.
 * `seriesBySymbol` is the FULL 6mo series; this function is responsible for slicing
 * to fold boundaries before passing into `runStrategyOnSeries`.
 */
export function runWalkForward(
  cfg: BacktestConfigV2,
  seriesBySymbol: Readonly<Record<string, CachedSeries>>,
  folds: readonly Fold[],
  opts: { universeTopN: number },
): WalkForwardResult;
```

### `src/backtest/metrics.ts`

```ts
import type { BacktestStats, BacktestTrade } from "../analysis/backtest.js";

export interface ExtendedStats extends BacktestStats {
  sharpe: number;            // annualized; bars-per-year derived from 5m → 288/day → 105,120/yr
  profitFactor: number;      // sum(wins) / |sum(losses)|; Infinity if no losses
  maxDrawdownR: number;      // already on BacktestStats; restated for symmetry
  topSymbolShare: number;    // 0..1, the largest single-symbol share of total R (signed)
  contributorBreakdown: Array<{ symbol: string; trades: number; totalR: number; share: number }>;
}

export interface ConcentrationReport {
  totalR: number;
  bySymbol: Array<{ symbol: string; totalR: number; share: number }>;
  killSwitchTripped: boolean; // true if any |share| > 0.50
}

export function extendStats(
  stats: BacktestStats,
  trades: readonly (BacktestTrade & { symbol: string })[],
): ExtendedStats;

export function sharpe(rDistribution: readonly number[], barsPerYear?: number): number;
export function profitFactor(trades: readonly BacktestTrade[]): number;
export function symbolConcentration(trades: readonly (BacktestTrade & { symbol: string })[]): ConcentrationReport;
export function isOosDelta(is: number, oos: number): number;
```

Note: the existing `BacktestTrade` has no `symbol` field — backend-morty must annotate trades with their source symbol at the walk-forward layer before passing into `extendStats`. This is a wrapper type, not a change to the core engine.

### `src/backtest/reporter.ts`

```ts
import type { WalkForwardResult } from "./walk-forward.js";

export interface ReportOptions {
  outputPath: string;        // typically docs/BACKTEST_V2_RESULTS.md
  runMetadata: {
    startedAt: string;       // ISO
    durationSec: number;
    gridSize: number;
    universeTopN: number;
    windowStartMs: number;
    windowEndMs: number;
  };
  certificationGates: {
    minOosExpectancy: number;  // 0.10
    minOosSharpe: number;      // 1.0
    maxDrawdownR: number;      // 20
    maxTopSymbolShare: number; // 0.50
  };
}

export function renderReport(results: readonly WalkForwardResult[], opts: ReportOptions): Promise<void>;

/** Returns the JSON block printed to stdout for paper-trader.ts consumption. Empty string if none certified. */
export function renderCertifiedConfigJson(results: readonly WalkForwardResult[]): string;
```

### `src/analysis/backtest.ts` — additive extensions

```ts
// Widen the existing union; existing call sites that hardcode "LONG" still compile.
export interface BacktestTrade {
  // ...existing fields...
  side: "LONG" | "SHORT";
}

export interface BacktestConfig {
  // ...existing fields...
  /** Direction filter. Defaults to "LONG" to preserve legacy behavior. */
  side?: "LONG" | "SHORT";
}

// Signature unchanged at the call-site level; behavior gated on cfg.side.
export function runStrategyOnSeries(
  candles: readonly Candle[],
  config?: BacktestConfig,
): BacktestTrade[];
```

---

## Look-ahead Bias Audit

Three loci, three invariants. Each gets a dedicated test (see Test Strategy).

### (a) Per-bar signal evaluation — `scoreAtBar`

**Invariant (already enforced):** `scoreAtBar(candles, i)` passes `candles.slice(0, i + 1)` into `scoreChart`. Indicators (RSI, ATR, SMA, KST, Donchian, DeMark) operate only on that prefix. The horizon-walk loop uses bars `i+1..i+horizonBars` only for **fill simulation** (stop hit, horizon exit), never for **signal re-evaluation**.

**SHORT-side preservation:** the SHORT branch must reuse the exact same `scoreAtBar` call. The only difference is the *direction filter*: instead of `score.trend === "down"` being a rejection, it's a requirement, and instead of `score.score >= threshold` being acceptance for LONG, the equivalent symmetric gate fires (see §SHORT-side Extension).

**Test:** `tests/backtest/no-look-ahead.test.ts` asserts that — for a synthesized series where bars after a target index `i` are replaced with garbage values — `runStrategyOnSeries(realPrefix.concat(garbage), cfg)` produces an identical trade entry decision at index `i` as `runStrategyOnSeries(realPrefix, cfg)` would have produced. If garbage bars influence the entry decision, look-ahead has leaked.

### (b) Dynamic universe snapshot at fold start — the new risk (PRD §9.5)

**The threat model:** if the universe at fold-1-start (e.g. 2026-04-01) is computed using today's 24h volume rank, we silently smuggle "knowledge of which coins would later become the top-30" into the backtest. ZEC and HYPE both pumped in late 2025/early 2026 — naively including them in the fold-1 universe because they're top-30 *now* gives the strategy retroactive foresight.

**Mechanism:**

1. **Single source of truth for volume:** `rollingQuoteVolume24h(candles, asOfMs)` sums the `c.v` (quote volume — Blofin returns USDT-denominated at index 7, see `blofin.ts` line 131) of every candle with **close-time ≤ asOfMs**. Close-time = `t*1000 + 5*60*1000` (since `Candle.t` is in seconds; the candle closes 5 minutes later). Bars whose close-time exceeds `asOfMs` are **excluded** — that's the look-ahead boundary.

2. **24h window:** the last 288 bars (288 × 5min = 24h) ending at-or-before `asOfMs`. If fewer than 288 are available, the symbol gets a quote-vol of 0 and falls out of the top-30 for that fold. This protects against new listings biasing the early folds.

3. **Snapshot persistence:** `UniverseSnapshot` is computed once at fold-start and held constant for the whole train+test span of that fold. Symbols added or delisted mid-fold are NOT swapped in or out. This is intentional — it matches what a live trader would actually do (rebalance universe quarterly, not bar-by-bar).

4. **Cache cleanliness:** `data-fetcher.ts` never tags candles with "today's rank". The cache is pure OHLCV. Any rank-based filtering happens downstream in `universe.ts`, which is a pure function of (series, asOfMs, N).

5. **What we DO NOT use:** Blofin's live `/api/v1/market/tickers` `volCurrencyQuote24h` field. That returns *today's* 24h volume — using it would be exactly the bias we're avoiding. The `BLOFIN_TOP30_ASSETS` constant in `src/whitelist.ts` is also **not** used as the universe — it's today's top-30, not the as-of-fold-start top-30.

**Test:** `tests/backtest/universe-snapshot.test.ts`:

- Fixture: two synthetic symbols `A` and `B`. `A` has 24h vol of 1000 from t=0 to t=T1, then explodes to 10000 from t=T1 onward. `B` is steady at 5000.
- Assert: `buildUniverseSnapshot(..., asOfMs = T1 - 1ms, topN=1).selected === ["B"]` (A's pump hasn't happened yet).
- Assert: `buildUniverseSnapshot(..., asOfMs = T1 + 24h, topN=1).selected === ["A"]` (rolling vol now reflects the pump).
- Assert: the function is **deterministic** — running it 5x on the same input yields byte-identical `ranked` arrays.

### (c) Walk-forward fold boundaries

**Invariant:** the test period of fold `k` and the train period of fold `k+1` may overlap by design (rolling window), but **a single trade may not cross the train→test boundary inside one fold**. Concretely:

- For fold 1: trainStartMs=Jan 1, trainEndMs=Apr 1, testStartMs=Apr 1, testEndMs=May 1.
- A LONG trade entering on March 31 with a 12-bar horizon would close on April 1 → **belongs to train** (entry timestamp decides ownership).
- A LONG trade entering on April 1 00:00 → belongs to test, regardless of when it exits.

**Implementation:** `runWalkForward` slices the series twice per fold: once with `t < trainEndMs/1000` for the train run, once with `testStartMs/1000 <= t < testEndMs/1000` for the test run. **Warmup bars are pre-prepended to both** from the cached series (i.e., the test run receives `[warmup-bars-before-testStart, ...test-bars]` so indicators are warm at testStart). The first `warmupBars` of each slice are ineligible for entries (the existing engine already enforces this via `i < config.warmupBars` skip).

**Edge case — fold 4 (aggregate):** trains on months 1-3, tests on months 4-6. Sanity check only — its expectancy should approximately equal the weighted mean of fold-1-test, fold-2-test, fold-3-test. Material divergence flags a bug.

**Test:** `tests/backtest/fold-boundaries.test.ts`:

- Synthesize a series with a guaranteed-firing signal at exactly `trainEndMs - 1bar` and another at exactly `testStartMs`.
- Run fold 1. Assert: the first trade appears in `trainTrades` and not `testTrades`. The second appears in `testTrades` and not `trainTrades`. Neither is duplicated.

---

## SHORT-side Extension

### R-math symmetry

```ts
// LONG (existing)
const initialRisk = entryPrice - stopPrice;       // positive
const realizedPnl = exitPrice - entryPrice;       // positive when price rose
const rMultiple   = realizedPnl / initialRisk;

// SHORT (new)
const initialRisk = stopPrice - entryPrice;       // positive (stop is ABOVE entry)
const realizedPnl = entryPrice - exitPrice;       // positive when price fell
const rMultiple   = realizedPnl / initialRisk;
```

Stop placement: `stopPrice = entryPrice + config.stopAtrMult * atrValue` (versus `-` for LONG). Stop trigger uses `bar.h >= stopPrice` (versus `bar.l <= stopPrice` for LONG).

### Where the trend inversion happens

In `runStrategyOnSeries`, after `scoreAtBar` returns:

```ts
const isShort = (config.side ?? "LONG") === "SHORT";

if (isShort) {
  // Symmetric gate: enter SHORT when score is HIGH AND trend is DOWN.
  // The composite score is direction-agnostic in spirit — high score = strong setup.
  // The trend field provides the directional context.
  if (score.score < config.thresholdComposite) continue;
  if (score.trend !== "down") continue;
  // ... stage2 inverted: SHORT requires close < SMA(150)
} else {
  // existing LONG logic
  if (score.score < config.thresholdComposite) continue;
  if (score.trend === "down") continue;
  // existing stage2: close > SMA(150)
}
```

This matches the `scan-blofin.ts` convention (line 100-ish): SHORT requires `stage2=false` (close ≤ SMA(150)) and a bearish HTF trend. We reuse that semantics.

### Edge case — bearish bias + stage2-strict required

Question: signal fires with bearish bias (composite ≥ threshold, trend=down) but `requireStage2: true` is configured for a LONG run. What happens?

**Answer:** the LONG run rejects it (trend=down filter on line 107 of `backtest.ts`). The SHORT run for the same grid cell may accept it if stage2 (inverted) is satisfied. **The two sides are scored as independent grid cells** — they never share a trade. This is why §5.3 of the PRD lists `side` as a grid dimension: every other (thresholdComposite, requireStage2, ...) cell expands to two configs (`-LONG`, `-SHORT`), and each is evaluated independently.

**Important consequence:** `requireStage2: true` means something different per side:
- LONG: `close > SMA(150)` required (uptrend regime).
- SHORT: `close < SMA(150)` required (downtrend regime).

Both are "stage-2 aligned" in Weinstein terms (Stage 2 = uptrend, Stage 4 = downtrend; we reuse the flag for the SHORT-equivalent downtrend regime). Tester-morty asserts this in `tests/backtest/short-stage2.test.ts`.

### Backwards compatibility

The existing `scripts/backtest.ts` daily-LONG harness does not set `side`, so `config.side ?? "LONG"` keeps it on the LONG branch. No regression.

---

## Caching Layer

### Format: JSONL.gz (chosen over Parquet)

**Why JSONL.gz:**

1. **Zero deps.** Parquet in Node needs `parquetjs-lite` or `apache-arrow` — both are unmaintained-ish and add ~5MB. JSONL + `zlib` is built-in.
2. **Append-friendly for resume.** We can stream-append new bars to the gzip stream (concat-gzip is valid). Parquet requires rewriting metadata blocks.
3. **Human-debuggable.** `zcat BTC-USDT.5m.jsonl.gz | head` works in any terminal.
4. **Size budget is fine.** 6mo × 30 symbols × 52k bars × ~80 bytes/bar JSON ≈ 125 MB raw, ~25 MB gzipped. PRD §4 budgets ~150 MB. Comfortable.

**Why not raw JSONL:** 5x the disk, 5x the I/O time on cache-hit runs. Gzip CPU cost is negligible vs the backtest workload.

**Trade-off accepted:** Parquet would be faster to scan with columnar reads, but we only scan the file once per run (load into memory, then operate on the in-memory `Candle[]`). The win is moot.

### Directory layout

```
~/.cryptotrader-data/blofin-5m/
  BTC-USDT.5m.jsonl.gz
  ETH-USDT.5m.jsonl.gz
  ...
  _meta.json                # { lastFullFetchMs: 1717891200000, version: 1 }
```

One file per `instId`. The `_meta.json` records when the universe of files was last touched; not load-bearing, just for debug.

**File contents** — one JSON object per line, oldest-first:

```jsonl
{"t":1704067200,"o":42150.5,"h":42155.0,"l":42148.2,"c":42153.1,"v":125430.5}
{"t":1704067500,"o":42153.1,"h":42160.2,"l":42150.0,"c":42158.7,"v":98765.3}
```

`t` is unix **seconds** (matching the existing `Candle` convention from `indicators.ts`). `v` is quote volume (USDT-denominated, matching `blofin.ts:131`).

### Invalidation policy: none

Historical 5m bars are immutable. Blofin doesn't revise closed bars. So:

- **No TTL.** Cache hits are permanent for past bars.
- **No checksums.** If the user manually corrupts a file, the load step (Zod-validate each row) will catch it; corrupted file → re-fetch that symbol from scratch.

Exception: the **most recent ~5 bars** of any series fetched today may be incomplete (current bar hasn't closed). The fetcher truncates the series to the last bar whose Blofin `confirm === "1"` flag is set, or — since `blofin.ts:getNativeCandles` strips that flag — drops the final bar if its `t*1000 + 5*60*1000 > Date.now() - 30s`. Safer than trying to decide bar-by-bar.

### Partial fetches & resume

Blofin caps each `/market/candles` call at 1440 bars (PRD §4 says 52k/symbol = ~36 calls/symbol). The fetcher:

1. Calls `loadCachedSeries(instId)`. If exists, finds `last.t` in the cache.
2. Computes the gap `[last.t*1000 + 5*60*1000, toMs)`.
3. Issues paginated calls using Blofin's `after=<ms>` cursor (newest-first internally), pages until the gap is filled.
4. Streams-appends to the gzip file as each page arrives. **A crashed run leaves a consistent partial file** — the next run picks up where it stopped.
5. Same logic for backfilling earlier-than-cached bars via the `before=<ms>` cursor (rarely needed; usually we only extend forward).

Rate limit: 5 req/sec (`opts.rateLimitRps = 5` default), with exponential backoff on 429 (which Blofin returns rarely). 36 calls × 30 symbols / 5 rps ≈ 3.6 minutes worst case. Cache hits on rerun → 0 calls.

**Blofin client extension required:** the current `getNativeCandles` doesn't accept `before`/`after`. backend-morty must either extend it (preferred — single source of truth) or implement the cursor logic in `data-fetcher.ts`. We recommend extending `getNativeCandles` to accept `{ before?: number; after?: number; limit?: number }`.

---

## Test Strategy

All under `/Users/elmo.asmussen/Projects/Crypto/tests/backtest/`. Vitest, matching the existing project convention. Each test file gets its own fixture; no global state.

### Test files

| File | Invariant asserted | Fixtures |
|---|---|---|
| `tests/backtest/no-look-ahead.test.ts` | Replacing future bars with garbage does not change entry decisions at any historical index. SHORT and LONG both tested. | `tests/backtest/fixtures/synth-trend-up-200.json` (200 bars, deterministic uptrend) |
| `tests/backtest/short-r-math.test.ts` | A controlled SHORT trade where price falls 2× the initial risk yields `rMultiple === 2`. Mirror LONG control case. Stop-out yields `rMultiple === -1` exactly. | `tests/backtest/fixtures/synth-shortable-down.json` |
| `tests/backtest/short-stage2.test.ts` | SHORT side with `requireStage2: true` rejects entries where close > SMA(150). LONG side with same flag rejects entries where close < SMA(150). | reuses `synth-trend-up-200` and a flipped `synth-trend-down-200` |
| `tests/backtest/fold-boundaries.test.ts` | `defineFolds(jan1, jul1)` returns 4 folds with the expected timestamps; a guaranteed-firing signal exactly on `trainEndMs` belongs to train; one on `testStartMs` belongs to test; no trade is double-counted. | `tests/backtest/fixtures/synth-fold-pulse.json` (signal pulses at fold edges) |
| `tests/backtest/universe-snapshot.test.ts` | Volume-rank uses only bars closed before `asOfMs`. New-listing symbols (<288 bars) get vol=0. Tie-break is deterministic (instId asc). Same input → byte-identical output. | inline synth — two symbols, scripted volume pumps |
| `tests/backtest/metrics.test.ts` | Sharpe of all-zeros = 0 (not NaN). Profit factor of all-wins = Infinity. Concentration kill-switch trips at share > 0.50, not at 0.50. `isOosDelta` returns 0 when IS=OOS=0, returns ~0.5 when IS=2 and OOS=1. | inline |
| `tests/backtest/grid.test.ts` | `expandGrid` size matches the Cartesian product. `configId` is unique per cell. Ordering is stable across runs. | inline grid specs |
| `tests/backtest/data-fetcher.test.ts` | Cache round-trip: write 100 bars → reload → identical. Partial-fetch: cache has bars 0..50, request 0..100 → fetcher requests only 50..100. Mock the Blofin client via `vi.mock`. | mocked `getNativeCandles` |
| `tests/backtest/reporter.test.ts` | Markdown output contains the required sections (per-config table, IS/OOS delta column, certified-config JSON block when one qualifies). Snapshot test on a small fixture. | a fixture `WalkForwardResult[]` with 3 configs, one certified, one overfit, one no-trades |
| `tests/backtest/integration-smoke.test.ts` | 1 symbol, 5000 bars, 2 configs, 1 fold, end-to-end: no throws, results.length=2, at least one of (`oosMeanExpectancy != 0`, `folds[0].testTrades.length > 0`). Smoke only — not a correctness test. | `tests/backtest/fixtures/btc-5m-5000bars.json` (real Blofin sample, committed to repo for reproducibility) |

### Fixtures policy

- Synthetic fixtures: JSON, committed, generated once by a tester-morty helper script (kept under `tests/backtest/fixtures/`).
- Real-data fixture: one 5000-bar BTC-USDT snippet, committed (~400KB gzipped). Lets the smoke test run without network.

### CI gate

`npm test` must run all of the above. The PRD §8 definition-of-done lists "all unit tests pass" as a hard requirement.

---

## Risks / Open Questions

Things flagged for Rick's call before backend-morty starts coding. Not gripes — just real ambiguities that, if I silently picked one path, would bite us later.

### Q1 — Compute budget vs grid size (likely real)

PRD §4 budgets 4 hours; §5.3 admits the full 288-config grid may not fit and proposes trimming `horizonBars` to `[36, 144]` → 192 configs. We should pre-trim. Each config × 4 folds × ~30 symbols × ~52k bars × scoreChart-per-bar = the cost driver. Recommend:

- **Stage 1 (smoke):** 4 configs (2 LONG + 2 SHORT, anchor cells), 3 folds, 5 symbols → < 5 min. Catches integration bugs before burning hours.
- **Stage 2 (real run):** trim to 96 configs by dropping `cooldownBars` to `[72]` only (1 value), keeping `horizonBars: [36, 144]`. 4 × 2 × 3 × 2 × 1 × 2 = 96.
- If even 96 doesn't fit, drop `stopAtrMult` to `[1.5, 2.5]` → 64 configs.

**Decision needed from Rick:** confirm stage-1 smoke before stage-2? Or one-shot?

### Q2 — `scoreChart` invocation cost on 5m bars (potential blocker)

`scoreChart` walks every closed candle pattern, every chart pattern, KST, DeMark, Connors setups, breakout detector, etc. Originally calibrated for daily bars (250-500 of them). On 5m × 6mo × 30 symbols × 4 folds × 96 configs = ~6 × 10^9 `scoreChart` calls. **This will not finish in 4 hours.**

Mitigation options, in order of preference:

1. **Memoize per-bar score per symbol** — `scoreChart`'s output depends only on `candles[0..i]`, not on `config`. So across the 96 configs for one symbol, score-per-bar is recomputed 96× redundantly. Cache `scoreAtBar(symbol, i) -> { score, trend, hasBreakout }` once per (symbol, fold) and reuse across configs. **~96× speedup.** This is the single highest-leverage optimization.
2. **Skip bars where score can't possibly trigger** — coarse pre-filter using cheap indicators (RSI, ATR) before invoking full `scoreChart`. Risky (correctness hazard). Skip for v2.
3. **Parallel workers** — Node worker threads, one per symbol. 8-10× on M-series. Worth doing.

**Decision needed:** add memoization to the architecture explicitly? I lean **yes** — propose introducing a `src/backtest/score-cache.ts` module (per-symbol per-bar score cache, populated once before the grid sweep). This is a non-trivial addition to the module map. Wanted to flag before silently inflating scope.

### Q3 — Per-bar entries: 5m bars compound the cooldown problem

On daily bars, `cooldownBars: 5` means "no entries for 5 days." On 5m bars, `cooldownBars: 12` means "no entries for 1 hour." 6 months × 30 symbols × at-most-one-trade-per-hour = bounded trade count, but in practice the engine could generate **thousands of trades per config** if the threshold is low. This isn't a bug, but it inflates the report size and stresses the `BacktestTrade[]` memory footprint (~10-30k trades × 96 configs × 4 folds = 12M trade objects worst case, ~2-4 GB RAM).

Mitigation: stream-summarize per fold rather than holding all trades. Or: only retain trades for the top-10 configs (by OOS expectancy) for the report; discard the rest after `summarize`.

**Decision needed:** confirm we're OK with the "discard trades after summarize for non-top configs" approach? Otherwise we need streaming aggregation.

### Q4 — Symbol-tagging of trades (interface gap)

`BacktestTrade` has no `symbol` field. The existing `summarize` doesn't need one. But the per-symbol concentration check (PRD §4) and per-symbol breakdown require it. I scoped this as "tag at the walk-forward layer with a wrapper type `BacktestTrade & { symbol: string }`" — that keeps the core engine pure. Alternative: add `symbol?: string` to `BacktestTrade` itself.

**My recommendation:** wrapper type. Keeps `src/analysis/backtest.ts` change minimal (just `side` widening) and avoids cascading optional-fields through the core engine.

### Q5 — Fees and slippage application point

PRD §9.3-§9.4 lock 0.06% taker + 1bp slippage entry/exit. **Where does this get applied?**

Options:
- (a) Inside `runStrategyOnSeries` — modifies the core engine permanently.
- (b) Post-trade in `metrics.ts` — adjust `rMultiple` after the fact via `realizedPnl -= fees*entry + fees*exit + slippage*entry + slippage*exit`, scaled by initial risk.

**My recommendation:** (b). The core engine stays unaware of trading costs (good for unit testing the signal logic in isolation); the metrics layer applies a `applyCosts(trade, costModel)` transform. This also makes it trivial to A/B test cost models later.

**Decision needed:** confirm (b)? If Rick wants (a), the core engine extension is larger than scoped.

### Q6 — "Universe per fold" but data-fetch is universe-blind

If universe is dynamic, we don't know which symbols will be in fold-1's top-30 until we've fetched everyone's 5m bars (to compute as-of-volume). So `data-fetcher.ts` must fetch a **superset** — every Blofin perp with sufficient liquidity at present. With ~250 active perps on Blofin, that's 250 × 150MB/30 = ~1.25 GB raw / ~250 MB gzipped. Manageable, but blows past the PRD's "~150 MB" estimate (which assumed only top-30).

Mitigations:
- (a) Pre-filter using the current top-50 (slightly bigger than 30 to allow for fold-by-fold drift) and accept that very-late-listed pumpers won't be tested.
- (b) Fetch all 250, accept 250 MB disk.

**Recommendation:** (a) — fetch the union of (today's BLOFIN_TOP30_ASSETS, today's #31-50). 50 symbols × 6mo of 5m bars × 80 bytes gz ≈ 42 MB. Good enough; pragmatic. Per-fold universe selection still happens correctly (uses past data only); we just bound the candidate pool to a stable superset.

**Decision needed:** confirm (a)?

---

## Sequencing for parallel implementation

After Rick's resolves Q1-Q6, backend-morty and tester-morty can work in parallel under the contract in `INTEGRATION_CONTRACT.md`. Suggested order:

1. backend-morty starts on `src/analysis/backtest.ts` SHORT extension (it's a prereq for everything else) + `src/backtest/grid.ts` + `src/backtest/metrics.ts` (pure, no I/O — easy first wins).
2. tester-morty starts on fixtures + the no-look-ahead, short-r-math, fold-boundaries, universe-snapshot, metrics tests. These don't need backend-morty's `data-fetcher.ts` or `walk-forward.ts` to compile (just the type signatures defined above).
3. backend-morty then writes `data-fetcher.ts` and `universe.ts`.
4. backend-morty writes `walk-forward.ts` and the orchestrator.
5. tester-morty fills in integration smoke once `walk-forward.ts` exists.
6. backend-morty writes `reporter.ts` last.
7. integration-morty merges, runs full test suite, runs smoke backtest, certifies.
