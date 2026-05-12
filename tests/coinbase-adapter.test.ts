import { describe, expect, it } from "vitest";
import { coinbaseSpotAdapter } from "../src/clients/coinbase-adapter.js";
import { aggregateCandles } from "../src/clients/coinbase.js";
import type { ExchangeAdapter } from "../src/exchange.js";
import { COINBASE_TOP10_ASSETS, COINBASE_TOP10_SPOT } from "../src/whitelist.js";
import type { Candle } from "../src/analysis/indicators.js";

describe("coinbaseSpotAdapter", () => {
  // Compile-time check: assigning to ExchangeAdapter proves the adapter
  // satisfies the interface contract.
  const adapter: ExchangeAdapter = coinbaseSpotAdapter;

  it("declares Coinbase spot capabilities", () => {
    expect(adapter.id).toBe("coinbase-spot");
    expect(adapter.kind).toBe("spot");
    expect(adapter.supportsShort).toBe(false);
    expect(adapter.supportsLeverage).toBe(false);
  });

  it("exposes all required market-data methods", () => {
    expect(typeof adapter.getKlines).toBe("function");
    expect(typeof adapter.getTicker).toBe("function");
    expect(typeof adapter.symbolExists).toBe("function");
    expect(typeof adapter.findCanonicalSymbol).toBe("function");
  });

  it("omits futures-only methods on spot", () => {
    expect(adapter.getFundingRate).toBeUndefined();
  });

  it("exposes getBalances (S2b)", () => {
    expect(typeof adapter.getBalances).toBe("function");
  });

  it("omits order methods (added in S4 behind safety rails)", () => {
    expect(adapter.placeOrder).toBeUndefined();
    expect(adapter.cancelOrder).toBeUndefined();
    expect(adapter.getOpenOrders).toBeUndefined();
  });
});

describe("aggregateCandles", () => {
  const mkCandle = (t: number, o: number, h: number, l: number, c: number, v: number): Candle => ({
    t, o, h, l, c, v,
  });

  it("returns input unchanged when factor is 1", () => {
    const cs = [mkCandle(1, 10, 11, 9, 10, 100), mkCandle(2, 10, 12, 9, 11, 200)];
    expect(aggregateCandles(cs, 1)).toEqual(cs);
  });

  it("folds 4 hourly bars into one 4h bar", () => {
    const cs = [
      mkCandle(1, 10, 11, 9,  10, 100),  // open=10, h=11, l=9
      mkCandle(2, 10, 13, 8,  11, 200),  // h=13, l=8
      mkCandle(3, 11, 12, 10, 12, 150),
      mkCandle(4, 12, 14, 11, 13, 250),  // last close=13, h=14
    ];
    const [agg] = aggregateCandles(cs, 4);
    expect(agg).toBeDefined();
    expect(agg!.t).toBe(1);
    expect(agg!.o).toBe(10);
    expect(agg!.c).toBe(13);
    expect(agg!.h).toBe(14);
    expect(agg!.l).toBe(8);
    expect(agg!.v).toBe(700);
  });

  it("drops trailing partial group when not a multiple of factor", () => {
    const cs = [
      mkCandle(1, 1, 1, 1, 1, 1),
      mkCandle(2, 1, 1, 1, 1, 1),
      mkCandle(3, 1, 1, 1, 1, 1),
      mkCandle(4, 1, 1, 1, 1, 1),
      mkCandle(5, 1, 1, 1, 1, 1),   // partial 4h group — dropped
    ];
    expect(aggregateCandles(cs, 4)).toHaveLength(1);
  });
});

describe("whitelist", () => {
  it("has exactly 10 spot pairs", () => {
    expect(COINBASE_TOP10_SPOT).toHaveLength(10);
  });

  it("has matching asset/pair arrays", () => {
    expect(COINBASE_TOP10_ASSETS).toHaveLength(COINBASE_TOP10_SPOT.length);
  });

  it("every pair quotes in USDC (EU consumer accounts can't hold USD)", () => {
    for (const sym of COINBASE_TOP10_SPOT) {
      expect(sym).toMatch(/-USDC$/);
    }
  });
});
