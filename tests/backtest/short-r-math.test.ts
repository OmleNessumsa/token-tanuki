/**
 * SHORT-side R-math invariants.
 *
 * R-math symmetry (from BACKTEST_V2_ARCHITECTURE.md §SHORT-side Extension):
 *
 *   LONG:  initialRisk = entry - stop;  realizedPnl = exit - entry;   R = pnl / risk
 *   SHORT: initialRisk = stop - entry;  realizedPnl = entry - exit;   R = pnl / risk
 *
 * Stop trigger: SHORT uses `bar.h >= stopPrice` (versus `bar.l <= stopPrice` for LONG).
 *
 * We assert TWO things:
 *
 * 1. For every trade produced by runStrategyOnSeries with side="SHORT",
 *    the trade's `rMultiple` matches a freshly-recomputed expected value
 *    derived from entry/exit/stop in the trade itself. Same for LONG.
 *    If the engine produces an R different from the closed-form formula
 *    by even 0.01, the test fails.
 *
 * 2. A stop-out yields exactly rMultiple == -1, on both sides. This is
 *    the simplest, most load-bearing invariant — get this wrong and the
 *    whole harness lies.
 */

import { describe, expect, it } from "vitest";
import {
  runStrategyOnSeries,
  type BacktestConfig,
  type BacktestTrade,
} from "../../src/analysis/backtest.js";
import { synthTrendSeries } from "./_helpers.js";

const BASE_CONFIG: BacktestConfig = {
  thresholdComposite: 55,
  horizonBars: 12,
  stopAtrMult: 2,
  warmupBars: 60,
  cooldownBars: 12,
  requireBreakout: false,
  requireStage2: false,
  stage2SmaPeriod: 50,
};

function expectedR(trade: BacktestTrade): number {
  if (trade.side === "SHORT") {
    const initialRisk = trade.stopPrice - trade.entryPrice;
    const realizedPnl = trade.entryPrice - trade.exitPrice;
    return realizedPnl / initialRisk;
  }
  const initialRisk = trade.entryPrice - trade.stopPrice;
  const realizedPnl = trade.exitPrice - trade.entryPrice;
  return realizedPnl / initialRisk;
}

describe("SHORT R-math — engine output matches closed-form formula", () => {
  it("every SHORT trade has rMultiple === (entry - exit) / (stop - entry) within 1e-9", () => {
    const candles = synthTrendSeries("down", 400, 101);
    const trades = runStrategyOnSeries(candles, { ...BASE_CONFIG, side: "SHORT" });

    // We don't insist on a specific trade count here — synth signals are noisy.
    // The point: whatever fires, the math is right.
    for (const t of trades) {
      expect(t.side).toBe("SHORT");
      // Initial risk must be positive (stop > entry for SHORT).
      expect(t.stopPrice).toBeGreaterThan(t.entryPrice);
      const expected = expectedR(t);
      expect(t.rMultiple).toBeCloseTo(expected, 9);
    }
  });

  it("every LONG trade has rMultiple === (exit - entry) / (entry - stop) within 1e-9", () => {
    const candles = synthTrendSeries("up", 400, 102);
    const trades = runStrategyOnSeries(candles, { ...BASE_CONFIG, side: "LONG" });

    for (const t of trades) {
      expect(t.side).toBe("LONG");
      expect(t.entryPrice).toBeGreaterThan(t.stopPrice);
      const expected = expectedR(t);
      expect(t.rMultiple).toBeCloseTo(expected, 9);
    }
  });
});

describe("SHORT R-math — stop-out yields exactly rMultiple == -1", () => {
  it("every SHORT trade that exits via stop has rMultiple === -1 exactly", () => {
    const candles = synthTrendSeries("down", 400, 201);
    const trades = runStrategyOnSeries(candles, { ...BASE_CONFIG, side: "SHORT" });

    const stopped = trades.filter((t) => t.exitReason === "stop");
    for (const t of stopped) {
      // exitPrice == stopPrice → R == -(stop - entry) / (stop - entry) == -1
      expect(t.exitPrice).toBe(t.stopPrice);
      expect(t.rMultiple).toBe(-1);
    }
  });

  it("every LONG trade that exits via stop has rMultiple === -1 exactly", () => {
    const candles = synthTrendSeries("up", 400, 202);
    const trades = runStrategyOnSeries(candles, { ...BASE_CONFIG, side: "LONG" });

    const stopped = trades.filter((t) => t.exitReason === "stop");
    for (const t of stopped) {
      expect(t.exitPrice).toBe(t.stopPrice);
      expect(t.rMultiple).toBe(-1);
    }
  });
});

describe("SHORT R-math — sign symmetry with LONG", () => {
  it("R-multiple magnitude is not affected by side — only the sign of `pnl` is", () => {
    // Synthesize two mirror-image series. The R distribution magnitudes
    // should be in the same ballpark — not byte-equal (different randomness),
    // but the absolute-value statistics should be order-of-magnitude similar.
    // We assert the weaker but always-true invariant: stop-outs are -1 on
    // both sides, and "winners" are positive on both sides.
    const upCandles = synthTrendSeries("up", 400, 301);
    const downCandles = synthTrendSeries("down", 400, 301);

    const longTrades = runStrategyOnSeries(upCandles, { ...BASE_CONFIG, side: "LONG" });
    const shortTrades = runStrategyOnSeries(downCandles, { ...BASE_CONFIG, side: "SHORT" });

    for (const t of longTrades.filter((x) => x.exitReason === "horizon")) {
      // For a horizon LONG winner, exit > entry → rMultiple > 0.
      if (t.exitPrice > t.entryPrice) expect(t.rMultiple).toBeGreaterThan(0);
      if (t.exitPrice < t.entryPrice) expect(t.rMultiple).toBeLessThan(0);
    }
    for (const t of shortTrades.filter((x) => x.exitReason === "horizon")) {
      // For a horizon SHORT winner, exit < entry → rMultiple > 0.
      if (t.exitPrice < t.entryPrice) expect(t.rMultiple).toBeGreaterThan(0);
      if (t.exitPrice > t.entryPrice) expect(t.rMultiple).toBeLessThan(0);
    }
  });
});

describe("SHORT R-math — initial risk magnitude is symmetric to LONG given same ATR", () => {
  // Same stopAtrMult should yield equal-magnitude initial-risk in price units
  // (modulo floating-point) for matching candles, since ATR is direction-agnostic.
  // We can't easily compare apples-to-apples without identical entries, but we
  // CAN assert each side's initialRisk is positive and finite.
  it("all SHORT trades have a strictly positive initial risk", () => {
    const candles = synthTrendSeries("down", 400, 401);
    const trades = runStrategyOnSeries(candles, { ...BASE_CONFIG, side: "SHORT" });
    for (const t of trades) {
      const initialRisk = t.stopPrice - t.entryPrice;
      expect(initialRisk).toBeGreaterThan(0);
      expect(Number.isFinite(initialRisk)).toBe(true);
    }
  });

  it("all LONG trades have a strictly positive initial risk", () => {
    const candles = synthTrendSeries("up", 400, 402);
    const trades = runStrategyOnSeries(candles, { ...BASE_CONFIG, side: "LONG" });
    for (const t of trades) {
      const initialRisk = t.entryPrice - t.stopPrice;
      expect(initialRisk).toBeGreaterThan(0);
      expect(Number.isFinite(initialRisk)).toBe(true);
    }
  });
});
