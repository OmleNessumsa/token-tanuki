/**
 * Harvester strategy module — correctness invariants.
 *
 * The harvester drives real capital, so the properties that matter are:
 *  1. NO LOOK-AHEAD: weights in force on day i, and the realized return for
 *     day i, depend only on bars up to i — mutating future bars must not
 *     change them.
 *  2. DE-RISK ONLY: gross exposure never exceeds maxGross (no accidental
 *     leverage), and an asset below its MA regime is never held.
 *  3. Stats math is correct on known inputs.
 */

import { describe, expect, it } from "vitest";
import {
  simulateHarvester,
  targetWeights,
  realizedAnnVol,
  aboveRegime,
  harvesterStats,
  certify,
  DEFAULT_HARVESTER_CONFIG,
  type AssetSeries,
  type HarvesterConfig,
} from "../../src/strategy/harvester.js";
import type { Candle } from "../../src/analysis/indicators.js";

const DAY = 86_400;

/** Deterministic pseudo-random walk (no Math.random — reproducible). */
function synthSeries(symbol: string, n: number, seed: number, drift = 0.001): AssetSeries {
  const candles: Candle[] = [];
  let price = 100;
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const shock = ((s / 0x7fffffff) - 0.5) * 0.06; // ±3% daily
    price *= Math.exp(drift + shock);
    candles.push({ t: i * DAY, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1000 });
  }
  return { symbol, candles };
}

const cfg: HarvesterConfig = { ...DEFAULT_HARVESTER_CONFIG, regimeMaPeriodDays: 50, volLookbackDays: 20 };

describe("no look-ahead", () => {
  it("mutating bars after i does not change weights in force on day i", () => {
    const a = synthSeries("AAA", 200, 7);
    const b = synthSeries("BBB", 200, 99);
    const base = simulateHarvester([a, b], cfg);

    // Corrupt every bar strictly after grid index 120 in both assets.
    const corrupt = (s: AssetSeries): AssetSeries => ({
      symbol: s.symbol,
      candles: s.candles.map((c, idx) => (idx > 120 ? { ...c, o: 1, h: 1, l: 1, c: 1, v: 1 } : c)),
    });
    const mutated = simulateHarvester([corrupt(a), corrupt(b)], cfg);

    // days array index k corresponds to grid position k+1. Weights in force
    // on day k were set at grid position k (info through k). For k <= 120
    // they must be identical, and the realized return for k <= 119 (which
    // uses closes at k and k+1, both untouched for k+1 <= 120) must match.
    for (let k = 0; k <= 119; k++) {
      expect(mutated.weightsByDay[k]).toEqual(base.weightsByDay[k]);
      expect(mutated.dailyReturns[k]).toBeCloseTo(base.dailyReturns[k]!, 12);
    }
  });

  it("realizedAnnVol and aboveRegime read only the trailing window", () => {
    const a = synthSeries("AAA", 100, 3);
    const closes = a.candles.map((c) => c.c as number | undefined);
    const volAt = realizedAnnVol(closes, 60, 20);
    const regAt = aboveRegime(closes, 60, 50);
    // Corrupt bars after 60.
    const corrupt = closes.map((c, i) => (i > 60 ? 1 : c));
    expect(realizedAnnVol(corrupt, 60, 20)).toBe(volAt);
    expect(aboveRegime(corrupt, 60, 50)).toBe(regAt);
  });
});

describe("de-risk only", () => {
  it("gross weight never exceeds maxGross on any day", () => {
    const series = [synthSeries("AAA", 300, 1), synthSeries("BBB", 300, 2), synthSeries("CCC", 300, 3)];
    const res = simulateHarvester(series, cfg);
    for (const w of res.weightsByDay) {
      const gross = Object.values(w).reduce((a, x) => a + x, 0);
      expect(gross).toBeLessThanOrEqual(cfg.maxGross + 1e-9);
      for (const x of Object.values(w)) expect(x).toBeGreaterThanOrEqual(0); // long-only
    }
  });

  it("an asset below its MA regime is not held", () => {
    // Monotonically falling series → always below MA → never eligible.
    const falling: AssetSeries = {
      symbol: "DOWN",
      candles: Array.from({ length: 120 }, (_, i) => {
        const p = 100 * Math.exp(-0.01 * i);
        return { t: i * DAY, o: p, h: p, l: p, c: p, v: 1 };
      }),
    };
    const w = targetWeights(new Map([["DOWN", falling.candles.map((c) => c.c as number | undefined)]]), 119, cfg);
    expect(w["DOWN"]).toBeUndefined();
  });
});

describe("stats", () => {
  it("computes positive Sharpe and correct CAGR on a steady up series", () => {
    const days = Array.from({ length: 365 }, (_, i) => i * DAY);
    const rets = days.map(() => 0.002); // +0.2%/day, zero variance bumped below
    // add tiny noise so sd>0
    const noisy = rets.map((r, i) => r + (i % 2 === 0 ? 0.0001 : -0.0001));
    const s = harvesterStats(noisy, days);
    expect(s.sharpe).toBeGreaterThan(0);
    expect(s.cagr).toBeGreaterThan(0.5); // ~ (1.002)^365 - 1 ≈ 1.07
    expect(s.maxDD).toBeLessThan(0.05);
  });

  it("maxDD reflects a mid-series crash", () => {
    const days = Array.from({ length: 10 }, (_, i) => i * DAY);
    const rets = [0.1, 0.1, -0.5, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
    const s = harvesterStats(rets, days);
    expect(s.maxDD).toBeGreaterThan(0.49);
  });

  it("certify fails when drawdown breaches the gate", () => {
    const days = Array.from({ length: 400 }, (_, i) => i * DAY);
    const strat = harvesterStats(days.map(() => 0.001), days);
    const crash = harvesterStats(days.map((_, i) => (i === 200 ? -0.6 : 0.001)), days);
    const v = certify(crash, strat);
    expect(v.pass).toBe(false);
    expect(v.checks.find((c) => c.name === "maxDD")!.pass).toBe(false);
  });
});
