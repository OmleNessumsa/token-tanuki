import { describe, expect, it } from "vitest";
import { generateTradePlan } from "../src/analysis/trade-plan.js";
import type { FuturesAnalysis } from "../src/analyze-futures.js";
import type { Candle } from "../src/analysis/indicators.js";

/**
 * Build a stub with very-narrow ATR so the natural stop lands inside
 * the floor (without this, ATR-derived stop already exceeds 1.5%).
 */
function stubTightAtr(opts: { side: "LONG" | "SHORT"; price: number }): FuturesAnalysis {
  const { side, price } = opts;
  const mkCandles = (basePrice: number): Candle[] => {
    const out: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      const drift = (i - 100) * 0.0001 * basePrice;
      const p = basePrice + drift;
      const tick = basePrice * 0.0005;
      out.push({ t: 1700000000 + i * 3600, o: p - tick, h: p + tick, l: p - tick, c: p, v: 1000 });
    }
    return out;
  };
  const candles = mkCandles(price);
  const chart = {
    score: 60,
    trend: (side === "LONG" ? "up" : "down") as "up" | "down",
    rsi: 55,
    rsiDivergence: null as null,
    breakout: null as null,
    candlePatterns: [],
    chartPatterns: [],
    stage2: side === "LONG",
  };
  const dir = side === "LONG" ? "bullish" : "bearish";
  return {
    asset: "BTC",
    exchangeId: "blofin-futures",
    perpSymbol: "BTC-USDT",
    ticker: {
      symbol: "BTC-USDT",
      lastPrice: price,
      bid: price,
      ask: price,
      volume24Quote: 1_000_000,
      high24: price * 1.001,
      low24: price * 0.999,
      riseFallRate: 0.001,
      timestamp: Date.now(),
    },
    funding: null,
    intermarket: { regime: "neutral", description: "neutral", btcDailyChangePct: 0, btcDominanceTrend: "flat" } as FuturesAnalysis["intermarket"],
    trendTemplate: null,
    timeframes: [
      { timeframe: "5m", candles, chart, direction: dir },
      { timeframe: "15m", candles, chart, direction: dir },
      { timeframe: "1h", candles, chart, direction: dir },
      { timeframe: "4h", candles, chart, direction: dir },
      { timeframe: "1d", candles, chart, direction: dir },
    ],
    confluence: { htfDirection: dir, ltfDirection: dir, aligned: true, score: 70, summary: "ALIGNED" },
    verdict: { side, confidence: "high", reasons: [], caveats: [] },
    naturalSide: side,
    stage2: side === "LONG",
  };
}

describe("generateTradePlan — minStopDistancePct floor", () => {
  it("widens a tight LONG stop up to the floor", () => {
    const price = 80_000;
    const plan = generateTradePlan({
      analysis: stubTightAtr({ side: "LONG", price }),
      accountUsd: 1000,
      leverage: 20,
      minStopDistancePct: 1.5,
    });
    expect(plan).not.toBeNull();
    expect(plan!.stop.distancePct).toBeGreaterThanOrEqual(1.5 - 1e-9);
    expect(plan!.stop.method).toBe("floor");
    // LONG stop sits below entry
    expect(plan!.stop.price).toBeLessThan(price);
    // and exactly at the floor distance
    expect(plan!.stop.price).toBeCloseTo(price * (1 - 1.5 / 100), 4);
  });

  it("widens a tight SHORT stop up to the floor (above entry)", () => {
    const price = 80_000;
    const plan = generateTradePlan({
      analysis: stubTightAtr({ side: "SHORT", price }),
      accountUsd: 1000,
      leverage: 20,
      minStopDistancePct: 1.5,
    });
    expect(plan).not.toBeNull();
    expect(plan!.stop.distancePct).toBeGreaterThanOrEqual(1.5 - 1e-9);
    expect(plan!.stop.method).toBe("floor");
    expect(plan!.stop.price).toBeGreaterThan(price);
    expect(plan!.stop.price).toBeCloseTo(price * (1 + 1.5 / 100), 4);
  });

  it("emits a 'widened to floor' warning so operators can see the override", () => {
    const plan = generateTradePlan({
      analysis: stubTightAtr({ side: "LONG", price: 80_000 }),
      accountUsd: 1000,
      leverage: 20,
      minStopDistancePct: 1.5,
    });
    expect(plan!.warnings.some((w) => /floor/i.test(w))).toBe(true);
  });

  it("default (no minStopDistancePct) preserves legacy tight-stop behavior", () => {
    const plan = generateTradePlan({
      analysis: stubTightAtr({ side: "LONG", price: 80_000 }),
      accountUsd: 1000,
      leverage: 20,
    });
    expect(plan).not.toBeNull();
    expect(plan!.stop.method).not.toBe("floor");
    expect(plan!.stop.distancePct).toBeLessThan(1.5);
  });

  it("does not widen a stop already past the floor", () => {
    // Reuse the spot-test-style stub via direct construction: wide ATR
    const price = 80_000;
    const mkCandles = (): Candle[] => {
      const out: Candle[] = [];
      // High-low range ≈ 4000 on $80k → ATR ≈ 4000 → 2×ATR stop ≈ 5% (well past floor).
      for (let i = 0; i < 200; i++) {
        const drift = (i - 100) * 20;
        const p = price + drift;
        out.push({ t: 1700000000 + i * 3600, o: p - 800, h: p + 1600, l: p - 2400, c: p, v: 1000 });
      }
      return out;
    };
    const candles = mkCandles();
    const chart = {
      score: 60,
      trend: "up" as const,
      rsi: 55,
      rsiDivergence: null as null,
      breakout: null as null,
      candlePatterns: [],
      chartPatterns: [],
      stage2: true,
    };
    const analysis: FuturesAnalysis = {
      asset: "BTC",
      exchangeId: "blofin-futures",
      perpSymbol: "BTC-USDT",
      ticker: {
        symbol: "BTC-USDT",
        lastPrice: price,
        bid: price,
        ask: price,
        volume24Quote: 1_000_000,
        high24: price * 1.01,
        low24: price * 0.99,
        riseFallRate: 0.005,
        timestamp: Date.now(),
      },
      funding: null,
      intermarket: { regime: "neutral", description: "neutral", btcDailyChangePct: 0, btcDominanceTrend: "flat" } as FuturesAnalysis["intermarket"],
      trendTemplate: null,
      timeframes: [
        { timeframe: "5m", candles, chart, direction: "bullish" },
        { timeframe: "15m", candles, chart, direction: "bullish" },
        { timeframe: "1h", candles, chart, direction: "bullish" },
        { timeframe: "4h", candles, chart, direction: "bullish" },
        { timeframe: "1d", candles, chart, direction: "bullish" },
      ],
      confluence: { htfDirection: "bullish", ltfDirection: "bullish", aligned: true, score: 70, summary: "ALIGNED" },
      verdict: { side: "LONG", confidence: "high", reasons: [], caveats: [] },
      naturalSide: "LONG",
      stage2: true,
    };
    const plan = generateTradePlan({
      analysis,
      accountUsd: 1000,
      leverage: 20,
      minStopDistancePct: 1.5,
    });
    expect(plan).not.toBeNull();
    // Whatever method ATR/structure picked, it shouldn't have been overridden by the floor.
    if (plan!.stop.distancePct >= 1.5) {
      expect(plan!.stop.method).not.toBe("floor");
    }
  });
});
