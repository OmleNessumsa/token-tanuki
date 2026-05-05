/**
 * Breakout-proximity + relative-volume detector.
 *
 * Captures the kind of setup Connors-style breakout traders look for:
 *   - Price breaking above the N-day high (default 20)
 *   - Confirmed by relative volume (today's vol vs prior N-day average)
 *
 * This complements the long-term trend filter (Minervini Stage 2) by surfacing
 * tactical breakouts that may occur even when the macro trend is flat or bearish.
 *
 * The "20-day high" rule comes from Donchian / Turtles; relative volume confirmation
 * is standard practice across O'Neil CANSLIM, Minervini SEPA, Connors short-term setups.
 */

import type { Candle } from "./indicators.js";

export type BreakoutState =
  | "broken_out"      // close > breakout level
  | "at_breakout"     // within 1% below
  | "approaching"     // 1-3% below
  | "below_range"     // > 3% below or in middle of range
  | "below_breakdown"; // close < N-day low (mirror — bearish breakout)

export interface BreakoutResult {
  state: BreakoutState;
  breakoutLevel: number;       // N-day high (excluding today's bar)
  breakdownLevel: number;      // N-day low (excluding today)
  currentClose: number;
  distanceToBreakoutPct: number;  // negative if above (broken out)
  relativeVolume: number;      // today vol / avg of prior N
  volumeConfirmed: boolean;    // relVol >= 1.5
  /** Score contribution to a chart layer that wants to incorporate this. 0..15. */
  score: number;
  description: string;
}

export interface BreakoutOpts {
  lookback?: number;          // default 20 bars
  approachingMaxPct?: number; // default 3%
  atBreakoutMaxPct?: number;  // default 1%
  volumeConfirmThreshold?: number; // default 1.5
  /** Set false to skip score boost from a breakout that doesn't have volume. */
  requireVolumeConfirmation?: boolean;
}

const DEFAULTS: Required<BreakoutOpts> = {
  lookback: 20,
  approachingMaxPct: 3,
  atBreakoutMaxPct: 1,
  volumeConfirmThreshold: 1.5,
  requireVolumeConfirmation: false,
};

export function detectBreakout(candles: readonly Candle[], opts: BreakoutOpts = {}): BreakoutResult | null {
  const o = { ...DEFAULTS, ...opts };
  if (candles.length < o.lookback + 1) return null;

  const today = candles[candles.length - 1]!;
  const prior = candles.slice(-o.lookback - 1, -1); // N bars before today
  if (prior.length < o.lookback) return null;

  const breakoutLevel = Math.max(...prior.map((c) => c.h));
  const breakdownLevel = Math.min(...prior.map((c) => c.l));
  const avgVol = prior.reduce((acc, c) => acc + c.v, 0) / prior.length;
  const relVol = avgVol > 0 ? today.v / avgVol : 0;
  const volumeConfirmed = relVol >= o.volumeConfirmThreshold;

  const distanceToBreakoutPct = ((breakoutLevel - today.c) / today.c) * 100;
  const distanceToBreakdownPct = ((today.c - breakdownLevel) / today.c) * 100;

  let state: BreakoutState;
  let score = 0;
  let description: string;

  if (today.c > breakoutLevel) {
    state = "broken_out";
    if (volumeConfirmed) {
      // Strong: relVol ≥ 2 → max score; 1.5-2 → ~10
      score = Math.min(15, 6 + Math.min(8, (relVol - 1.5) * 3));
      description = `Broke ${o.lookback}d high $${breakoutLevel.toFixed(2)} (close $${today.c.toFixed(2)}, +${(-distanceToBreakoutPct).toFixed(2)}%) with ${relVol.toFixed(2)}× relative volume`;
    } else {
      score = o.requireVolumeConfirmation ? 0 : 4;
      description = `Broke ${o.lookback}d high $${breakoutLevel.toFixed(2)} but only ${relVol.toFixed(2)}× volume — weak confirmation`;
    }
  } else if (distanceToBreakoutPct <= o.atBreakoutMaxPct) {
    state = "at_breakout";
    score = volumeConfirmed ? 5 : 2;
    description = `${distanceToBreakoutPct.toFixed(2)}% below ${o.lookback}d high $${breakoutLevel.toFixed(2)} — primed for breakout (relVol ${relVol.toFixed(2)}×)`;
  } else if (distanceToBreakoutPct <= o.approachingMaxPct) {
    state = "approaching";
    score = 0; // info only, no boost
    description = `${distanceToBreakoutPct.toFixed(2)}% below ${o.lookback}d high $${breakoutLevel.toFixed(2)} — approaching (relVol ${relVol.toFixed(2)}×)`;
  } else if (today.c < breakdownLevel) {
    state = "below_breakdown";
    score = volumeConfirmed ? -10 : -3;
    description = `Broke below ${o.lookback}d low $${breakdownLevel.toFixed(2)} on ${relVol.toFixed(2)}× volume — bearish breakdown`;
  } else {
    state = "below_range";
    score = 0;
    description = `Inside ${o.lookback}d range ($${breakdownLevel.toFixed(2)}–$${breakoutLevel.toFixed(2)}), ${distanceToBreakoutPct.toFixed(1)}% below high`;
  }

  return {
    state,
    breakoutLevel,
    breakdownLevel,
    currentClose: today.c,
    distanceToBreakoutPct,
    relativeVolume: relVol,
    volumeConfirmed,
    score,
    description,
  };
}
