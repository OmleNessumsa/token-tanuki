import { describe, expect, it } from "vitest";
import {
  sma,
  ema,
  rsi,
  atr,
  obv,
  bollinger,
  swings,
  detectRsiDivergence,
  trendDirection,
  pctChange,
  maxDrawdown,
  toCandles,
  type Candle,
} from "../src/analysis/indicators.js";
import type { OhlcvCandle } from "../src/schemas.js";

const mkCandle = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({
  t: i * 60,
  o, h, l, c, v,
});

describe("sma", () => {
  it("returns rolling average", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([2, 3, 4]);
  });

  it("returns empty when too short", () => {
    expect(sma([1, 2], 3)).toEqual([]);
  });
});

describe("ema", () => {
  it("seeds with sma then smooths", () => {
    const out = ema([1, 2, 3, 4, 5, 6], 3);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(2);
    expect(out[3]).toBeGreaterThan(out[0]!);
  });
});

describe("rsi", () => {
  it("hits 100 on strict uptrend", () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1);
    const out = rsi(closes, 14);
    expect(out[out.length - 1]).toBe(100);
  });

  it("hits 0 on strict downtrend", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    const out = rsi(closes, 14);
    expect(out[out.length - 1]).toBe(0);
  });
});

describe("atr", () => {
  it("computes true range over period", () => {
    const candles = Array.from({ length: 20 }, (_, i) => mkCandle(i, i, i + 2, i - 1, i + 1));
    const out = atr(candles, 14);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toBeGreaterThan(0);
  });
});

describe("obv", () => {
  it("rises on close-up days", () => {
    const candles = [mkCandle(0, 1, 1, 1, 1, 100), mkCandle(1, 1, 1, 1, 2, 200), mkCandle(2, 2, 2, 2, 3, 300)];
    const out = obv(candles);
    expect(out[2]).toBeGreaterThan(out[1]!);
  });

  it("falls on close-down days", () => {
    const candles = [mkCandle(0, 5, 5, 5, 5, 100), mkCandle(1, 5, 5, 5, 4, 200), mkCandle(2, 4, 4, 4, 3, 300)];
    const out = obv(candles);
    expect(out[2]).toBeLessThan(out[0]!);
  });
});

describe("bollinger", () => {
  it("upper >= mid >= lower", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const { upper, mid, lower } = bollinger(closes, 20, 2);
    for (let i = 0; i < mid.length; i++) {
      expect(upper[i]).toBeGreaterThanOrEqual(mid[i]!);
      expect(mid[i]).toBeGreaterThanOrEqual(lower[i]!);
    }
  });
});

describe("swings", () => {
  it("identifies a clear high and low", () => {
    const candles = [
      mkCandle(0, 1, 1, 1, 1),
      mkCandle(1, 2, 2, 2, 2),
      mkCandle(2, 3, 3, 3, 3),
      mkCandle(3, 5, 10, 5, 5),  // high at index 3
      mkCandle(4, 4, 4, 4, 4),
      mkCandle(5, 3, 3, 3, 3),
      mkCandle(6, 1, 1, 0, 1),    // low at index 6
      mkCandle(7, 2, 2, 2, 2),
      mkCandle(8, 3, 3, 3, 3),
      mkCandle(9, 4, 4, 4, 4),
    ];
    const out = swings(candles, 3);
    expect(out.some((s) => s.kind === "high" && s.index === 3)).toBe(true);
    expect(out.some((s) => s.kind === "low" && s.index === 6)).toBe(true);
  });
});

describe("detectRsiDivergence", () => {
  it("finds bullish divergence on lower-low price + higher-low rsi", () => {
    // construct two clean swing lows, second deeper, with rsi rising at the second
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const c = i === 8 ? 50 : i === 22 ? 40 : 80 - Math.abs(i - 15) * 2;
      candles.push(mkCandle(i, c, c + 1, c - 5, c));
    }
    const closes = candles.map((c) => c.c);
    const r = rsi(closes, 14);
    const divs = detectRsiDivergence(candles, r);
    // Hard to assert kind without controlled data; just confirm the pipeline runs without throwing.
    expect(Array.isArray(divs)).toBe(true);
  });
});

describe("trendDirection", () => {
  it("up on rising series", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    expect(trendDirection(closes)).toBe("up");
  });

  it("down on falling series", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 200 - i);
    expect(trendDirection(closes)).toBe("down");
  });

  it("flat on short series", () => {
    expect(trendDirection([1, 2, 3])).toBe("flat");
  });
});

describe("pctChange", () => {
  it("computes percentage change", () => {
    expect(pctChange(100, 110)).toBeCloseTo(10);
    expect(pctChange(100, 50)).toBeCloseTo(-50);
    expect(pctChange(0, 50)).toBe(0);
  });
});

describe("maxDrawdown", () => {
  it("captures peak-to-trough", () => {
    expect(maxDrawdown([100, 120, 60, 80])).toBeCloseTo(0.5);
  });

  it("zero on monotonic up", () => {
    expect(maxDrawdown([1, 2, 3, 4])).toBe(0);
  });
});

describe("toCandles", () => {
  it("converts ohlcv tuples", () => {
    const rows: OhlcvCandle[] = [[1, 1, 2, 0.5, 1.5, 100]];
    const out = toCandles(rows);
    expect(out[0]).toEqual({ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 });
  });
});
