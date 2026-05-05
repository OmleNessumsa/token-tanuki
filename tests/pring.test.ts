import { describe, expect, it } from "vitest";
import { roc, kst, specialK, kstCrossover } from "../src/analysis/indicators.js";

describe("roc", () => {
  it("computes percent change vs N-period earlier", () => {
    const out = roc([100, 110, 120, 130, 140], 1);
    expect(out[0]).toBeCloseTo(10, 5);
    expect(out[3]).toBeCloseTo((140 - 130) / 130 * 100, 5);
  });

  it("returns empty if period >= length", () => {
    expect(roc([1, 2, 3], 5)).toEqual([]);
  });
});

describe("kst — Pring Know Sure Thing", () => {
  it("returns positive on a clean uptrend", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + i * 2);
    const r = kst(closes, "short");
    expect(r.values.length).toBeGreaterThan(0);
    expect(r.values[r.values.length - 1]).toBeGreaterThan(0);
  });

  it("returns negative on a clean downtrend", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 200 - i * 1.5);
    const r = kst(closes, "short");
    expect(r.values[r.values.length - 1]).toBeLessThan(0);
  });

  it("signal line is smoother than raw KST", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 20 + i * 0.3);
    const r = kst(closes, "short");
    // Signal should have lower variance than values (it's a moving average)
    const variance = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length;
    };
    const lastN = (xs: number[], n: number) => xs.slice(-n);
    expect(variance(lastN(r.signal, 50))).toBeLessThanOrEqual(variance(lastN(r.values, 50)));
  });

  it("long-term variant uses different windows", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + i);
    const short = kst(closes, "short");
    const long = kst(closes, "long");
    expect(short.values.length).not.toBe(long.values.length);
  });
});

describe("specialK", () => {
  it("returns empty when not enough bars (needs ~720)", () => {
    expect(specialK(Array.from({ length: 100 }, (_, i) => i))).toEqual([]);
  });

  it("computes values for a long enough series", () => {
    const closes = Array.from({ length: 800 }, (_, i) => 100 + i * 0.5);
    const out = specialK(closes);
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1]).toBeGreaterThan(0);
  });
});

describe("kstCrossover", () => {
  it("detects a crossover (any direction) on a series that oscillates", () => {
    // Long oscillating series should produce multiple crossovers;
    // at least one should appear when scanning the full signal range.
    const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 12) * 30);
    const r = kst(closes, "short");
    const cross = kstCrossover(r, r.signal.length - 1);
    expect(cross === "bullish" || cross === "bearish").toBe(true);
  });
});
