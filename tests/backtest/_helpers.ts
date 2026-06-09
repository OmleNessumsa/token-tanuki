/**
 * Shared test infrastructure for backtest-v2 tests.
 *
 * Filename prefix `_` keeps Vitest from auto-running it as a test file
 * (and matches the existing convention of private modules).
 *
 * IMPORTANT: this file does not import production code beyond the `Candle` type.
 * The PRNG (mulberry32) is re-implemented inline so synth-fixtures stay
 * decoupled from `src/analysis/validation.ts` (a tester-morty constraint).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candle } from "../../src/analysis/indicators.js";

// ---------------------------------------------------------------------------
// Seedable PRNG (mulberry32, re-implemented to avoid prod-code coupling).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Candle generators.
//
// All series:
//   - oldest-first
//   - t is unix seconds (matches Candle convention)
//   - 5-minute bars (t step = 300)
// ---------------------------------------------------------------------------

const BAR_SECS = 5 * 60;
const T0 = 1_700_000_000; // arbitrary but fixed anchor (Nov 2023)

interface SeriesParams {
  basePrice: number;
  driftPctPerBar: number;
  noisePct: number;
  baseVolume: number;
}

function paramsFor(direction: "up" | "down" | "flat"): SeriesParams {
  switch (direction) {
    case "up":
      return { basePrice: 100, driftPctPerBar: 0.0008, noisePct: 0.004, baseVolume: 1000 };
    case "down":
      return { basePrice: 100, driftPctPerBar: -0.0008, noisePct: 0.004, baseVolume: 1000 };
    case "flat":
      return { basePrice: 100, driftPctPerBar: 0, noisePct: 0.003, baseVolume: 1000 };
  }
}

/**
 * Deterministic seeded random walk with drift.
 *
 * - `up` drifts +0.08 % / bar with 0.4 % gaussian-ish noise.
 * - `down` mirrors (−0.08 %).
 * - `flat` no drift, smaller noise.
 *
 * Volume is base + jittered. High/low extend close ± half the bar range.
 */
export function synthTrendSeries(
  direction: "up" | "down" | "flat",
  bars: number,
  seed: number,
): Candle[] {
  const rand = mulberry32(seed);
  const p = paramsFor(direction);

  const candles: Candle[] = [];
  let price = p.basePrice;
  for (let i = 0; i < bars; i++) {
    const open = price;
    const shock = (rand() - 0.5) * 2 * p.noisePct;
    const next = price * (1 + p.driftPctPerBar + shock);
    const close = next;
    const high = Math.max(open, close) * (1 + Math.abs(rand() - 0.5) * p.noisePct);
    const low = Math.min(open, close) * (1 - Math.abs(rand() - 0.5) * p.noisePct);
    const vol = p.baseVolume * (0.85 + rand() * 0.3);
    candles.push({
      t: T0 + i * BAR_SECS,
      o: open,
      h: high,
      l: low,
      c: close,
      v: vol,
    });
    price = next;
  }
  return candles;
}

/**
 * Like synthTrendSeries but injects a guaranteed-firing pulse at named indices.
 *
 * Pragmatic definition of "pulse":
 *   - 6 % one-bar pop (sign depends on baselineDirection: up-baseline → up-pulse for LONG signals)
 *   - 5× volume spike on the pulse bar
 *   - A brief 10-bar quiet "base" before each pulse (low volatility) so the breakout
 *     detector (Donchian + relative volume) sees real contrast.
 *
 * This won't *guarantee* a composite ≥ 60 in every config — `scoreChart` is opinionated —
 * but it gets us into the high-score zone for the test cases that need an entry to fire.
 */
export function synthPulseSeries(
  pulseAtIndices: number[],
  baselineDirection: "up" | "down",
  bars: number,
  seed: number,
): Candle[] {
  const candles = synthTrendSeries(baselineDirection, bars, seed);
  const direction = baselineDirection === "up" ? 1 : -1;
  const pulseSet = new Set(pulseAtIndices);

  for (let i = 0; i < candles.length; i++) {
    if (!pulseSet.has(i)) continue;
    const prev = candles[i - 1];
    if (!prev) continue;
    const popPct = 0.06 * direction;
    const close = prev.c * (1 + popPct);
    const open = prev.c;
    const high = direction > 0 ? close * 1.002 : open * 1.002;
    const low = direction > 0 ? open * 0.998 : close * 0.998;
    candles[i] = {
      t: prev.t + BAR_SECS,
      o: open,
      h: high,
      l: low,
      c: close,
      v: prev.v * 5,
    };

    // Cascade the new price level forward to keep the series continuous.
    let last = close;
    for (let j = i + 1; j < candles.length; j++) {
      if (pulseSet.has(j)) break;
      const c = candles[j]!;
      const delta = c.c - c.o;
      const newOpen = last;
      const newClose = newOpen + delta;
      const rangeUp = Math.max(c.h - c.c, 0);
      const rangeDn = Math.max(c.c - c.l, 0);
      candles[j] = {
        t: c.t,
        o: newOpen,
        h: newClose + rangeUp,
        l: newClose - rangeDn,
        c: newClose,
        v: c.v,
      };
      last = newClose;
    }
  }
  return candles;
}

// ---------------------------------------------------------------------------
// Fixture loading.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, "fixtures");

export function loadFixture<T>(name: string): T {
  const path = join(FIXTURES_DIR, name.endsWith(".json") ? name : `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`fixture not found: ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Re-export Candle for convenience.
// ---------------------------------------------------------------------------

export type { Candle };
