/**
 * Per-fold universe selection — rolling 24h quote-volume rank from cached 5m
 * bars, computed as-of `asOfMs` (the fold-start timestamp). This is the
 * single thing that protects us from look-ahead bias when the universe is
 * dynamic.
 *
 * PURE: no I/O, no clocks, no randomness. Same inputs → byte-identical
 * outputs across runs. Tester-morty asserts this in
 * `tests/backtest/universe-snapshot.test.ts`.
 *
 * Look-ahead invariant (per ARCHITECTURE.md §Look-ahead Bias Audit (b)):
 *   - We sum `c.v` (quote volume — USDT-denominated, see `blofin.ts:131`) of
 *     each candle whose **close-time** (`t*1000 + 5*60*1000`) is `<= asOfMs`.
 *   - Candles whose close-time exceeds `asOfMs` are EXCLUDED.
 *   - The window is the LAST 288 bars (288 × 5min = 24h) that satisfy the
 *     above. If the symbol has < 288 such bars, quoteVol is 0 and it drops
 *     out of the top-N.
 *   - Tie-break in `buildUniverseSnapshot.ranked`: instId ascending (so the
 *     output is byte-identical across runs).
 *
 * Companion docs:
 * - docs/BACKTEST_HARNESS_V2_PRD.md §9.5
 * - docs/BACKTEST_V2_ARCHITECTURE.md §universe.ts
 */

import type { Candle } from "../analysis/indicators.js";
import type { CachedSeries } from "./data-fetcher.js";

/** 24h of 5m bars. */
const BARS_PER_24H = 288;
/** 5-minute bar length in ms. */
const BAR_MS = 5 * 60 * 1000;

export interface UniverseSnapshot {
  /** Bar timestamp (ms, inclusive) at which the snapshot is taken — the fold-start. */
  asOfMs: number;
  /** Symbols ranked desc by 24h trailing quote volume as of asOfMs. Tie-break: instId asc. */
  ranked: Array<{ instId: string; quoteVol24h: number }>;
  /** First `topN` of `ranked`. */
  selected: string[];
}

/**
 * Sum the quote-volume (`c.v`) of the LAST 288 candles whose close-time
 * (`t*1000 + BAR_MS`) is `<= asOfMs`.
 *
 * Returns 0 if fewer than 288 such candles exist (new listings shouldn't bias
 * the early folds).
 *
 * Implementation note: we assume `candles` is oldest-first (matches the
 * `CachedSeries.candles` invariant). We walk the tail backward, collecting up
 * to 288 eligible bars; if we run out before hitting 288, return 0.
 */
export function rollingQuoteVolume24h(
  candles: readonly Candle[],
  asOfMs: number,
): number {
  if (candles.length < BARS_PER_24H) return 0;

  // Find the last index whose close-time is <= asOfMs. Candles are
  // oldest-first, so walk from the end and break on the first eligible bar.
  let lastEligibleIdx = -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    const closeMs = candles[i]!.t * 1000 + BAR_MS;
    if (closeMs <= asOfMs) {
      lastEligibleIdx = i;
      break;
    }
  }
  if (lastEligibleIdx < BARS_PER_24H - 1) return 0;

  let sum = 0;
  for (let i = lastEligibleIdx - BARS_PER_24H + 1; i <= lastEligibleIdx; i++) {
    sum += candles[i]!.v;
  }
  return sum;
}

/**
 * Build the per-fold universe. PURE: no clocks, no I/O.
 *
 * Determinism contract:
 *   - Primary sort: `quoteVol24h` desc.
 *   - Tie-break: `instId` asc (ASCII byte order).
 *   - Symbols with `quoteVol24h === 0` keep their slot in `ranked` (so the
 *     full input set is visible to the reporter) but fall to the bottom.
 *   - `selected` = first `topN` of `ranked`. If `topN > ranked.length`,
 *     `selected = ranked.map(r => r.instId)` (no padding).
 */
export function buildUniverseSnapshot(
  seriesBySymbol: Readonly<Record<string, CachedSeries>>,
  asOfMs: number,
  topN: number,
): UniverseSnapshot {
  const instIds = Object.keys(seriesBySymbol).sort(); // stable iteration order
  const scored: Array<{ instId: string; quoteVol24h: number }> = instIds.map((id) => ({
    instId: id,
    quoteVol24h: rollingQuoteVolume24h(seriesBySymbol[id]!.candles, asOfMs),
  }));

  // Sort by volume desc; tie-break by instId asc.
  scored.sort((a, b) => {
    if (b.quoteVol24h !== a.quoteVol24h) return b.quoteVol24h - a.quoteVol24h;
    return a.instId < b.instId ? -1 : a.instId > b.instId ? 1 : 0;
  });

  const n = Math.max(0, Math.floor(topN));
  const selected = scored.slice(0, n).map((r) => r.instId);

  return {
    asOfMs,
    ranked: scored,
    selected,
  };
}
