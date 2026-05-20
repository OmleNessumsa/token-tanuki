import { describe, expect, it } from "vitest";
import { computeR, computeSlicePnl } from "../src/paper-portfolio.js";

describe("computeSlicePnl (SHORT)", () => {
  it("profits when SHORT exits BELOW entry", () => {
    // Entry $100, exit $95 → -5% for LONG, +5% for SHORT.
    // notional $50, leverage 20×, fraction 1 → +$50 short pnl.
    expect(computeSlicePnl(100, 95, 50, 20, 1, "SHORT")).toBeCloseTo(50, 6);
  });

  it("loses when SHORT exits ABOVE entry", () => {
    // Entry $100, exit $105 → -5% short pnl.
    expect(computeSlicePnl(100, 105, 50, 20, 1, "SHORT")).toBeCloseTo(-50, 6);
  });

  it("LONG behaviour unchanged when side omitted (default)", () => {
    expect(computeSlicePnl(100, 110, 50, 20, 0.5)).toBeCloseTo(50, 6);
  });

  it("SHORT and LONG are exactly mirror images on the same price move", () => {
    const longPnl  = computeSlicePnl(100, 110, 50, 20, 1, "LONG");
    const shortPnl = computeSlicePnl(100, 110, 50, 20, 1, "SHORT");
    expect(longPnl + shortPnl).toBeCloseTo(0, 6);
  });
});

describe("computeR (SHORT)", () => {
  it("yields +R when SHORT moves DOWN past the favourable distance", () => {
    // Entry $100, stop $105 (above for SHORT). 1R = $5 down move.
    // Exit $90 → 10 down × 1R per 5 = +2R.
    expect(computeR(100, 90, 105, "SHORT")).toBeCloseTo(2, 6);
  });

  it("yields -1R when SHORT exits at stop", () => {
    expect(computeR(100, 105, 105, "SHORT")).toBeCloseTo(-1, 6);
  });

  it("returns 0 when SHORT stop is at-or-below entry (invalid setup)", () => {
    expect(computeR(100, 90, 100, "SHORT")).toBe(0);
    expect(computeR(100, 90,  95, "SHORT")).toBe(0);
  });

  it("LONG behaviour unchanged when side omitted (default)", () => {
    expect(computeR(100, 110, 95)).toBeCloseTo(2, 6);
  });
});
