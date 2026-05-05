import { describe, expect, it } from "vitest";
import { detectChartPatterns, bestChartPatterns } from "../src/analysis/chart-patterns.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (i: number, o: number, h: number, l: number, cl: number, v = 100): Candle => ({ t: i * 3600, o, h, l, c: cl, v });

// Use close as both high and low so swing detection sees strictly-varying extremes.
const series = (closes: number[]): Candle[] =>
  closes.map((cl, i) => c(i, cl, cl, cl, cl));

describe("detectChartPatterns", () => {
  it("returns empty for tiny series", () => {
    expect(detectChartPatterns([])).toEqual([]);
    expect(detectChartPatterns(series([1, 2, 3]))).toEqual([]);
  });

  it("detects a clear double bottom", () => {
    // Build: peak → trough A → small recovery → trough B (similar) → strong recovery breaking above peak
    const closes = [
      100, 105, 108, 110, 108, 102, 95, 88, 80,        // down to trough A
      82, 86, 91, 95, 98, 100, 102, 100, 96, 90,       // recovery to peak then down
      85, 82, 80,                                       // trough B (similar to A)
      85, 92, 98, 104, 110, 115, 120,                   // breakout above peak
    ];
    const hits = detectChartPatterns(series(closes));
    const db = hits.find((h) => h.pattern === "doubleBottom");
    expect(db).toBeDefined();
    expect(db!.bullish).toBe(true);
    expect(db!.confidence).toBeGreaterThan(0.4);
  });

  it("detects a double top with neckline break", () => {
    const closes = [
      80, 85, 90, 95, 100, 105, 110,         // run up to peak A
      105, 100, 95, 92, 90,                  // valley
      93, 98, 103, 108, 110,                 // peak B (similar to A)
      105, 100, 95, 90, 85, 80, 75, 70,      // breakdown below valley
    ];
    const hits = detectChartPatterns(series(closes));
    const dt = hits.find((h) => h.pattern === "doubleTop");
    expect(dt).toBeDefined();
    expect(dt!.bullish).toBe(false);
  });

  it("detects an ascending triangle (flat top, rising lows)", () => {
    const closes: number[] = [];
    // 5 cycles, each pushes to ~100 (flat top) but the lows progressively rise
    const lows = [80, 84, 87, 90, 93];
    for (const lo of lows) {
      closes.push(lo, (lo + 100) / 2, 100, (lo + 100) / 2, lo + 1);
    }
    closes.push(94, 98, 100, 105, 110); // breakout
    const hits = detectChartPatterns(series(closes));
    const at = hits.find((h) => h.pattern === "ascendingTriangle");
    expect(at).toBeDefined();
    expect(at!.bullish).toBe(true);
  });

  it("detects an inverse head and shoulders", () => {
    const closes = [
      100, 95, 90, 85, 80, 76, 75,         // descend to left shoulder low (~75)
      78, 82, 86, 88, 86, 82, 78,           // recover to peak (left shoulder formed)
      74, 70, 67, 65,                       // dive to head low (~65)
      68, 72, 76, 80, 84, 88, 86, 82, 78,   // recover to second peak
      75, 76,                               // right shoulder low (~75)
      80, 86, 92, 98, 104, 110, 116,        // break above neckline
    ];
    const hits = detectChartPatterns(series(closes));
    const ihs = hits.find((h) => h.pattern === "inverseHeadAndShoulders");
    expect(ihs).toBeDefined();
    expect(ihs!.bullish).toBe(true);
  });

  it("detects a high-and-tight flag", () => {
    const closes: number[] = [];
    // Pole: ~120% rise over 25 bars
    let p = 1;
    for (let i = 0; i < 25; i++) {
      p *= 1.035;
      closes.push(p);
    }
    // Flag: tight consolidation, max ~15% pullback
    for (let i = 0; i < 12; i++) {
      const drift = 1 + (Math.sin(i) * 0.05);
      closes.push(p * drift);
    }
    // Pad earlier with flat bars so series is long enough
    const padded = Array.from({ length: 10 }, () => 1).concat(closes);
    const hits = detectChartPatterns(series(padded));
    const htf = hits.find((h) => h.pattern === "highTightFlag");
    expect(htf).toBeDefined();
    expect(htf!.bullish).toBe(true);
  });

  it("bestChartPatterns deduplicates per pattern type, keeping highest confidence", () => {
    const hits = [
      { pattern: "doubleTop", confidence: 0.4, startIndex: 0, endIndex: 5, bullish: false, breakoutLevel: 100, description: "" },
      { pattern: "doubleTop", confidence: 0.8, startIndex: 2, endIndex: 6, bullish: false, breakoutLevel: 100, description: "" },
      { pattern: "doubleBottom", confidence: 0.5, startIndex: 0, endIndex: 5, bullish: true, breakoutLevel: 100, description: "" },
    ] as const;
    const best = bestChartPatterns(hits as never);
    expect(best.length).toBe(2);
    expect(best.find((b) => b.pattern === "doubleTop")!.confidence).toBe(0.8);
  });
});
