import type { Candle } from "./indicators.js";
import { maxDrawdown } from "./indicators.js";

export type Phase =
  | "stealthLaunch"
  | "initialPump"
  | "accumulation"
  | "parabolic"
  | "distribution"
  | "bleedOut"
  | "dead"
  | "unknown";

export interface PhaseResult {
  phase: Phase;
  ageHours: number | null;
  ddFromAth: number;
  buyability: "buy" | "wait" | "avoid";
  reason: string;
}

const wickAvg = (candles: readonly Candle[], n: number, side: "upper" | "lower"): number => {
  const slice = candles.slice(-n);
  if (slice.length === 0) return 0;
  return slice.reduce((acc, c) => {
    const upper = c.h - Math.max(c.o, c.c);
    const lower = Math.min(c.o, c.c) - c.l;
    return acc + (side === "upper" ? upper : lower);
  }, 0) / slice.length;
};

const bodyAvg = (candles: readonly Candle[], n: number): number => {
  const slice = candles.slice(-n);
  if (slice.length === 0) return 0;
  return slice.reduce((acc, c) => acc + Math.abs(c.c - c.o), 0) / slice.length;
};

const volumeMa = (candles: readonly Candle[], n: number, offsetFromEnd = 0): number => {
  const end = candles.length - offsetFromEnd;
  const start = Math.max(0, end - n);
  const slice = candles.slice(start, end);
  if (slice.length === 0) return 0;
  return slice.reduce((acc, c) => acc + c.v, 0) / slice.length;
};

export function classifyPhase(
  candles1m: readonly Candle[],
  candles5m: readonly Candle[],
  pairCreatedAtMs: number | null,
): PhaseResult {
  if (candles1m.length === 0 && candles5m.length === 0) {
    return { phase: "unknown", ageHours: null, ddFromAth: 0, buyability: "wait", reason: "no candles" };
  }

  const baseSeries = candles5m.length >= 20 ? candles5m : candles1m;
  const ageHours = pairCreatedAtMs ? (Date.now() - pairCreatedAtMs) / 3_600_000 : null;
  const closes = baseSeries.map((c) => c.c);
  const ath = Math.max(...baseSeries.map((c) => c.h));
  const last = closes[closes.length - 1] ?? 0;
  const ddFromAth = ath > 0 ? (ath - last) / ath : 0;
  const dd = maxDrawdown(closes);

  // Phase 1: stealth launch (very young + huge first candle)
  if (candles1m.length > 0 && candles1m.length < 10) {
    const first = candles1m[0]!;
    const firstBodyPct = first.o > 0 ? Math.abs(first.c - first.o) / first.o : 0;
    if (firstBodyPct > 1.0) {
      return { phase: "stealthLaunch", ageHours, ddFromAth, buyability: "avoid", reason: "stealth/sniper launch — be exit liquidity, do not chase" };
    }
  }

  // Phase 7: dead chart — recent volume collapsed vs all-time average
  const historicalVol = baseSeries.length > 0 ? baseSeries.reduce((acc, c) => acc + c.v, 0) / baseSeries.length : 0;
  const recentVol10 = volumeMa(baseSeries, 10);
  if (ddFromAth > 0.9 && historicalVol > 0 && recentVol10 < historicalVol * 0.1) {
    return { phase: "dead", ageHours, ddFromAth, buyability: "avoid", reason: ">90% drawdown + near-zero recent volume" };
  }

  // Phase 6: bleed-out
  if (baseSeries.length >= 12 && ddFromAth > 0.5) {
    let lowerHighs = 0;
    for (let i = baseSeries.length - 6; i < baseSeries.length - 1; i++) {
      if (i > 0 && baseSeries[i]!.h < baseSeries[i - 1]!.h) lowerHighs++;
    }
    if (lowerHighs >= 3) {
      return { phase: "bleedOut", ageHours, ddFromAth, buyability: "avoid", reason: `bleed-out: -${(ddFromAth * 100).toFixed(0)}% from ATH, lower highs` };
    }
  }

  // Phase 5: distribution top
  if (ddFromAth < 0.15 && baseSeries.length >= 6) {
    const ua = wickAvg(baseSeries, 6, "upper");
    const ba = bodyAvg(baseSeries, 6);
    if (ba > 0 && ua / ba > 2) {
      return { phase: "distribution", ageHours, ddFromAth, buyability: "avoid", reason: "distribution top — long upper wicks at ATH, sellers absorbing" };
    }
  }

  // Phase 4: parabolic
  if (baseSeries.length >= 10) {
    const recentVol = volumeMa(baseSeries, 5);
    const baseVol = volumeMa(baseSeries, 60);
    if (baseVol > 0 && recentVol / baseVol > 5) {
      let consecGreen = 0;
      for (let i = baseSeries.length - 1; i >= 0 && i > baseSeries.length - 8; i--) {
        if (baseSeries[i]!.c > baseSeries[i]!.o) consecGreen++;
        else break;
      }
      if (consecGreen >= 4) {
        return { phase: "parabolic", ageHours, ddFromAth, buyability: "avoid", reason: "parabolic — volume 5x+ average, consecutive green candles, do not chase top" };
      }
    }
  }

  // Phase 2: initial pump
  if ((ageHours === null || ageHours < 6) && baseSeries.length >= 5 && dd < 0.4) {
    let consecGreen = 0;
    for (let i = baseSeries.length - 1; i >= 0; i--) {
      if (baseSeries[i]!.c > baseSeries[i]!.o) consecGreen++;
      else break;
    }
    if (consecGreen >= 3 && ddFromAth < 0.1) {
      return { phase: "initialPump", ageHours, ddFromAth, buyability: "wait", reason: "initial pump in progress — better entry on first dip" };
    }
  }

  // Phase 3: accumulation
  if (ddFromAth > 0.2 && ddFromAth < 0.6 && baseSeries.length >= 20) {
    const recentVol = volumeMa(baseSeries, 10);
    const earlierVol = volumeMa(baseSeries, 30, 10);
    if (earlierVol > 0 && recentVol / earlierVol < 0.6) {
      const recentRange = baseSeries.slice(-10).reduce((acc, c) => acc + (c.h - c.l), 0) / 10;
      const earlierRange = baseSeries.slice(-30, -10).reduce((acc, c) => acc + (c.h - c.l), 0) / 20;
      if (earlierRange > 0 && recentRange / earlierRange < 0.7) {
        return { phase: "accumulation", ageHours, ddFromAth, buyability: "buy", reason: "accumulation: pulled back, range compressed, volume declining — classic re-entry setup" };
      }
    }
  }

  return { phase: "unknown", ageHours, ddFromAth, buyability: "wait", reason: "no clear phase signal" };
}
