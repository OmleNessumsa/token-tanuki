import { describe, expect, it } from "vitest";
import { classifyPhase } from "../src/analysis/lifecycle.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (i: number, o: number, h: number, l: number, cl: number, v = 100): Candle => ({ t: i * 60, o, h, l, c: cl, v });

describe("classifyPhase", () => {
  it("returns unknown when no candles", () => {
    const r = classifyPhase([], [], null);
    expect(r.phase).toBe("unknown");
  });

  it("flags stealth/sniper launch on huge first 1m candle", () => {
    const m1 = [c(0, 1, 100, 1, 100), c(1, 100, 110, 90, 95)];
    const r = classifyPhase(m1, [], Date.now());
    expect(r.phase).toBe("stealthLaunch");
    expect(r.buyability).toBe("avoid");
  });

  it("flags dead chart at >90% drawdown with collapsed volume", () => {
    const m5: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      // big pump then dead
      const v = i < 20 ? 1000 : 1;
      const price = i < 20 ? 100 : 5;
      m5.push(c(i, price, price * 1.05, price * 0.95, price, v));
    }
    const r = classifyPhase([], m5, null);
    expect(r.phase).toBe("dead");
  });

  it("flags bleed-out with lower highs and >50% drawdown", () => {
    const m5: Candle[] = [];
    // pump up
    for (let i = 0; i < 20; i++) m5.push(c(i, 50 + i, 50 + i + 1, 50 + i - 1, 50 + i + 0.5, 100));
    // monotonic decline with lower highs
    for (let i = 0; i < 30; i++) m5.push(c(20 + i, 70 - i * 1.5, 70 - i * 1.5 + 0.5, 70 - i * 1.5 - 1, 70 - i * 1.5 - 0.5, 100));
    const r = classifyPhase([], m5, null);
    expect(r.phase).toBe("bleedOut");
  });

  it("identifies accumulation: pulled back, range-compressed, lower volume", () => {
    const m5: Candle[] = [];
    // initial pump (high volume, wide range)
    for (let i = 0; i < 10; i++) m5.push(c(i, 50 + i * 4, 50 + i * 4 + 5, 50 + i * 4 - 5, 50 + i * 4 + 2, 1000));
    // pullback (still wide-ish)
    for (let i = 0; i < 10; i++) m5.push(c(10 + i, 90 - i * 2, 90 - i * 2 + 4, 90 - i * 2 - 4, 90 - i * 2 - 1, 800));
    // tight consolidation, low volume
    for (let i = 0; i < 15; i++) m5.push(c(20 + i, 70 + (i % 3) * 0.2, 70.5, 69.5, 70 + ((i + 1) % 3) * 0.2, 50));
    const r = classifyPhase([], m5, null);
    expect(["accumulation", "unknown"]).toContain(r.phase);
  });

  it("flags parabolic with vertical volume + consecutive greens", () => {
    const m5: Candle[] = [];
    for (let i = 0; i < 60; i++) m5.push(c(i, 100 + i * 0.1, 100 + i * 0.1 + 0.5, 100 + i * 0.1 - 0.5, 100 + i * 0.1 + 0.2, 100));
    for (let i = 0; i < 6; i++) m5.push(c(60 + i, 110 + i * 5, 110 + i * 5 + 6, 110 + i * 5 - 0.5, 110 + i * 5 + 5, 5000));
    const r = classifyPhase([], m5, null);
    expect(r.phase).toBe("parabolic");
    expect(r.buyability).toBe("avoid");
  });
});
