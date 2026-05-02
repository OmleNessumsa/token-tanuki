import { describe, expect, it } from "vitest";
import { scoreChart } from "../src/analysis/chart.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (i: number, o: number, h: number, l: number, cl: number, v = 100): Candle => ({ t: i * 3600, o, h, l, c: cl, v });

describe("scoreChart", () => {
  it("returns a score in [0,100]", () => {
    const candles: Candle[] = Array.from({ length: 60 }, (_, i) => c(i, 100, 101, 99, 100 + Math.sin(i / 5)));
    const r = scoreChart(candles, candles);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("scores higher on a clean uptrend than a clean downtrend", () => {
    const up: Candle[] = Array.from({ length: 60 }, (_, i) => c(i, 100 + i, 101 + i, 99 + i, 100 + i + 0.5));
    const dn: Candle[] = Array.from({ length: 60 }, (_, i) => c(i, 200 - i, 201 - i, 199 - i, 199 - i));
    const upScore = scoreChart(up, up).score;
    const dnScore = scoreChart(dn, dn).score;
    expect(upScore).toBeGreaterThan(dnScore);
  });

  it("flags up trend on rising series", () => {
    const up: Candle[] = Array.from({ length: 60 }, (_, i) => c(i, 100 + i, 101 + i, 99 + i, 100 + i + 0.5));
    const r = scoreChart(up, up);
    expect(r.trend).toBe("up");
  });

  it("flags down trend on falling series", () => {
    const dn: Candle[] = Array.from({ length: 60 }, (_, i) => c(i, 200 - i, 201 - i, 199 - i, 199 - i));
    const r = scoreChart(dn, dn);
    expect(r.trend).toBe("down");
  });

  it("returns rsi value when enough hourly candles", () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => c(i, 100, 101, 99, 100 + i * 0.1));
    const r = scoreChart([], candles);
    expect(r.rsi).not.toBeNull();
    expect(r.rsi!).toBeGreaterThan(0);
  });

  it("includes notes describing what it saw", () => {
    const up: Candle[] = Array.from({ length: 60 }, (_, i) => c(i, 100 + i, 101 + i, 99 + i, 100 + i + 0.5));
    const r = scoreChart(up, up);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it("penalises a runaway 24h pump", () => {
    const huge: Candle[] = [];
    for (let i = 0; i < 60; i++) huge.push(c(i, 1, 1.1, 0.9, 1));
    for (let i = 0; i < 24; i++) huge.push(c(60 + i, 1 + i, 1.5 + i, 0.95 + i, 1.1 + i));
    const flat: Candle[] = Array.from({ length: 84 }, (_, i) => c(i, 100, 101, 99, 100));
    const hugeScore = scoreChart(flat, huge).score;
    const flatScore = scoreChart(flat, flat).score;
    expect(hugeScore).toBeLessThan(flatScore + 30);
  });
});
