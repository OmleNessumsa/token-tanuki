/**
 * metrics.ts — pure function invariants.
 *
 * Edge cases that have bitten past projects (NaN-from-empty-input being the
 * usual culprit) get explicit assertions. Concentration kill-switch is
 * STRICT GREATER-THAN 0.50, not >=.
 *
 * Signatures from BACKTEST_V2_ARCHITECTURE.md §metrics.ts and
 * INTEGRATION_CONTRACT.md §Type signatures backend-morty MUST export.
 */

import { describe, expect, it } from "vitest";
import {
  sharpe,
  profitFactor,
  symbolConcentration,
  isOosDelta,
  applyCosts,
  DEFAULT_COST_MODEL,
} from "../../src/backtest/metrics.js";
import type { BacktestTrade } from "../../src/analysis/backtest.js";

// ---------------------------------------------------------------------------
// Trade fixture helpers.
// ---------------------------------------------------------------------------

function trade(
  overrides: Partial<BacktestTrade> & { symbol?: string } = {},
): BacktestTrade & { symbol: string } {
  return {
    entryIndex: 0,
    exitIndex: 1,
    entryPrice: 100,
    exitPrice: 100,
    stopPrice: 95,
    rMultiple: 0,
    exitReason: "horizon",
    composite: 60,
    side: "LONG",
    symbol: "BTC-USDT",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sharpe()
// ---------------------------------------------------------------------------

describe("sharpe — edge cases never return NaN", () => {
  it("returns 0 for an empty distribution", () => {
    expect(sharpe([])).toBe(0);
  });

  it("returns 0 for an all-zeros distribution (no variance)", () => {
    const result = sharpe([0, 0, 0, 0]);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(0);
  });
});

describe("sharpe — sign correctness", () => {
  it("returns a positive number for a series of all-positive R", () => {
    const result = sharpe([1, 1, 1, 1, 1]);
    // Mean / stddev: with identical values, stddev is 0 → guard kicks in.
    // The intent of the test: "doesn't return negative or NaN."
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("returns a positive Sharpe for a noisy-but-positive distribution", () => {
    const result = sharpe([0.5, 1.0, 0.3, 0.8, 1.2, 0.4]);
    expect(result).toBeGreaterThan(0);
  });

  it("returns a negative Sharpe for an all-losses distribution", () => {
    const result = sharpe([-0.5, -1.0, -0.3, -0.8, -1.2, -0.4]);
    expect(result).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// profitFactor()
// ---------------------------------------------------------------------------

describe("profitFactor — edge cases", () => {
  it("returns 0 for an empty trade array (NOT NaN)", () => {
    const pf = profitFactor([]);
    expect(Number.isNaN(pf)).toBe(false);
    expect(pf).toBe(0);
  });

  it("returns Infinity for all-wins (no losses)", () => {
    const trades = [trade({ rMultiple: 1 }), trade({ rMultiple: 2 }), trade({ rMultiple: 0.5 })];
    expect(profitFactor(trades)).toBe(Infinity);
  });

  it("returns 0 for all-losses (no wins)", () => {
    const trades = [trade({ rMultiple: -1 }), trade({ rMultiple: -2 }), trade({ rMultiple: -0.5 })];
    expect(profitFactor(trades)).toBe(0);
  });

  it("returns the expected ratio for a mixed distribution", () => {
    // sum(wins) = 3, sum(|losses|) = 1 → PF = 3
    const trades = [
      trade({ rMultiple: 2 }),
      trade({ rMultiple: 1 }),
      trade({ rMultiple: -1 }),
    ];
    expect(profitFactor(trades)).toBeCloseTo(3, 9);
  });
});

// ---------------------------------------------------------------------------
// symbolConcentration() — kill-switch STRICTLY > 0.50
// ---------------------------------------------------------------------------

describe("symbolConcentration — kill-switch boundary", () => {
  it("does NOT trip at exactly share == 0.50", () => {
    // Two symbols, equal R. Each share = 0.50.
    const trades = [
      trade({ symbol: "AAA", rMultiple: 1 }),
      trade({ symbol: "BBB", rMultiple: 1 }),
    ];
    const report = symbolConcentration(trades);
    expect(report.killSwitchTripped).toBe(false);
    expect(report.bySymbol.find((b) => b.symbol === "AAA")?.share).toBeCloseTo(0.5, 9);
  });

  it("TRIPS when share strictly exceeds 0.50", () => {
    // AAA gets 0.6 / 1.0 = 60 %; BBB gets 40 %.
    const trades = [
      trade({ symbol: "AAA", rMultiple: 0.6 }),
      trade({ symbol: "BBB", rMultiple: 0.4 }),
    ];
    const report = symbolConcentration(trades);
    expect(report.killSwitchTripped).toBe(true);
  });

  it("TRIPS on a negative-share dominance (one symbol responsible for >50% of loss)", () => {
    // BBB share = -0.6 / 0.4 = -1.5 — |share| > 0.50.
    // Mixed sign means abs() matters for the kill-switch.
    const trades = [
      trade({ symbol: "AAA", rMultiple: 1 }),
      trade({ symbol: "BBB", rMultiple: -1.5 }),
    ];
    const report = symbolConcentration(trades);
    expect(report.killSwitchTripped).toBe(true);
  });

  it("handles empty input without exploding", () => {
    const report = symbolConcentration([]);
    expect(report.killSwitchTripped).toBe(false);
    expect(report.bySymbol).toEqual([]);
    expect(report.totalR).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isOosDelta()
// ---------------------------------------------------------------------------

describe("isOosDelta — defined for the corner cases", () => {
  it("isOosDelta(0, 0) returns 0 (NOT NaN)", () => {
    const d = isOosDelta(0, 0);
    expect(Number.isNaN(d)).toBe(false);
    expect(d).toBe(0);
  });

  it("isOosDelta(2, 1) === 0.5 (one-half divergence)", () => {
    expect(isOosDelta(2, 1)).toBeCloseTo(0.5, 9);
  });

  it("isOosDelta(-1, 1) === 2 (full sign-flip = 2× divergence)", () => {
    expect(isOosDelta(-1, 1)).toBeCloseTo(2, 9);
  });

  it("isOosDelta(x, x) === 0 for any nonzero x", () => {
    expect(isOosDelta(1.5, 1.5)).toBe(0);
    expect(isOosDelta(-3, -3)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyCosts() round-trip
// ---------------------------------------------------------------------------

describe("applyCosts — round-trip behavior", () => {
  it("a 0R trade (entry == exit) becomes slightly negative after fees+slippage", () => {
    // entry == exit, but the deduction still applies because round-trip
    // fees + slippage are charged on notional, not on PnL.
    const t0 = trade({
      entryPrice: 100,
      exitPrice: 100,
      stopPrice: 95, // initialRisk = 5
      rMultiple: 0,
    });
    const adjusted = applyCosts(t0, DEFAULT_COST_MODEL);
    expect(adjusted.rMultiple).toBeLessThan(0);
    // (100 + 100) * (0.0006 + 0.0001) / 5 = 200 * 0.0007 / 5 = 0.028
    expect(adjusted.rMultiple).toBeCloseTo(-0.028, 6);
  });

  it("a +2R clean trade becomes slightly less than +2R", () => {
    // Initial risk = 5; +2R means exit = entry + 10 = 110.
    const t0 = trade({
      entryPrice: 100,
      exitPrice: 110,
      stopPrice: 95,
      rMultiple: 2,
    });
    const adjusted = applyCosts(t0, DEFAULT_COST_MODEL);
    expect(adjusted.rMultiple).toBeLessThan(2);
    expect(adjusted.rMultiple).toBeGreaterThan(1.9);
    // (100 + 110) * 0.0007 / 5 = 210 * 0.0007 / 5 = 0.0294 → R becomes ~1.9706
    expect(adjusted.rMultiple).toBeCloseTo(2 - 0.0294, 6);
  });

  it("does not mutate the input trade", () => {
    const t0 = trade({ entryPrice: 100, exitPrice: 110, stopPrice: 95, rMultiple: 2 });
    const original = t0.rMultiple;
    applyCosts(t0, DEFAULT_COST_MODEL);
    expect(t0.rMultiple).toBe(original);
  });

  it("preserves all non-rMultiple fields on the returned trade", () => {
    const t0 = trade({
      entryIndex: 42,
      exitIndex: 54,
      entryPrice: 100,
      exitPrice: 110,
      stopPrice: 95,
      rMultiple: 2,
      composite: 73,
      side: "LONG",
      exitReason: "horizon",
    });
    const adjusted = applyCosts(t0, DEFAULT_COST_MODEL);
    expect(adjusted.entryIndex).toBe(t0.entryIndex);
    expect(adjusted.exitIndex).toBe(t0.exitIndex);
    expect(adjusted.entryPrice).toBe(t0.entryPrice);
    expect(adjusted.exitPrice).toBe(t0.exitPrice);
    expect(adjusted.stopPrice).toBe(t0.stopPrice);
    expect(adjusted.composite).toBe(t0.composite);
    expect(adjusted.side).toBe(t0.side);
    expect(adjusted.exitReason).toBe(t0.exitReason);
  });

  it("handles SHORT trades symmetrically — cost reduction is positive for SHORT too", () => {
    // SHORT: entry=100, exit=90 (good fall), stop=105, initialRisk = 5.
    // Raw R = (100-90)/5 = +2.
    const t0 = trade({
      side: "SHORT",
      entryPrice: 100,
      exitPrice: 90,
      stopPrice: 105,
      rMultiple: 2,
    });
    const adjusted = applyCosts(t0, DEFAULT_COST_MODEL);
    expect(adjusted.rMultiple).toBeLessThan(2);
    expect(adjusted.rMultiple).toBeGreaterThan(1.9);
  });
});
