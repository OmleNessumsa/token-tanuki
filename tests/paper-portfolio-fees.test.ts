import { describe, expect, it } from "vitest";
import {
  computeSlicePnl,
  computeR,
  defaultTakerFeePct,
  feesForSlice,
} from "../src/paper-portfolio.js";

describe("computeSlicePnl (unchanged, gross)", () => {
  it("computes leveraged spot/futures pnl on a winning slice", () => {
    // Entry $100, exit $110 → +10%. notional $50, leverage 20×, fraction 0.5.
    // gross pnl = 0.10 × 50 × 20 × 0.5 = $50.
    expect(computeSlicePnl(100, 110, 50, 20, 0.5)).toBeCloseTo(50, 6);
  });

  it("returns negative pnl on a losing slice", () => {
    expect(computeSlicePnl(100, 95, 50, 20, 1)).toBeCloseTo(-50, 6);
  });

  it("spot mode (leverage=1) gives a small pnl", () => {
    // $200 notional × 5% move × leverage 1 = $10
    expect(computeSlicePnl(100, 105, 200, 1, 1)).toBeCloseTo(10, 6);
  });
});

describe("feesForSlice", () => {
  it("zero fee when takerFeePct is 0", () => {
    expect(feesForSlice(1000, 1, 0)).toBe(0);
  });

  it("computes Coinbase round-trip fee on a full close", () => {
    // notional $100, fraction 1.0, 0.5% per side × 2 = 1% round-trip = $1
    expect(feesForSlice(100, 1, 0.5)).toBeCloseTo(1, 6);
  });

  it("apportions fees by fraction (TP1 = 50%)", () => {
    // notional $100, 0.5%/side, fraction 0.5 → $0.50
    expect(feesForSlice(100, 0.5, 0.5)).toBeCloseTo(0.5, 6);
  });

  it("MEXC default (0.04%/side) on a $1000 notional 100% close", () => {
    // 0.04 × 2 / 100 × 1000 = $0.80
    expect(feesForSlice(1000, 1, 0.04)).toBeCloseTo(0.8, 6);
  });
});

describe("defaultTakerFeePct", () => {
  it("0.5% for Coinbase spot", () => {
    expect(defaultTakerFeePct("coinbase-spot")).toBe(0.5);
  });

  it("0 for MEXC futures (legacy parity — paper never modeled fees)", () => {
    expect(defaultTakerFeePct("mexc-futures")).toBe(0);
  });

  it("0 for unknown / missing exchange (back-compat)", () => {
    expect(defaultTakerFeePct(undefined)).toBe(0);
    expect(defaultTakerFeePct("nonsense")).toBe(0);
  });
});

describe("net pnl after fees (regression scenario)", () => {
  it("Coinbase $250 notional, +2% move, full close → ~$2.50 net after $2.50 fees", () => {
    const gross = computeSlicePnl(100, 102, 250, 1, 1); // +$5
    const fees = feesForSlice(250, 1, defaultTakerFeePct("coinbase-spot")); // $2.50
    const net = gross - fees;
    expect(gross).toBeCloseTo(5, 6);
    expect(fees).toBeCloseTo(2.5, 6);
    expect(net).toBeCloseTo(2.5, 6);
  });

  it("Coinbase TP1 (50%) at +1.5% move on $250 notional → $1.25 gross, $1.25 fees, net 0", () => {
    const gross = computeSlicePnl(100, 101.5, 250, 1, 0.5); // 0.015 × 250 × 1 × 0.5 = $1.875
    const fees = feesForSlice(250, 0.5, 0.5); // 0.005 × 250 × 0.5 × 2 = $1.25
    expect(gross).toBeCloseTo(1.875, 6);
    expect(fees).toBeCloseTo(1.25, 6);
    expect(gross - fees).toBeCloseTo(0.625, 6);
    // Practical takeaway: at 25% spot cap, 1.5% moves barely cover fees.
    // The strategy needs >2% TP1s to be fee-net positive.
  });
});

describe("computeR (unchanged)", () => {
  it("computes positive R on a winning trade", () => {
    // Entry $100, stop $95 → 1R = $5. Exit $110 → R = 2.
    expect(computeR(100, 110, 95)).toBeCloseTo(2, 6);
  });

  it("returns 0 when stop is at-or-above entry (invalid)", () => {
    expect(computeR(100, 110, 100)).toBe(0);
    expect(computeR(100, 110, 105)).toBe(0);
  });
});

describe("TP price sort (regression — see paper-trader openNewPositions)", () => {
  it("synthetic TP3 below plan-derived TP2 gets sorted into proper order", () => {
    // Scenario from DOGE-USDC 2026-05-12: plan produced only 2 targets where
    // the second was a high-R:R pattern measured move at $0.122. Paper-trader
    // fallback for TP3 = entry + 3R = $0.117. Without sorting, the position
    // would have TP3 < TP2 and the state machine ("TP3 requires TP2") would
    // deadlock.
    const entry = 0.11088;
    const stop = 0.108893;
    const oneR = entry - stop;
    const tpRaw = [
      0.114853,                  // plan TP1 (Prior 4h swing extreme, R:R 1.39)
      0.122280,                  // plan TP2 (Pattern measured move, R:R 7.07)
      entry + 3 * oneR,          // synthetic TP3 fallback ($0.116841)
    ];
    const sorted = tpRaw.slice().sort((a, b) => a - b);
    expect(sorted[0]).toBeLessThan(sorted[1]!);
    expect(sorted[1]).toBeLessThan(sorted[2]!);
    // Specifically the pattern target ends up as TP3, the synthetic 3R as TP2.
    expect(sorted[2]).toBeCloseTo(0.12228, 5);
  });
});
