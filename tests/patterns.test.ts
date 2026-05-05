import { describe, expect, it } from "vitest";
import { detectCandlePatterns } from "../src/analysis/patterns.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (o: number, h: number, l: number, cl: number): Candle => ({ t: 0, o, h, l, c: cl, v: 1000 });

describe("detectCandlePatterns", () => {
  it("detects a bullish hammer", () => {
    const candles = [c(10, 10.06, 7, 10.05)];
    const hits = detectCandlePatterns(candles);
    expect(hits.some((h) => h.pattern === "hammer")).toBe(true);
  });

  it("detects a shooting star (bullish prior, gap up, bearish inverted hammer at top)", () => {
    const candles = [
      c(10, 11, 9.9, 10.95),     // bullish bar, high = 11
      c(11.5, 13, 11.35, 11.4),  // gap-up open (>11), bearish (close<open), body 0.1, upper wick 1.5
    ];
    const hits = detectCandlePatterns(candles);
    expect(hits.some((h) => h.pattern === "shootingStar")).toBe(true);
  });

  it("detects bullish engulfing", () => {
    const candles = [
      c(10, 10.1, 9, 9.2),  // red
      c(9.1, 11, 9, 10.5),  // green engulfing prior
    ];
    const hits = detectCandlePatterns(candles);
    expect(hits.some((h) => h.pattern === "bullishEngulfing")).toBe(true);
  });

  it("detects three white soldiers", () => {
    const candles = [c(10, 11, 10, 11), c(11, 12, 11, 12), c(12, 13, 12, 13)];
    const hits = detectCandlePatterns(candles);
    expect(hits.some((h) => h.pattern === "threeWhiteSoldiers")).toBe(true);
  });

  it("detects three black crows", () => {
    const candles = [c(13, 13, 12, 12), c(12, 12, 11, 11), c(11, 11, 10, 10)];
    const hits = detectCandlePatterns(candles);
    expect(hits.some((h) => h.pattern === "threeBlackCrows")).toBe(true);
  });

  it("detects doji", () => {
    const candles = [c(10, 11, 9, 10.001)];
    const hits = detectCandlePatterns(candles);
    expect(hits.some((h) => h.pattern === "doji")).toBe(true);
  });
});
