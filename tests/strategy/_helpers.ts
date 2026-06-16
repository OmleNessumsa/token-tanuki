/**
 * Test fixtures + deterministic synth generators for the multi-premium
 * portfolio gate (CB-025). Private to tests. No Math.random — every series is
 * seeded and reproducible so invariant tests are deterministic.
 */

import type { Candle } from "../../src/analysis/indicators.js";
import type {
  AssetCandles,
  FundingPairData,
  FundingPoint,
} from "../../src/strategy/sleeve.js";

export const DAY = 86_400; // seconds

/** Deterministic LCG in [0,1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Seeded geometric random walk as a daily candle series. */
export function synthCandles(n: number, seed: number, drift = 0.0008, vol = 0.03): Candle[] {
  const rnd = lcg(seed);
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const shock = (rnd() - 0.5) * 2 * vol;
    price *= Math.exp(drift + shock);
    candles.push({ t: i * DAY, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1000 });
  }
  return candles;
}

export function synthAsset(symbol: string, n: number, seed: number, drift = 0.0008): AssetCandles {
  return { symbol, candles: synthCandles(n, seed, drift) };
}

/** A monotonically rising series (always in-regime, always above MA). */
export function risingAsset(symbol: string, n: number, dailyDrift = 0.004): AssetCandles {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price *= Math.exp(dailyDrift + (i % 2 === 0 ? 0.0005 : -0.0005));
    candles.push({ t: i * DAY, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1000 });
  }
  return { symbol, candles };
}

/**
 * Build a delta-neutral funding pair fixture. The proxy spot IS the perp (the
 * CB-023 first-cert proxy), so basis≈0. Funding is a constant positive rate
 * per 8h cycle (3/day) so the short-perp leg earns a steady carry — enough to
 * clear the cost+flip buffer and put on a position.
 */
export function synthPair(
  pair: string,
  n: number,
  seed: number,
  perRateCycle = 0.0006, // 6 bps/cycle ≈ rich, clears the buffer
): FundingPairData {
  const candles = synthCandles(n, seed);
  const spot: AssetCandles = { symbol: `${pair}-USDT`, candles };
  // Proxy spot === perp series (basis 0). Same candles.
  const perp: AssetCandles = { symbol: `${pair}-USDT`, candles };
  const funding: FundingPoint[] = [];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      funding.push({ tMs: (i * DAY + c * 8 * 3600) * 1000, rate: perRateCycle });
    }
  }
  return { pair, spot, perp, funding };
}

/** Mutate every candle strictly after `cutoff` (corrupt the future). */
export function corruptAfter(a: AssetCandles, cutoff: number): AssetCandles {
  return {
    symbol: a.symbol,
    candles: a.candles.map((c) =>
      c.t > cutoff ? { ...c, o: 1, h: 1, l: 1, c: 1, v: 1 } : c,
    ),
  };
}

/** Corrupt a funding pair's future candles AND future funding settlements. */
export function corruptPairAfter(p: FundingPairData, cutoffSec: number): FundingPairData {
  return {
    pair: p.pair,
    spot: corruptAfter(p.spot, cutoffSec),
    perp: corruptAfter(p.perp, cutoffSec),
    funding: p.funding.map((f) =>
      f.tMs > cutoffSec * 1000 ? { tMs: f.tMs, rate: 999 } : f,
    ),
  };
}

/** Union day grid (unix sec) from assets and/or pairs. */
export function buildGrid(assets: AssetCandles[], pairs: FundingPairData[] = []): number[] {
  const set = new Set<number>();
  for (const a of assets) for (const c of a.candles) set.add(c.t);
  for (const p of pairs) for (const c of p.perp.candles) set.add(c.t);
  return [...set].sort((x, y) => x - y);
}
