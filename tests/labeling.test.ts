import { describe, expect, it } from "vitest";
import { tripleBarrierLabel, purgedKFold, rollingVolatility, labelDistribution } from "../src/analysis/labeling.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ t: i * 3600, o, h, l, c: cl, v: 100 });
const series = (closes: number[]): Candle[] => closes.map((cl, i) => c(i, cl, cl + 1, cl - 1, cl));

describe("rollingVolatility", () => {
  it("returns one value per candle", () => {
    const vol = rollingVolatility(series([1, 2, 3, 4, 5]), 3);
    expect(vol.length).toBe(5);
  });

  it("higher on volatile series", () => {
    const flat = rollingVolatility(series(Array.from({ length: 50 }, () => 100)));
    const noisy = rollingVolatility(series(Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 20)));
    expect(noisy[noisy.length - 1]).toBeGreaterThan(flat[flat.length - 1]!);
  });
});

describe("tripleBarrierLabel", () => {
  it("labels +1 when price runs up to upper barrier first", () => {
    const closes = [100, 101, 102, 103, 104, 110, 110, 110, 110, 110];
    const candles = series(closes);
    const events = tripleBarrierLabel(candles, { upperMult: 1, lowerMult: 1, horizon: 5, volWindow: 3 });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.label === 1)).toBe(true);
  });

  it("labels -1 when price falls to lower barrier first", () => {
    // Need non-zero volatility before the test bar so barriers are sized non-trivially.
    const closes = [100, 102, 98, 101, 99, 100, 90, 89, 88, 87, 86, 85, 84, 83];
    const candles = series(closes);
    const events = tripleBarrierLabel(candles, { upperMult: 1, lowerMult: 1, horizon: 5, volWindow: 3 });
    expect(events.some((e) => e.label === -1)).toBe(true);
  });

  it("labels 0 (vertical) when price meanders within barriers", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3) * 0.05);
    const candles = series(closes);
    const events = tripleBarrierLabel(candles, { upperMult: 100, lowerMult: 100, horizon: 5 });
    if (events.length > 0) {
      expect(events.some((e) => e.label === 0)).toBe(true);
    }
  });

  it("returns no events when horizon exceeds remaining candles", () => {
    expect(tripleBarrierLabel(series([100, 101]), { upperMult: 2, lowerMult: 2, horizon: 5 })).toEqual([]);
  });
});

describe("purgedKFold", () => {
  it("partitions events into k folds", () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      startIndex: i, exitIndex: i + 5, barrier: "vertical" as const, returnPct: 0, label: 0 as const,
    }));
    const splits = purgedKFold(events, 5);
    expect(splits.length).toBe(5);
    expect(splits[0]!.testIndices.length).toBe(20);
    expect(splits[0]!.trainIndices.length + splits[0]!.testIndices.length).toBeLessThanOrEqual(100);
  });

  it("excludes overlapping samples from train (purge effect)", () => {
    // Sample 18's horizon ends at 23 (overlaps test fold 20..40)
    const events = Array.from({ length: 50 }, (_, i) => ({
      startIndex: i, exitIndex: i + 5, barrier: "vertical" as const, returnPct: 0, label: 0 as const,
    }));
    const splits = purgedKFold(events, 5, 0);
    const fold = splits[1]!; // test indices 10..20 with k=5
    // Samples whose horizon overlaps [10..20] should be excluded
    expect(fold.trainIndices.includes(8)).toBe(false); // exits at 13, overlaps test
    expect(fold.trainIndices.includes(0)).toBe(true);  // exits at 5, before test
  });
});

describe("labelDistribution", () => {
  it("counts each label class", () => {
    const events = [
      { startIndex: 0, exitIndex: 1, barrier: "upper" as const, returnPct: 0.1, label: 1 as const },
      { startIndex: 1, exitIndex: 2, barrier: "lower" as const, returnPct: -0.1, label: -1 as const },
      { startIndex: 2, exitIndex: 3, barrier: "vertical" as const, returnPct: 0, label: 0 as const },
      { startIndex: 3, exitIndex: 4, barrier: "vertical" as const, returnPct: 0, label: 0 as const },
    ];
    const d = labelDistribution(events);
    expect(d[1]).toBe(1);
    expect(d[-1]).toBe(1);
    expect(d[0]).toBe(2);
  });
});
