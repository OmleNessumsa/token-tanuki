import { describe, expect, it } from "vitest";
import { generateTradePlan } from "../src/analysis/trade-plan.js";
import type { FuturesAnalysis } from "../src/analyze-futures.js";
import type { Candle } from "../src/analysis/indicators.js";

/**
 * Build a minimal FuturesAnalysis stub that the trade-plan generator
 * accepts. Just enough for the spot-mode code path to exercise sizing,
 * stop placement, target derivation, and liquidation-sentinel emission.
 */
function stubAnalysis(opts: { side: "LONG" | "SHORT" | "FLAT"; price: number }): FuturesAnalysis {
  const { side, price } = opts;
  const mkCandles = (basePrice: number): Candle[] => {
    const out: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      const drift = (i - 100) * 0.5;
      const p = basePrice + drift;
      out.push({ t: 1700000000 + i * 3600, o: p - 1, h: p + 2, l: p - 3, c: p, v: 1000 });
    }
    return out;
  };
  const candles1h = mkCandles(price);
  const candles4h = mkCandles(price);
  const candles1d = mkCandles(price);
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
  return {
    asset: "BTC",
    exchangeId: "coinbase-spot",
    perpSymbol: "BTC-USDC",
    ticker: {
      symbol: "BTC-USDC",
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
      { timeframe: "5m", candles: candles1h, chart, direction: "bullish" },
      { timeframe: "15m", candles: candles1h, chart, direction: "bullish" },
      { timeframe: "1h", candles: candles1h, chart, direction: "bullish" },
      { timeframe: "4h", candles: candles4h, chart, direction: "bullish" },
      { timeframe: "1d", candles: candles1d, chart, direction: "bullish" },
    ],
    confluence: { htfDirection: "bullish", ltfDirection: "bullish", aligned: true, score: 70, summary: "ALIGNED" },
    verdict: { side, confidence: "high", reasons: [], caveats: [] },
    naturalSide: side,
    stage2: true,
  };
}

describe("generateTradePlan (spot mode)", () => {
  it("emits mode='spot' on the plan", () => {
    const plan = generateTradePlan({
      analysis: stubAnalysis({ side: "LONG", price: 80_000 }),
      accountUsd: 1000,
      leverage: 1,
      mode: "spot",
    });
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe("spot");
  });

  it("forces leverageUsed=1 regardless of input leverage", () => {
    const plan = generateTradePlan({
      analysis: stubAnalysis({ side: "LONG", price: 80_000 }),
      accountUsd: 1000,
      leverage: 20,           // user attempts leverage — should be ignored on spot
      mode: "spot",
    });
    expect(plan!.positionSizing.leverageUsed).toBe(1);
  });

  it("liquidation is the spot sentinel (price=0, bufferPct=100)", () => {
    const plan = generateTradePlan({
      analysis: stubAnalysis({ side: "LONG", price: 80_000 }),
      accountUsd: 1000,
      leverage: 1,
      mode: "spot",
    });
    expect(plan!.liquidation.price).toBe(0);
    expect(plan!.liquidation.bufferPct).toBe(100);
    expect(plan!.liquidation.usable).toBe(true);
  });

  it("never emits liq-cap stop method on spot", () => {
    const plan = generateTradePlan({
      analysis: stubAnalysis({ side: "LONG", price: 80_000 }),
      accountUsd: 1000,
      leverage: 1,
      mode: "spot",
    });
    expect(plan!.stop.method).not.toBe("liq-cap");
  });

  it("margin equals notional on spot (no leverage)", () => {
    const plan = generateTradePlan({
      analysis: stubAnalysis({ side: "LONG", price: 80_000 }),
      accountUsd: 1000,
      leverage: 1,
      mode: "spot",
    });
    expect(plan!.positionSizing.marginUsd).toBeCloseTo(plan!.positionSizing.notionalUsd, 2);
  });

  it("caps notional at spotMaxPositionPctOfEquity (default 25%)", () => {
    const plan = generateTradePlan({
      analysis: stubAnalysis({ side: "LONG", price: 80_000 }),
      accountUsd: 1000,
      leverage: 1,
      riskPctPerTrade: 5,    // aggressive, would normally inflate notional
      mode: "spot",
    });
    // 25% of $1000 = $250 cap
    expect(plan!.positionSizing.notionalUsd).toBeLessThanOrEqual(250 + 0.01);
  });

  it("respects spotMaxPositionPctOfEquity override", () => {
    const plan = generateTradePlan({
      analysis: stubAnalysis({ side: "LONG", price: 80_000 }),
      accountUsd: 1000,
      leverage: 1,
      riskPctPerTrade: 5,
      spotMaxPositionPctOfEquity: 50,
      mode: "spot",
    });
    expect(plan!.positionSizing.notionalUsd).toBeLessThanOrEqual(500 + 0.01);
  });

  it("returns null when verdict is SHORT on a spot adapter", () => {
    // Spot adapters can't short — the plan generator must refuse.
    const plan = generateTradePlan({
      analysis: stubAnalysis({ side: "SHORT", price: 80_000 }),
      accountUsd: 1000,
      leverage: 1,
      mode: "spot",
    });
    expect(plan).toBeNull();
  });

  it("futures mode is the default and still includes leverage", () => {
    const plan = generateTradePlan({
      analysis: stubAnalysis({ side: "LONG", price: 80_000 }),
      accountUsd: 1000,
      leverage: 10,
    });
    expect(plan!.mode).toBe("futures");
    expect(plan!.positionSizing.leverageUsed).toBeGreaterThanOrEqual(1);
    expect(plan!.liquidation.price).toBeGreaterThan(0);
  });
});
