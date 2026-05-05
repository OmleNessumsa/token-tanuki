import { describe, expect, it } from "vitest";
import { expectancy, sizeByPctRisk, sizeByVolatility, atrStop, structureStop, planTrade } from "../src/analysis/sizing.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ t: i * 3600, o, h, l, c: cl, v: 100 });

describe("expectancy", () => {
  it("zero on empty input", () => {
    expect(expectancy([]).expectancy).toBe(0);
  });

  it("positive expectancy on +3R wins, -1R losses, 50% win rate", () => {
    const trades = [{ rMultiple: 3 }, { rMultiple: -1 }, { rMultiple: 3 }, { rMultiple: -1 }];
    const e = expectancy(trades);
    expect(e.winRate).toBe(0.5);
    expect(e.expectancy).toBeCloseTo(1, 5);
    expect(e.payoffRatio).toBe(3);
  });

  it("negative expectancy when payoff insufficient", () => {
    const trades = [{ rMultiple: 1 }, { rMultiple: -1 }, { rMultiple: 1 }, { rMultiple: -1 }, { rMultiple: -1 }];
    const e = expectancy(trades);
    expect(e.expectancy).toBeLessThan(0);
  });
});

describe("sizeByPctRisk", () => {
  it("computes Tharp 1% risk correctly", () => {
    // $100k equity, 1% risk = $1k. Entry $50, stop $48 → distance $2 → 500 units → $25k position
    const out = sizeByPctRisk({ equityUsd: 100_000, entryPrice: 50, stopPrice: 48 });
    expect(out.riskUsd).toBe(1000);
    expect(out.positionUnits).toBe(500);
    expect(out.positionUsd).toBe(25000);
  });

  it("warns when risk % > 2%", () => {
    const out = sizeByPctRisk({ equityUsd: 100_000, entryPrice: 50, stopPrice: 48, riskPctOfEquity: 5 });
    expect(out.warnings.some((w) => w.includes("Tharp"))).toBe(true);
  });

  it("clamps position when stop is too tight", () => {
    const out = sizeByPctRisk({ equityUsd: 10_000, entryPrice: 100, stopPrice: 99.99, maxPositionPctOfEquity: 50 });
    expect(out.positionUsd).toBeLessThanOrEqual(5000);
    expect(out.warnings.some((w) => w.includes("clamped"))).toBe(true);
  });

  it("returns zero on entry==stop", () => {
    const out = sizeByPctRisk({ equityUsd: 10_000, entryPrice: 100, stopPrice: 100 });
    expect(out.positionUsd).toBe(0);
    expect(out.warnings[0]).toContain("entry == stop");
  });
});

describe("sizeByVolatility", () => {
  it("scales with ATR", () => {
    const candles = Array.from({ length: 30 }, (_, i) => c(i, 100, 105, 95, 100));
    const out = sizeByVolatility({ equityUsd: 100_000, entryPrice: 100, candles });
    expect(out.atr).toBeGreaterThan(0);
    expect(out.riskUsd).toBe(1000);
    expect(out.positionUnits).toBeGreaterThan(0);
  });

  it("returns zero with insufficient candles", () => {
    const out = sizeByVolatility({ equityUsd: 100_000, entryPrice: 100, candles: [] });
    expect(out.positionUsd).toBe(0);
  });
});

describe("stop helpers", () => {
  it("atrStop long is below entry", () => {
    expect(atrStop(100, 2, 1.5, "long")).toBe(97);
  });
  it("atrStop short is above entry", () => {
    expect(atrStop(100, 2, 1.5, "short")).toBe(103);
  });
  it("structureStop pads below swing low for longs", () => {
    expect(structureStop(95, 2, "long", 0.5)).toBe(94);
  });
});

describe("planTrade", () => {
  it("rejects R:R below 2", () => {
    const out = planTrade({ equityUsd: 10_000, entryPrice: 100, stopPrice: 95, targetPrice: 108 });
    expect(out).toBeNull();
  });

  it("accepts 3:1 trade and returns sizing", () => {
    const out = planTrade({ equityUsd: 10_000, entryPrice: 100, stopPrice: 95, targetPrice: 115 });
    expect(out).not.toBeNull();
    expect(out!.riskRewardRatio).toBeCloseTo(3, 5);
    expect(out!.positionSize.positionUnits).toBeGreaterThan(0);
  });
});
