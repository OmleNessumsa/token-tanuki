/**
 * DeMark TD Sequential.
 * Source: Perl & DeMark, "DeMark Indicators" (Bloomberg Press, 2008).
 *
 * Two-phase exhaustion indicator:
 *   1. TD Setup: 9 consecutive closes vs close 4 bars earlier (potential reversal).
 *   2. TD Countdown: 13 bars where close vs high/low 2 bars earlier (strong reversal).
 *
 * Buy Setup (bearish exhaustion = bottom):
 *   - Bearish price flip: close > close[i-4] followed by close < close[i-4]
 *   - 9 consecutive closes each less than close 4 bars earlier
 *   - Interrupted by any close >= close[i-4]
 *
 * Sell Setup (bullish exhaustion = top): mirror with > comparisons.
 *
 * Buy Countdown (after Buy Setup #9):
 *   - 13 bars where close[i] <= low[i-2] (not required to be consecutive)
 *
 * Sell Countdown: close[i] >= high[i-2], 13 bars.
 *
 * Use as one input to a verdict, not standalone — DeMark himself emphasized
 * confirmation by other indicators.
 */

import type { Candle } from "./indicators.js";

export interface TdState {
  /** Setup bar count at this index (0..9). 9 = setup complete. */
  buySetupCount: number;
  sellSetupCount: number;
  /** Countdown count (0..13). 13 = countdown complete. */
  buyCountdownCount: number;
  sellCountdownCount: number;
  /** True on the bar where the corresponding signal completed. */
  buySetupComplete: boolean;
  sellSetupComplete: boolean;
  buyCountdownComplete: boolean;
  sellCountdownComplete: boolean;
}

export interface TdResult {
  perBar: TdState[];
  /** Most recent completed signal, if any. */
  lastSignal: {
    bar: number;
    kind: "buySetup" | "sellSetup" | "buyCountdown" | "sellCountdown";
  } | null;
}

const empty = (): TdState => ({
  buySetupCount: 0, sellSetupCount: 0,
  buyCountdownCount: 0, sellCountdownCount: 0,
  buySetupComplete: false, sellSetupComplete: false,
  buyCountdownComplete: false, sellCountdownComplete: false,
});

export function tdSequential(candles: readonly Candle[]): TdResult {
  const n = candles.length;
  const state: TdState[] = Array.from({ length: n }, empty);
  if (n < 10) return { perBar: state, lastSignal: null };

  let buySetup = 0;
  let sellSetup = 0;
  let buyCountdownActive = false;
  let sellCountdownActive = false;
  let buyCountdown = 0;
  let sellCountdown = 0;
  let lastSignal: TdResult["lastSignal"] = null;

  for (let i = 4; i < n; i++) {
    const c = candles[i]!.c;
    const c4 = candles[i - 4]!.c;

    // Buy setup: close < close[i-4]
    if (c < c4) buySetup++;
    else buySetup = 0;
    // Sell setup: close > close[i-4]
    if (c > c4) sellSetup++;
    else sellSetup = 0;

    state[i]!.buySetupCount = Math.min(buySetup, 9);
    state[i]!.sellSetupCount = Math.min(sellSetup, 9);

    if (buySetup === 9) {
      state[i]!.buySetupComplete = true;
      lastSignal = { bar: i, kind: "buySetup" };
      // Begin Buy Countdown
      buyCountdownActive = true;
      buyCountdown = 0;
      // Cancel any active Sell Countdown (opposing exhaustion)
      sellCountdownActive = false;
    }
    if (sellSetup === 9) {
      state[i]!.sellSetupComplete = true;
      lastSignal = { bar: i, kind: "sellSetup" };
      sellCountdownActive = true;
      sellCountdown = 0;
      buyCountdownActive = false;
    }

    // Buy Countdown: close <= low[i-2]
    if (buyCountdownActive && i >= 2) {
      const low2 = candles[i - 2]!.l;
      if (c <= low2) buyCountdown++;
      state[i]!.buyCountdownCount = Math.min(buyCountdown, 13);
      if (buyCountdown >= 13) {
        state[i]!.buyCountdownComplete = true;
        lastSignal = { bar: i, kind: "buyCountdown" };
        buyCountdownActive = false;
      }
    }
    if (sellCountdownActive && i >= 2) {
      const high2 = candles[i - 2]!.h;
      if (c >= high2) sellCountdown++;
      state[i]!.sellCountdownCount = Math.min(sellCountdown, 13);
      if (sellCountdown >= 13) {
        state[i]!.sellCountdownComplete = true;
        lastSignal = { bar: i, kind: "sellCountdown" };
        sellCountdownActive = false;
      }
    }
  }

  return { perBar: state, lastSignal };
}

/**
 * Convenience: was a TD signal emitted in the last N bars?
 * Useful for chart scoring — completed Buy Setup/Countdown in last 3 bars
 * is a meaningful exhaustion-of-downtrend signal.
 */
export function recentTdSignal(result: TdResult, lookback = 3): TdResult["lastSignal"] {
  const sig = result.lastSignal;
  if (!sig) return null;
  if (result.perBar.length - 1 - sig.bar > lookback) return null;
  return sig;
}
