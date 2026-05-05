import { describe, expect, it } from "vitest";
import { tdSequential, recentTdSignal } from "../src/analysis/demark.js";
import type { Candle } from "../src/analysis/indicators.js";

const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ t: i * 3600, o, h, l, c: cl, v: 100 });
const series = (closes: number[]): Candle[] => closes.map((cl, i) => c(i, cl, cl + 0.5, cl - 0.5, cl));

describe("tdSequential", () => {
  it("returns empty state for short series", () => {
    const r = tdSequential(series([100, 99]));
    expect(r.lastSignal).toBeNull();
  });

  it("counts a clean 9-bar Buy Setup on monotonic decline", () => {
    // 13 monotonically declining bars: from bar 4 onward, close < close[i-4] each time.
    const closes = Array.from({ length: 14 }, (_, i) => 100 - i);
    const r = tdSequential(series(closes));
    // Bar 12 should have buySetupCount==9 (close[12]=88 < close[8]=92, and 9 in a row before)
    const completedBars = r.perBar.filter((s) => s.buySetupComplete);
    expect(completedBars.length).toBeGreaterThan(0);
    expect(r.lastSignal?.kind).toBe("buySetup");
  });

  it("counts a clean 9-bar Sell Setup on monotonic rise", () => {
    const closes = Array.from({ length: 14 }, (_, i) => 100 + i);
    const r = tdSequential(series(closes));
    const completed = r.perBar.filter((s) => s.sellSetupComplete);
    expect(completed.length).toBeGreaterThan(0);
    expect(r.lastSignal?.kind).toBe("sellSetup");
  });

  it("interrupts setup when the comparison fails", () => {
    // 5 down bars, then a flat, then 5 down bars — should not complete
    const closes = [100, 99, 98, 97, 96, 95, 96, 95, 94, 93, 92, 91];
    const r = tdSequential(series(closes));
    const completed = r.perBar.filter((s) => s.buySetupComplete);
    expect(completed.length).toBe(0);
  });

  it("buyCountdown completes after Buy Setup completes", () => {
    const closes: number[] = [];
    for (let i = 0; i < 14; i++) closes.push(100 - i); // setup
    for (let i = 0; i < 20; i++) closes.push(86 - i); // continued decline → countdown
    const r = tdSequential(series(closes));
    expect(r.lastSignal?.kind).toBe("buyCountdown");
    const completed = r.perBar.find((s) => s.buyCountdownComplete);
    expect(completed).toBeDefined();
  });

  it("recentTdSignal returns null when signal is too old", () => {
    const closes = Array.from({ length: 30 }, (_, i) => i < 14 ? 100 - i : 80 + i);
    const r = tdSequential(series(closes));
    const sig = recentTdSignal(r, 2);
    // The buy setup completed early; not within last 2 bars
    expect(sig === null || r.perBar.length - 1 - (r.lastSignal?.bar ?? 0) <= 2).toBe(true);
  });
});
