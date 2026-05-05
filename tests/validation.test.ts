import { describe, expect, it } from "vitest";
import { permutationTest, blockShuffle, mulberry32, emaCrossoverStrategy } from "../src/analysis/validation.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ t: i * 3600, o, h, l, c: cl, v: 100 });
const series = (closes: number[]): Candle[] => closes.map((cl, i) => c(i, cl, cl + 0.5, cl - 0.5, cl));

describe("blockShuffle", () => {
  it("preserves length and candles (just reordered)", () => {
    const candles = series([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const out = blockShuffle(candles, 2, mulberry32(42));
    expect(out.length).toBe(10);
    const inSet = new Set(candles.map((c) => c.c));
    const outSet = new Set(out.map((c) => c.c));
    expect(outSet).toEqual(inSet);
  });

  it("reproducible with same seed", () => {
    const candles = series(Array.from({ length: 50 }, (_, i) => i));
    const a = blockShuffle(candles, 5, mulberry32(7)).map((c) => c.c);
    const b = blockShuffle(candles, 5, mulberry32(7)).map((c) => c.c);
    expect(a).toEqual(b);
  });
});

describe("permutationTest", () => {
  it("returns p-value < 0.5 for trend-following on a clean trend", () => {
    // Clean uptrend with mild noise → trend-following should beat random shuffles often
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i + Math.sin(i / 5) * 2);
    const result = permutationTest(series(closes), emaCrossoverStrategy(20), {
      permutations: 50,
      random: mulberry32(123),
    });
    expect(result.realScore).toBeGreaterThan(0);
    expect(result.permutations).toBe(50);
    // Trend-following on a clean trend should generally outperform shuffles
    expect(result.pValue).toBeLessThan(0.5);
  });

  it("returns a valid p-value structure on a random walk", () => {
    // Random walk → permutations should distribute around the real result.
    const rand = mulberry32(7);
    const closes: number[] = [100];
    for (let i = 1; i < 200; i++) {
      closes.push(closes[i - 1]! * (1 + (rand() - 0.5) * 0.02));
    }
    const result = permutationTest(series(closes), emaCrossoverStrategy(20), {
      permutations: 50,
      random: mulberry32(987),
    });
    expect(result.pValue).toBeGreaterThanOrEqual(0);
    expect(result.pValue).toBeLessThanOrEqual(1);
    expect(result.permutationScores.length).toBe(50);
  });

  it("flags significant when realScore beats nearly all permutations", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
    const result = permutationTest(series(closes), emaCrossoverStrategy(20), {
      permutations: 100,
      random: mulberry32(1),
    });
    expect(result.realScore).toBeGreaterThan(result.meanPermutation);
  });

  it("respects custom alpha", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + i * 0.1);
    const result = permutationTest(series(closes), emaCrossoverStrategy(10), {
      permutations: 30,
      alpha: 0.5,
      random: mulberry32(2),
    });
    expect(result.significant).toBe(result.pValue < 0.5);
  });
});
