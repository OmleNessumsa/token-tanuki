import { describe, expect, it } from "vitest";
import { detectBreakout } from "../src/analysis/breakout.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (i: number, o: number, h: number, l: number, cl: number, v = 100): Candle => ({ t: i * 86400, o, h, l, c: cl, v });

describe("detectBreakout", () => {
  it("returns null on too-short input", () => {
    expect(detectBreakout([c(0, 1, 1, 1, 1)])).toBeNull();
  });

  it("flags broken_out when today closes above the 20d high on high volume", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) candles.push(c(i, 100, 105, 95, 100, 1000));
    candles.push(c(20, 100, 110, 100, 109, 3000)); // breakout day with 3× vol
    const r = detectBreakout(candles)!;
    expect(r.state).toBe("broken_out");
    expect(r.volumeConfirmed).toBe(true);
    expect(r.relativeVolume).toBeCloseTo(3, 1);
    expect(r.score).toBeGreaterThan(10);
  });

  it("flags broken_out with weak score when no volume confirmation", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) candles.push(c(i, 100, 105, 95, 100, 1000));
    candles.push(c(20, 100, 108, 100, 107, 1100)); // breakout but 1.1× vol
    const r = detectBreakout(candles)!;
    expect(r.state).toBe("broken_out");
    expect(r.volumeConfirmed).toBe(false);
    expect(r.score).toBeLessThan(8);
  });

  it("flags at_breakout when within 1% below 20d high", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) candles.push(c(i, 100, 110, 90, 100, 1000));
    candles.push(c(20, 105, 109, 105, 109.5, 2000)); // 0.45% below 110
    const r = detectBreakout(candles)!;
    expect(r.state).toBe("at_breakout");
    expect(r.distanceToBreakoutPct).toBeLessThan(1);
  });

  it("flags approaching when 1-3% below 20d high", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) candles.push(c(i, 100, 110, 90, 100, 1000));
    candles.push(c(20, 105, 108, 105, 108, 1500)); // ~1.85% below 110
    const r = detectBreakout(candles)!;
    expect(r.state).toBe("approaching");
    expect(r.distanceToBreakoutPct).toBeGreaterThan(1);
    expect(r.distanceToBreakoutPct).toBeLessThanOrEqual(3);
  });

  it("flags below_breakdown on close beneath 20d low with volume", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) candles.push(c(i, 100, 105, 95, 100, 1000));
    candles.push(c(20, 95, 95, 90, 91, 4000)); // closes at 91, low 90 < 95 (20d low)
    const r = detectBreakout(candles)!;
    expect(r.state).toBe("below_breakdown");
    expect(r.score).toBeLessThan(0);
  });

  it("returns below_range when price is in the middle of the range", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) candles.push(c(i, 100, 110, 90, 100, 1000));
    candles.push(c(20, 100, 102, 99, 100, 1000)); // mid-range
    const r = detectBreakout(candles)!;
    expect(r.state).toBe("below_range");
  });
});
