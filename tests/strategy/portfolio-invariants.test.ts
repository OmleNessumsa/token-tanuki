/**
 * Multi-premium portfolio — correctness INVARIANTS (CB-025).
 *
 * These guard the properties the OOS gate's verdict depends on. If any of these
 * break, the cert numbers are meaningless. Covered:
 *   1. NO LOOK-AHEAD — for TrendSleeve, FundingCarrySleeve, AND the allocator:
 *      mutating any bar > i must not change the decision at i.
 *   2. DELTA-NEUTRAL NETTING — Sleeve B emits balanced ±w pairs; Σ weight per
 *      legGroup ≈ 0, and the allocator preserves that after scaling/merge.
 *   3. KELLY CAP — allocator's kellyFraction ∈ [min, 0.25], NEVER full Kelly,
 *      even if a misconfigured AllocatorConfig asks for more.
 *   4. VOL-TARGET TRACKING — estPortfolioVol ≤ targetAnnualVol (de-risk only,
 *      never levered above), and gross ≤ maxGross.
 *   5. DE-RISK ONLY — no leverage: gross never exceeds maxGross.
 */

import { describe, expect, it } from "vitest";
import { createTrendSleeve } from "../../src/strategy/sleeves/trend-sleeve.js";
import { createFundingCarrySleeve } from "../../src/strategy/sleeves/funding-carry-sleeve.js";
import { createAllocator, DEFAULT_ALLOCATOR_CONFIG } from "../../src/strategy/allocator.js";
import type { MarketData } from "../../src/strategy/sleeve.js";
import {
  synthAsset,
  risingAsset,
  synthPair,
  corruptAfter,
  corruptPairAfter,
  buildGrid,
} from "./_helpers.js";

describe("no look-ahead — TrendSleeve", () => {
  it("mutating bars after i does not change the trend target at i", () => {
    const a = synthAsset("AAA", 250, 7);
    const b = synthAsset("BBB", 250, 99);
    const grid = buildGrid([a, b]);
    const data: MarketData = { grid, assets: [a, b], pairs: [] };
    const sleeve = createTrendSleeve({}, ["AAA", "BBB"]);

    const i = 150;
    const before = sleeve.targetAt(data, i);
    const cutoff = grid[i]!;
    const mutated: MarketData = {
      grid,
      assets: [corruptAfter(a, cutoff), corruptAfter(b, cutoff)],
      pairs: [],
    };
    const after = sleeve.targetAt(mutated, i);
    expect(after.legs).toEqual(before.legs);
    expect(after.estAnnualVol).toBeCloseTo(before.estAnnualVol, 12);
    expect(after.expectedReturn).toBeCloseTo(before.expectedReturn, 12);
  });
});

describe("no look-ahead — FundingCarrySleeve", () => {
  it("mutating candles AND funding after i does not change the carry target at i", () => {
    const p = synthPair("BTC", 200, 3);
    const grid = buildGrid([], [p]);
    const data: MarketData = { grid, assets: [], pairs: [p] };
    const sleeve = createFundingCarrySleeve();

    const i = 120;
    const before = sleeve.targetAt(data, i);
    const cutoff = grid[i]!;
    const mutated: MarketData = { grid, assets: [], pairs: [corruptPairAfter(p, cutoff)] };
    const after = sleeve.targetAt(mutated, i);
    expect(after.legs).toEqual(before.legs);
    expect(after.estAnnualVol).toBeCloseTo(before.estAnnualVol, 12);
    expect(after.expectedReturn).toBeCloseTo(before.expectedReturn, 12);
  });
});

describe("no look-ahead — PortfolioAllocator", () => {
  it("mutating bars after i does not change allocateAt(i)", () => {
    const a = synthAsset("AAA", 250, 11);
    const b = synthAsset("BBB", 250, 22);
    const p = synthPair("CCC", 250, 33);
    const grid = buildGrid([a, b], [p]);
    const data: MarketData = { grid, assets: [a, b], pairs: [p] };
    const alloc = createAllocator([
      createTrendSleeve({}, ["AAA", "BBB"]),
      createFundingCarrySleeve(),
    ]);

    const i = 150;
    const before = alloc.allocateAt(data, i);
    const cutoff = grid[i]!;
    const mutated: MarketData = {
      grid,
      assets: [corruptAfter(a, cutoff), corruptAfter(b, cutoff)],
      pairs: [corruptPairAfter(p, cutoff)],
    };
    const after = alloc.allocateAt(mutated, i);
    expect(after.book).toEqual(before.book);
    expect(after.estPortfolioVol).toBeCloseTo(before.estPortfolioVol, 12);
    expect(after.allocations).toEqual(before.allocations);
  });
});

describe("delta-neutral netting — FundingCarrySleeve", () => {
  it("Σ weight over each legGroup is ≈ 0 (balanced ±w pairs)", () => {
    const p1 = synthPair("BTC", 200, 5);
    const p2 = synthPair("ETH", 200, 6);
    const grid = buildGrid([], [p1, p2]);
    const data: MarketData = { grid, assets: [], pairs: [p1, p2] };
    const sleeve = createFundingCarrySleeve();

    let sawAnyPair = false;
    for (let i = 60; i < grid.length; i += 10) {
      const t = sleeve.targetAt(data, i);
      const byGroup = new Map<string, number>();
      for (const leg of t.legs) byGroup.set(leg.legGroup, (byGroup.get(leg.legGroup) ?? 0) + leg.weight);
      for (const [, net] of byGroup) {
        sawAnyPair = true;
        expect(Math.abs(net)).toBeLessThan(1e-9);
      }
    }
    expect(sawAnyPair).toBe(true); // the fixture actually entered positions
  });

  it("allocator preserves delta-neutrality after scaling + merge", () => {
    const p = synthPair("BTC", 200, 8);
    const grid = buildGrid([], [p]);
    const data: MarketData = { grid, assets: [], pairs: [p] };
    const alloc = createAllocator([createFundingCarrySleeve()]);

    let sawGroup = false;
    for (let i = 60; i < grid.length; i += 10) {
      const r = alloc.allocateAt(data, i);
      const byGroup = new Map<string, number>();
      for (const leg of r.book) byGroup.set(leg.legGroup, (byGroup.get(leg.legGroup) ?? 0) + leg.weight);
      for (const [, net] of byGroup) {
        sawGroup = true;
        expect(Math.abs(net)).toBeLessThan(1e-9);
      }
    }
    expect(sawGroup).toBe(true);
  });
});

describe("Kelly cap — allocator clamps to ≤ 0.25, never full Kelly", () => {
  it("default config keeps kellyFraction in [min, 0.25]", () => {
    const a = risingAsset("AAA", 250); // always deployed → high expectedReturn
    const grid = buildGrid([a]);
    const data: MarketData = { grid, assets: [a], pairs: [] };
    const alloc = createAllocator([createTrendSleeve({}, ["AAA"])]);

    for (let i = 110; i < grid.length; i += 5) {
      const r = alloc.allocateAt(data, i);
      for (const al of r.allocations) {
        if (al.scale <= 0) continue;
        expect(al.kellyFraction).toBeGreaterThanOrEqual(DEFAULT_ALLOCATOR_CONFIG.kellyFractionMin - 1e-12);
        expect(al.kellyFraction).toBeLessThanOrEqual(0.25 + 1e-12);
      }
    }
  });

  it("a config asking for FULL Kelly (1.0) is CLAMPED to 0.25, not honored", () => {
    const a = risingAsset("AAA", 250);
    const grid = buildGrid([a]);
    const data: MarketData = { grid, assets: [a], pairs: [] };
    // Adversarial config: demand full Kelly + leverage. Must be sanitized.
    const alloc = createAllocator([createTrendSleeve({}, ["AAA"])], {
      kellyFractionMin: 0.5,
      kellyFractionMax: 1.0,
      maxGross: 5,
    });
    expect(alloc.config.kellyFractionMax).toBeLessThanOrEqual(0.25 + 1e-12);
    for (let i = 110; i < grid.length; i += 5) {
      const r = alloc.allocateAt(data, i);
      for (const al of r.allocations) {
        if (al.scale <= 0) continue;
        expect(al.kellyFraction).toBeLessThanOrEqual(0.25 + 1e-12);
      }
    }
  });
});

describe("vol-target tracking + de-risk only", () => {
  it("estPortfolioVol respects targetAnnualVol (de-risk only, no over-lever)", () => {
    const a = risingAsset("AAA", 250, 0.01); // high-vol rising asset
    const b = synthAsset("BBB", 250, 44, 0.002);
    const grid = buildGrid([a, b]);
    const data: MarketData = { grid, assets: [a, b], pairs: [] };
    const alloc = createAllocator([createTrendSleeve({}, ["AAA", "BBB"])]);

    for (let i = 110; i < grid.length; i += 5) {
      const r = alloc.allocateAt(data, i);
      // Allocator scales to HIT target but caps at gross — estimated vol must
      // never exceed target (de-risk only; it may sit below when gross-capped).
      expect(r.estPortfolioVol).toBeLessThanOrEqual(DEFAULT_ALLOCATOR_CONFIG.targetAnnualVol + 1e-9);
    }
  });

  it("gross exposure never exceeds maxGross on any bar (no leverage)", () => {
    const a = risingAsset("AAA", 250, 0.012);
    const grid = buildGrid([a]);
    const data: MarketData = { grid, assets: [a], pairs: [] };
    const alloc = createAllocator([createTrendSleeve({}, ["AAA"])]);
    for (let i = 110; i < grid.length; i += 3) {
      const r = alloc.allocateAt(data, i);
      const gross = r.book.reduce((acc, l) => acc + Math.abs(l.weight), 0);
      expect(gross).toBeLessThanOrEqual(DEFAULT_ALLOCATOR_CONFIG.maxGross + 1e-9);
    }
  });
});
