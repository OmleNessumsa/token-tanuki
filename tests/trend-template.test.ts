import { describe, expect, it } from "vitest";
import { trendTemplate, detectVCP } from "../src/analysis/trend-template.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ t: i * 86400, o, h, l, c: cl, v: 100 });
const series = (closes: number[]): Candle[] => closes.map((cl, i) => c(i, cl, cl + 0.5, cl - 0.5, cl));

describe("trendTemplate", () => {
  it("fails immediately on insufficient data", () => {
    const r = trendTemplate(series([100, 101, 102]));
    expect(r.passed).toBe(false);
    expect(r.criteriaPassed).toBe(0);
  });

  it("passes all 7 criteria on a clean uptrend", () => {
    // 250 bars, monotonic mild uptrend (1% per bar)
    const closes = Array.from({ length: 250 }, (_, i) => 100 * Math.pow(1.01, i));
    const r = trendTemplate(series(closes));
    expect(r.criteriaPassed).toBe(7);
    expect(r.passed).toBe(true);
  });

  it("fails template on a clean downtrend", () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 * Math.pow(0.99, i));
    const r = trendTemplate(series(closes));
    expect(r.passed).toBe(false);
    expect(r.criteriaPassed).toBeLessThan(4);
  });

  it("counts to 8 when relativeStrengthOk supplied", () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 * Math.pow(1.01, i));
    const r = trendTemplate(series(closes), { relativeStrengthOk: true });
    expect(r.criteriaTotal).toBe(8);
    expect(r.criteriaPassed).toBe(8);
    expect(r.passed).toBe(true);
  });

  it("fails when RS criterion supplied false", () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 * Math.pow(1.01, i));
    const r = trendTemplate(series(closes), { relativeStrengthOk: false });
    expect(r.passed).toBe(false);
  });
});

describe("detectVCP", () => {
  it("returns no detection on flat data", () => {
    const r = detectVCP(series(Array.from({ length: 50 }, () => 100)));
    expect(r.detected).toBe(false);
  });

  it("detects tightening pullbacks (the monotonic-tightening rule)", () => {
    // Build a base with two clean swing-high pivots, the second tighter than the first.
    const closes: number[] = [];
    // recovery to 100
    for (let i = 80; i < 100; i += 0.5) closes.push(i);
    closes.push(100); // peak 1
    // pullback ~12%
    for (let i = 99.5; i > 88; i -= 0.5) closes.push(i);
    closes.push(88);
    // recovery to 99 (peak 2 — no equal-to-prev-peak)
    for (let i = 88.5; i < 99; i += 0.5) closes.push(i);
    closes.push(99);
    // tighter pullback ~5%
    for (let i = 98.5; i > 94; i -= 0.5) closes.push(i);
    closes.push(94);
    // recovery
    for (let i = 94.5; i <= 98; i += 0.5) closes.push(i);
    const r = detectVCP(series(closes));
    expect(r.contractionDepths.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < r.contractionDepths.length; i++) {
      expect(r.contractionDepths[i]).toBeLessThan(r.contractionDepths[i - 1]!);
    }
  });
});
