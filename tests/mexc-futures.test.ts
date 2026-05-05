import { describe, expect, it } from "vitest";
import { analyzeFundingRate } from "../src/clients/mexc-futures.js";

describe("analyzeFundingRate", () => {
  const baseInfo = (rate: number) => ({
    symbol: "BTC_USDT",
    fundingRate: rate,
    maxFundingRate: 0.0018,
    minFundingRate: -0.0018,
    collectCycle: 8,
    nextSettleTime: 0,
  });

  it("classifies paid-to-long when rate is strongly negative", () => {
    const a = analyzeFundingRate(baseInfo(-0.001));
    expect(a.regime).toBe("paid_to_long");
    expect(a.longBiasScore).toBeGreaterThan(0);
  });

  it("classifies neutral around zero", () => {
    const a = analyzeFundingRate(baseInfo(0));
    expect(a.regime).toBe("neutral");
  });

  it("classifies normal bull at +0.02%", () => {
    const a = analyzeFundingRate(baseInfo(0.0002));
    expect(a.regime).toBe("normal_bull");
    expect(a.longBiasScore).toBe(0);
  });

  it("classifies crowded long at +0.07%", () => {
    const a = analyzeFundingRate(baseInfo(0.0007));
    expect(a.regime).toBe("crowded_long");
    expect(a.longBiasScore).toBeLessThan(0);
  });

  it("classifies euphoria at +0.15%", () => {
    const a = analyzeFundingRate(baseInfo(0.0015));
    expect(a.regime).toBe("euphoria");
    expect(a.longBiasScore).toBeLessThan(-10);
  });

  it("computes APR correctly (8h cycle)", () => {
    // 0.01% per 8h = 0.01% × 3 × 365 = 10.95% APR
    const a = analyzeFundingRate(baseInfo(0.0001));
    expect(a.apr).toBeCloseTo(10.95, 1);
  });
});
