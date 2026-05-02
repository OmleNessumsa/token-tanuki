import type { Candle } from "./indicators.js";

export type CandlePattern =
  | "bullishEngulfing"
  | "bearishEngulfing"
  | "hammer"
  | "shootingStar"
  | "morningStar"
  | "eveningStar"
  | "threeWhiteSoldiers"
  | "threeBlackCrows"
  | "doji";

export interface PatternHit {
  pattern: CandlePattern;
  index: number;
  bullish: boolean;
}

const body = (c: Candle): number => Math.abs(c.c - c.o);
const range = (c: Candle): number => Math.max(c.h - c.l, 1e-12);
const upperWick = (c: Candle): number => c.h - Math.max(c.o, c.c);
const lowerWick = (c: Candle): number => Math.min(c.o, c.c) - c.l;
const isGreen = (c: Candle): boolean => c.c > c.o;
const isRed = (c: Candle): boolean => c.c < c.o;

export function detectCandlePatterns(candles: readonly Candle[]): PatternHit[] {
  const hits: PatternHit[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (body(c) / range(c) < 0.1) hits.push({ pattern: "doji", index: i, bullish: false });

    if (lowerWick(c) >= 2 * body(c) && upperWick(c) < body(c) && body(c) > 0) {
      hits.push({ pattern: "hammer", index: i, bullish: true });
    }
    if (upperWick(c) >= 2 * body(c) && lowerWick(c) < body(c) && body(c) > 0) {
      hits.push({ pattern: "shootingStar", index: i, bullish: false });
    }

    if (i >= 1) {
      const prev = candles[i - 1]!;
      if (isRed(prev) && isGreen(c) && c.o <= prev.c && c.c >= prev.o && body(c) > body(prev)) {
        hits.push({ pattern: "bullishEngulfing", index: i, bullish: true });
      }
      if (isGreen(prev) && isRed(c) && c.o >= prev.c && c.c <= prev.o && body(c) > body(prev)) {
        hits.push({ pattern: "bearishEngulfing", index: i, bullish: false });
      }
    }

    if (i >= 2) {
      const a = candles[i - 2]!;
      const b = candles[i - 1]!;
      const cc = c;
      if (isRed(a) && body(b) < body(a) * 0.5 && isGreen(cc) && cc.c > (a.o + a.c) / 2) {
        hits.push({ pattern: "morningStar", index: i, bullish: true });
      }
      if (isGreen(a) && body(b) < body(a) * 0.5 && isRed(cc) && cc.c < (a.o + a.c) / 2) {
        hits.push({ pattern: "eveningStar", index: i, bullish: false });
      }
      if (isGreen(a) && isGreen(b) && isGreen(cc)
          && b.c > a.c && cc.c > b.c
          && body(a) > range(a) * 0.6 && body(b) > range(b) * 0.6 && body(cc) > range(cc) * 0.6) {
        hits.push({ pattern: "threeWhiteSoldiers", index: i, bullish: true });
      }
      if (isRed(a) && isRed(b) && isRed(cc)
          && b.c < a.c && cc.c < b.c
          && body(a) > range(a) * 0.6 && body(b) > range(b) * 0.6 && body(cc) > range(cc) * 0.6) {
        hits.push({ pattern: "threeBlackCrows", index: i, bullish: false });
      }
    }
  }
  return hits;
}

export function recentPatterns(hits: readonly PatternHit[], totalCandles: number, lastN = 5): PatternHit[] {
  const cutoff = totalCandles - lastN;
  return hits.filter((h) => h.index >= cutoff);
}
