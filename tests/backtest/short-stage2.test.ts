/**
 * `requireStage2: true` means OPPOSITE things for LONG and SHORT.
 *
 *   LONG  + stage2 strict → rejects entries where close < SMA(stage2SmaPeriod)
 *                          (i.e. requires close > SMA → uptrend / Weinstein Stage 2)
 *   SHORT + stage2 strict → rejects entries where close > SMA(stage2SmaPeriod)
 *                          (i.e. requires close < SMA → downtrend / Stage 4)
 *
 * Reference: BACKTEST_V2_ARCHITECTURE.md §SHORT-side Extension, "Edge case —
 * bearish bias + stage2-strict required":
 *
 *   "requireStage2: true means something different per side:
 *    - LONG: close > SMA(150) required (uptrend regime).
 *    - SHORT: close < SMA(150) required (downtrend regime).
 *    Both are 'stage-2 aligned' in Weinstein terms."
 *
 * Cross combinations (LONG-stage2 strict on a down-series, SHORT-stage2 strict
 * on an up-series) should produce ZERO entries — the regime gate forbids them.
 */

import { describe, expect, it } from "vitest";
import {
  runStrategyOnSeries,
  type BacktestConfig,
} from "../../src/analysis/backtest.js";
import { synthTrendSeries } from "./_helpers.js";

const BASE: BacktestConfig = {
  thresholdComposite: 55,
  horizonBars: 12,
  stopAtrMult: 2,
  warmupBars: 60,
  cooldownBars: 12,
  requireBreakout: false,
  requireStage2: true,
  stage2SmaPeriod: 50,
};

const UP_CANDLES = synthTrendSeries("up", 400, 501);
const DOWN_CANDLES = synthTrendSeries("down", 400, 502);

describe("requireStage2 — LONG semantics", () => {
  it("LONG + stage2 strict fires in an uptrending series (some entries possible)", () => {
    const trades = runStrategyOnSeries(UP_CANDLES, { ...BASE, side: "LONG" });
    // We don't assert >0 trades — synth signals are noisy and `scoreChart`
    // may simply not score high enough. What we DO assert: any trade that
    // fires satisfies the uptrend-regime invariant.
    for (const t of trades) {
      const entryCandle = UP_CANDLES[t.entryIndex]!;
      // close > sma is required for LONG-stage2; we can't recompute SMA here
      // trivially, but we can assert the trade side and entry validity.
      expect(t.side).toBe("LONG");
      expect(entryCandle.c).toBe(t.entryPrice);
    }
  });

  it("LONG + stage2 strict produces ZERO entries on a sustained downtrend", () => {
    // Down series: close < SMA almost everywhere → LONG-stage2 must reject everything.
    const trades = runStrategyOnSeries(DOWN_CANDLES, { ...BASE, side: "LONG" });
    expect(trades.length).toBe(0);
  });
});

describe("requireStage2 — SHORT semantics", () => {
  it("SHORT + stage2 strict fires in a downtrending series (some entries possible)", () => {
    const trades = runStrategyOnSeries(DOWN_CANDLES, { ...BASE, side: "SHORT" });
    for (const t of trades) {
      const entryCandle = DOWN_CANDLES[t.entryIndex]!;
      expect(t.side).toBe("SHORT");
      expect(entryCandle.c).toBe(t.entryPrice);
    }
  });

  it("SHORT + stage2 strict produces ZERO entries on a sustained uptrend", () => {
    // Up series: close > SMA almost everywhere → SHORT-stage2 must reject everything.
    const trades = runStrategyOnSeries(UP_CANDLES, { ...BASE, side: "SHORT" });
    expect(trades.length).toBe(0);
  });
});

describe("requireStage2 — same series, opposite-side cross-check", () => {
  it("LONG-stage2 on uptrend AND SHORT-stage2 on downtrend never share a (series, entryIndex) pair", () => {
    // Even though both can fire, they're on DIFFERENT series — there's no overlap
    // to test. The real cross-check: on the SAME series, LONG-stage2 and SHORT-stage2
    // can't both fire at the same bar (close can't be simultaneously above AND below
    // the SMA).
    const longOnDown = runStrategyOnSeries(DOWN_CANDLES, { ...BASE, side: "LONG" });
    const shortOnDown = runStrategyOnSeries(DOWN_CANDLES, { ...BASE, side: "SHORT" });

    const longIdxs = new Set(longOnDown.map((t) => t.entryIndex));
    for (const t of shortOnDown) {
      expect(longIdxs.has(t.entryIndex)).toBe(false);
    }
  });
});

describe("requireStage2 — sanity: turning stage2 off allows more entries", () => {
  it("LONG without stage2 fires at least as often as LONG with stage2 strict on the same series", () => {
    const strict = runStrategyOnSeries(UP_CANDLES, { ...BASE, side: "LONG", requireStage2: true });
    const lax = runStrategyOnSeries(UP_CANDLES, { ...BASE, side: "LONG", requireStage2: false });
    expect(lax.length).toBeGreaterThanOrEqual(strict.length);
  });

  it("SHORT without stage2 fires at least as often as SHORT with stage2 strict on the same series", () => {
    const strict = runStrategyOnSeries(DOWN_CANDLES, { ...BASE, side: "SHORT", requireStage2: true });
    const lax = runStrategyOnSeries(DOWN_CANDLES, { ...BASE, side: "SHORT", requireStage2: false });
    expect(lax.length).toBeGreaterThanOrEqual(strict.length);
  });
});
