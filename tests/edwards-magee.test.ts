import { describe, expect, it } from "vitest";
import { refineHit } from "../src/analysis/edwards-magee.js";
import type { ChartPatternHit } from "../src/analysis/chart-patterns.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (i: number, o: number, h: number, l: number, cl: number, v = 100): Candle => ({ t: i * 3600, o, h, l, c: cl, v });

describe("refineHit", () => {
  it("preserves confidence for unrecognized patterns", () => {
    const hit: ChartPatternHit = {
      pattern: "highTightFlag", startIndex: 0, endIndex: 5,
      bullish: true, confidence: 0.6, breakoutLevel: 100, description: "test",
    };
    const candles = Array.from({ length: 10 }, (_, i) => c(i, 100, 101, 99, 100));
    const r = refineHit(hit, candles);
    // Default 1.0 score → 0.5 + 1.0 = 1.5 multiplier → 0.6 * 1.5 = 0.9
    expect(r.confidence).toBeCloseTo(0.9);
  });

  it("rewards triangle with strong volume contraction", () => {
    const candles: Candle[] = [];
    // Decreasing volume across 30 bars
    for (let i = 0; i < 30; i++) candles.push(c(i, 100, 101, 99, 100, 1000 - i * 30));
    const hit: ChartPatternHit = {
      pattern: "ascendingTriangle", startIndex: 0, endIndex: 29,
      bullish: true, confidence: 0.5, breakoutLevel: 100, description: "test",
    };
    const r = refineHit(hit, candles);
    expect(r.geometryScore).toBeGreaterThan(0.7);
    expect(r.geometryNotes.some((n) => n.includes("contracted"))).toBe(true);
  });

  it("penalizes triangle with no volume contraction", () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => c(i, 100, 101, 99, 100, 1000));
    const hit: ChartPatternHit = {
      pattern: "ascendingTriangle", startIndex: 0, endIndex: 29,
      bullish: true, confidence: 0.5, breakoutLevel: 100, description: "test",
    };
    const r = refineHit(hit, candles);
    expect(r.geometryScore).toBeLessThan(0.5);
  });

  it("rewards double top with second-peak volume LOWER than first", () => {
    // Build a series with two clear peaks; second peak has lower volume
    const candles: Candle[] = [];
    for (let i = 0; i < 5; i++) candles.push(c(i, 90 + i, 90 + i + 0.5, 89 + i, 90 + i, 500));
    candles.push(c(5, 95, 100.5, 94, 100, 1000));        // first peak — high vol
    for (let i = 0; i < 8; i++) candles.push(c(6 + i, 99 - i, 99 - i + 0.5, 98 - i, 99 - i, 200));
    for (let i = 0; i < 5; i++) candles.push(c(14 + i, 91 + i, 91 + i + 0.5, 90 + i, 91 + i, 200));
    candles.push(c(19, 96, 100.5, 95, 100, 600));        // second peak — lower vol
    const hit: ChartPatternHit = {
      pattern: "doubleTop", startIndex: 0, endIndex: 19,
      bullish: false, confidence: 0.5, breakoutLevel: 100, description: "",
    };
    const r = refineHit(hit, candles);
    expect(r.geometryScore).toBeGreaterThanOrEqual(0.5);
  });
});
