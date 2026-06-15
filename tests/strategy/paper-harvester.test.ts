/**
 * Paper-harvester engine — accounting correctness. This tracks (paper)
 * money, so the invariants must be exact.
 */

import { describe, expect, it } from "vitest";
import {
  createEmpty,
  markToMarket,
  rebalanceToTarget,
  currentWeights,
} from "../../src/strategy/paper-harvester.js";

const UNI = ["BTC-USDT", "ETH-USDT"];

describe("markToMarket", () => {
  it("cash only when no positions", () => {
    const s = createEmpty(UNI, 10_000);
    expect(markToMarket(s, { "BTC-USDT": 50_000, "ETH-USDT": 3_000 })).toBe(10_000);
  });
  it("cash + position value", () => {
    const s = { ...createEmpty(UNI, 0), cash: 1_000, units: { "BTC-USDT": 0.1 } };
    expect(markToMarket(s, { "BTC-USDT": 50_000 })).toBe(1_000 + 5_000);
  });
});

describe("rebalanceToTarget", () => {
  const prices = { "BTC-USDT": 50_000, "ETH-USDT": 2_500 };

  it("NAV after = NAV before − total cost (invariant)", () => {
    const s = createEmpty(UNI, 10_000);
    const { state, record } = rebalanceToTarget(s, { "BTC-USDT": 0.5, "ETH-USDT": 0.3 }, prices, 1_000);
    expect(record.navAfter).toBeCloseTo(record.navBefore - record.totalCost, 9);
    expect(markToMarket(state, prices)).toBeCloseTo(10_000 - record.totalCost, 9);
  });

  it("units match target dollar allocation", () => {
    const s = createEmpty(UNI, 10_000);
    const { state } = rebalanceToTarget(s, { "BTC-USDT": 0.5, "ETH-USDT": 0.3 }, prices, 1_000);
    // 50% of 10k = 5k / 50k = 0.1 BTC; 30% = 3k / 2.5k = 1.2 ETH
    expect(state.units["BTC-USDT"]).toBeCloseTo(0.1, 9);
    expect(state.units["ETH-USDT"]).toBeCloseTo(1.2, 9);
  });

  it("weights summing < 1 leave remainder in cash (de-risk to cash)", () => {
    const s = createEmpty(UNI, 10_000);
    const { state } = rebalanceToTarget(s, { "BTC-USDT": 0.4 }, prices, 1_000);
    const w = currentWeights(state, prices);
    // Sized off NAV-before; measured against NAV-after-cost → drifts a hair
    // above target. Economically 0.4.
    expect(w["BTC-USDT"]).toBeCloseTo(0.4, 3);
    // ~60% of NAV in cash (minus tiny cost)
    expect(state.cash / markToMarket(state, prices)).toBeGreaterThan(0.59);
  });

  it("re-rebalancing to the same target at the same prices costs ~nothing", () => {
    const s = createEmpty(UNI, 10_000);
    const tgt = { "BTC-USDT": 0.5, "ETH-USDT": 0.3 };
    const first = rebalanceToTarget(s, tgt, prices, 1_000);
    const second = rebalanceToTarget(first.state, tgt, prices, 2_000);
    // Only the cost-induced NAV drift gets re-traded — orders of magnitude
    // smaller than the initial entry, and negligible vs NAV.
    expect(second.record.totalCost).toBeLessThan(first.record.totalCost * 0.01);
    expect(second.record.turnover).toBeLessThan(0.001);
  });

  it("fully exiting to cash (empty target) sells everything", () => {
    const s = createEmpty(UNI, 10_000);
    const inP = rebalanceToTarget(s, { "BTC-USDT": 0.5 }, prices, 1_000).state;
    const out = rebalanceToTarget(inP, {}, prices, 2_000).state;
    expect(out.units["BTC-USDT"]).toBeCloseTo(0, 9);
    // all value back in cash (minus two rounds of cost)
    expect(out.cash).toBeCloseTo(markToMarket(out, prices), 9);
  });

  it("seeds buy-hold benchmark units on first rebalance", () => {
    const s = createEmpty(UNI, 10_000);
    const { state } = rebalanceToTarget(s, { "BTC-USDT": 0.5 }, prices, 1_000);
    expect(state.benchUnits).toBeCloseTo(10_000 / 50_000, 9); // 0.2 BTC
  });

  it("profits when held assets appreciate", () => {
    const s = createEmpty(UNI, 10_000);
    const inP = rebalanceToTarget(s, { "BTC-USDT": 1.0 }, prices, 1_000).state;
    const navAtEntry = markToMarket(inP, prices);
    const up = { "BTC-USDT": 60_000, "ETH-USDT": 2_500 };
    expect(markToMarket(inP, up)).toBeGreaterThan(navAtEntry);
  });
});
