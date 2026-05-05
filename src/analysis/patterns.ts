import type { Candle } from "./indicators.js";
import * as cdl from "candlestick";

// All candle pattern keys we surface to the scorer. Names match weights.ts CANDLE_ALIASES.
export type CandlePattern =
  | "bullishEngulfing"
  | "bearishEngulfing"
  | "hammer"
  | "invertedHammer"
  | "shootingStar"
  | "hangingMan"
  | "morningStar"
  | "eveningStar"
  | "threeWhiteSoldiers"
  | "threeBlackCrows"
  | "bullishHarami"
  | "bearishHarami"
  | "piercingLine"
  | "darkCloudCover"
  | "doji"
  | "marubozu"
  | "bullishKicker"
  | "bearishKicker"
  | "tweezersTop"
  | "tweezersBottom";

export interface PatternHit {
  pattern: CandlePattern;
  index: number;
  bullish: boolean;
}

const BULLISH = new Set<CandlePattern>([
  "bullishEngulfing", "hammer", "invertedHammer", "morningStar",
  "threeWhiteSoldiers", "bullishHarami", "piercingLine",
  "bullishKicker", "tweezersBottom",
]);

interface CdlCandle { open: number; high: number; low: number; close: number; }

const toCdl = (c: Candle): CdlCandle => ({ open: c.o, high: c.h, low: c.l, close: c.c });

// Single-candle detectors (need only the current bar)
const SINGLE: Array<[CandlePattern, (c: CdlCandle) => boolean]> = [
  ["hammer",         (c) => cdl.isHammer(c) === true],
  ["invertedHammer", (c) => cdl.isInvertedHammer(c) === true],
  ["doji",           (c) => cdl.isDoji(c) === true],
  ["marubozu",       (c) => cdl.isMarubozu(c) === true],
];

// Two-candle detectors (previous + current)
const TWO: Array<[CandlePattern, (a: CdlCandle, b: CdlCandle) => boolean]> = [
  ["bullishEngulfing", (a, b) => cdl.isBullishEngulfing(a, b) === true],
  ["bearishEngulfing", (a, b) => cdl.isBearishEngulfing(a, b) === true],
  ["bullishHarami",    (a, b) => cdl.isBullishHarami(a, b) === true],
  ["bearishHarami",    (a, b) => cdl.isBearishHarami(a, b) === true],
  ["bullishKicker",    (a, b) => cdl.isBullishKicker(a, b) === true],
  ["bearishKicker",    (a, b) => cdl.isBearishKicker(a, b) === true],
  ["piercingLine",     (a, b) => cdl.isPiercingLine(a, b) === true],
  ["darkCloudCover",   (a, b) => cdl.isDarkCloudCover(a, b) === true],
  ["tweezersTop",      (a, b) => cdl.isTweezersTop(a, b) === true],
  ["tweezersBottom",   (a, b) => cdl.isTweezersBottom(a, b) === true],
  ["shootingStar",     (a, b) => cdl.isShootingStar(a, b) === true],
  ["hangingMan",       (a, b) => cdl.isHangingMan(a, b) === true],
];

// Three-candle detectors
const THREE: Array<[CandlePattern, (a: CdlCandle, b: CdlCandle, c: CdlCandle) => boolean]> = [
  ["morningStar",        (a, b, c) => cdl.isMorningStar(a, b, c) === true],
  ["eveningStar",        (a, b, c) => cdl.isEveningStar(a, b, c) === true],
  ["threeWhiteSoldiers", (a, b, c) => cdl.isThreeWhiteSoldiers(a, b, c) === true],
  ["threeBlackCrows",    (a, b, c) => cdl.isThreeBlackCrows(a, b, c) === true],
];

export function detectCandlePatterns(candles: readonly Candle[]): PatternHit[] {
  const hits: PatternHit[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const cc = toCdl(c);
    for (const [name, test] of SINGLE) {
      try { if (test(cc)) hits.push({ pattern: name, index: i, bullish: BULLISH.has(name) }); }
      catch { /* lib may throw on malformed candle; skip */ }
    }
    if (i >= 1) {
      const a = toCdl(candles[i - 1]!);
      for (const [name, test] of TWO) {
        try { if (test(a, cc)) hits.push({ pattern: name, index: i, bullish: BULLISH.has(name) }); }
        catch {}
      }
    }
    if (i >= 2) {
      const a = toCdl(candles[i - 2]!);
      const b = toCdl(candles[i - 1]!);
      for (const [name, test] of THREE) {
        try { if (test(a, b, cc)) hits.push({ pattern: name, index: i, bullish: BULLISH.has(name) }); }
        catch {}
      }
    }
  }
  return hits;
}

export function recentPatterns(hits: readonly PatternHit[], totalCandles: number, lastN = 5): PatternHit[] {
  const cutoff = totalCandles - lastN;
  return hits.filter((h) => h.index >= cutoff);
}
