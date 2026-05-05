import type { Candle } from "./indicators.js";
import { swings, type Swing } from "./indicators.js";

export type ChartPattern =
  | "doubleTop"
  | "doubleBottom"
  | "tripleTop"
  | "tripleBottom"
  | "headAndShoulders"
  | "inverseHeadAndShoulders"
  | "ascendingTriangle"
  | "descendingTriangle"
  | "symmetricalTriangle"
  | "cupAndHandle"
  | "highTightFlag"
  | "bullFlag";

export interface ChartPatternHit {
  pattern: ChartPattern;
  startIndex: number;
  endIndex: number;
  bullish: boolean;
  confidence: number;       // 0..1 how cleanly the geometry fits
  breakoutLevel: number;    // price at which the pattern is confirmed
  target?: number;          // measured-move target (optional)
  description: string;
}

interface DetectOpts {
  swingLookback?: number;   // bars on each side a swing must dominate
  similarityPct?: number;   // tolerance for "two peaks at similar price"
  minBarsBetween?: number;  // minimum spacing between key swings
  minDepthPct?: number;     // valley/peak depth between matched swings
}

const D: Required<DetectOpts> = {
  swingLookback: 3,
  similarityPct: 3,
  minBarsBetween: 10,
  minDepthPct: 10,
};

const pctDiff = (a: number, b: number): number => Math.abs(a - b) / ((a + b) / 2) * 100;

const between = (lo: number, hi: number, x: number): boolean => x >= lo && x <= hi;

/** ---------- Double Top / Double Bottom ---------- */

function detectDoubleExtremes(
  candles: readonly Candle[],
  highs: Swing[],
  lows: Swing[],
  opts: Required<DetectOpts>,
): ChartPatternHit[] {
  const hits: ChartPatternHit[] = [];
  if (candles.length < opts.minBarsBetween + opts.swingLookback * 2 + 2) return hits;

  // Double top: two adjacent swing highs at similar price with a valley between, then break below valley
  for (let i = 1; i < highs.length; i++) {
    const a = highs[i - 1]!;
    const b = highs[i]!;
    if (b.index - a.index < opts.minBarsBetween) continue;
    if (pctDiff(a.price, b.price) > opts.similarityPct) continue;
    // Find lowest low between the two peaks
    const valley = lows
      .filter((l) => l.index > a.index && l.index < b.index)
      .sort((p, q) => p.price - q.price)[0];
    if (!valley) continue;
    const peakLevel = (a.price + b.price) / 2;
    const drop = ((peakLevel - valley.price) / peakLevel) * 100;
    if (drop < opts.minDepthPct) continue;
    // Confirm: any close after b.index that drops below valley
    const confirmIdx = candles.findIndex((c, idx) => idx > b.index && c.c < valley.price);
    const confirmed = confirmIdx !== -1;
    const cleanness = Math.min(1, drop / 25); // depth ~25% = max confidence
    const symmetry = 1 - pctDiff(a.price, b.price) / opts.similarityPct;
    const target = valley.price - (peakLevel - valley.price); // measured move
    hits.push({
      pattern: "doubleTop",
      startIndex: a.index,
      endIndex: confirmed ? confirmIdx : b.index,
      bullish: false,
      confidence: confirmed ? Math.min(1, (cleanness + symmetry) / 2 + 0.2) : (cleanness + symmetry) / 4,
      breakoutLevel: valley.price,
      target,
      description: `Double top at ~${peakLevel.toFixed(4)} with valley ${valley.price.toFixed(4)} (${drop.toFixed(1)}% drop). ${confirmed ? "Neckline broken." : "Awaiting neckline break."}`,
    });
  }

  // Double bottom: mirror
  for (let i = 1; i < lows.length; i++) {
    const a = lows[i - 1]!;
    const b = lows[i]!;
    if (b.index - a.index < opts.minBarsBetween) continue;
    if (pctDiff(a.price, b.price) > opts.similarityPct) continue;
    const peak = highs
      .filter((h) => h.index > a.index && h.index < b.index)
      .sort((p, q) => q.price - p.price)[0];
    if (!peak) continue;
    const troughLevel = (a.price + b.price) / 2;
    const rise = ((peak.price - troughLevel) / troughLevel) * 100;
    if (rise < opts.minDepthPct) continue;
    const confirmIdx = candles.findIndex((c, idx) => idx > b.index && c.c > peak.price);
    const confirmed = confirmIdx !== -1;
    const cleanness = Math.min(1, rise / 25);
    const symmetry = 1 - pctDiff(a.price, b.price) / opts.similarityPct;
    const target = peak.price + (peak.price - troughLevel);
    hits.push({
      pattern: "doubleBottom",
      startIndex: a.index,
      endIndex: confirmed ? confirmIdx : b.index,
      bullish: true,
      confidence: confirmed ? Math.min(1, (cleanness + symmetry) / 2 + 0.2) : (cleanness + symmetry) / 4,
      breakoutLevel: peak.price,
      target,
      description: `Double bottom at ~${troughLevel.toFixed(4)} with peak ${peak.price.toFixed(4)} (${rise.toFixed(1)}% rise). ${confirmed ? "Neckline broken." : "Awaiting neckline break."}`,
    });
  }

  return hits;
}

/** ---------- Triple Top / Triple Bottom ---------- */

function detectTripleExtremes(
  candles: readonly Candle[],
  highs: Swing[],
  lows: Swing[],
  opts: Required<DetectOpts>,
): ChartPatternHit[] {
  const hits: ChartPatternHit[] = [];

  for (let i = 2; i < highs.length; i++) {
    const a = highs[i - 2]!, b = highs[i - 1]!, c = highs[i]!;
    if (b.index - a.index < opts.minBarsBetween || c.index - b.index < opts.minBarsBetween) continue;
    if (pctDiff(a.price, b.price) > opts.similarityPct || pctDiff(b.price, c.price) > opts.similarityPct) continue;
    const valley = lows
      .filter((l) => l.index > a.index && l.index < c.index)
      .sort((p, q) => p.price - q.price)[0];
    if (!valley) continue;
    const peakLevel = (a.price + b.price + c.price) / 3;
    const drop = ((peakLevel - valley.price) / peakLevel) * 100;
    if (drop < opts.minDepthPct) continue;
    const confirmIdx = candles.findIndex((cd, idx) => idx > c.index && cd.c < valley.price);
    const confirmed = confirmIdx !== -1;
    hits.push({
      pattern: "tripleTop",
      startIndex: a.index,
      endIndex: confirmed ? confirmIdx : c.index,
      bullish: false,
      confidence: confirmed ? 0.85 : 0.4,
      breakoutLevel: valley.price,
      target: valley.price - (peakLevel - valley.price),
      description: `Triple top at ~${peakLevel.toFixed(4)}. ${confirmed ? "Neckline broken." : "Awaiting break."}`,
    });
  }

  for (let i = 2; i < lows.length; i++) {
    const a = lows[i - 2]!, b = lows[i - 1]!, c = lows[i]!;
    if (b.index - a.index < opts.minBarsBetween || c.index - b.index < opts.minBarsBetween) continue;
    if (pctDiff(a.price, b.price) > opts.similarityPct || pctDiff(b.price, c.price) > opts.similarityPct) continue;
    const peak = highs
      .filter((h) => h.index > a.index && h.index < c.index)
      .sort((p, q) => q.price - p.price)[0];
    if (!peak) continue;
    const troughLevel = (a.price + b.price + c.price) / 3;
    const rise = ((peak.price - troughLevel) / troughLevel) * 100;
    if (rise < opts.minDepthPct) continue;
    const confirmIdx = candles.findIndex((cd, idx) => idx > c.index && cd.c > peak.price);
    const confirmed = confirmIdx !== -1;
    hits.push({
      pattern: "tripleBottom",
      startIndex: a.index,
      endIndex: confirmed ? confirmIdx : c.index,
      bullish: true,
      confidence: confirmed ? 0.85 : 0.4,
      breakoutLevel: peak.price,
      target: peak.price + (peak.price - troughLevel),
      description: `Triple bottom at ~${troughLevel.toFixed(4)}. ${confirmed ? "Neckline broken." : "Awaiting break."}`,
    });
  }
  return hits;
}

/** ---------- Head & Shoulders / Inverse H&S ---------- */

function detectHeadAndShoulders(
  candles: readonly Candle[],
  highs: Swing[],
  lows: Swing[],
  opts: Required<DetectOpts>,
): ChartPatternHit[] {
  const hits: ChartPatternHit[] = [];

  // Top: left shoulder, head (higher), right shoulder (similar to left)
  for (let i = 2; i < highs.length; i++) {
    const ls = highs[i - 2]!, head = highs[i - 1]!, rs = highs[i]!;
    if (head.price <= ls.price || head.price <= rs.price) continue;
    if (pctDiff(ls.price, rs.price) > opts.similarityPct * 2) continue; // shoulders within ~6%
    if (head.index - ls.index < opts.minBarsBetween) continue;
    if (rs.index - head.index < opts.minBarsBetween) continue;
    // Neckline = line through the two reaction lows between shoulders
    const leftValley = lows.filter((l) => l.index > ls.index && l.index < head.index).sort((p, q) => p.price - q.price)[0];
    const rightValley = lows.filter((l) => l.index > head.index && l.index < rs.index).sort((p, q) => p.price - q.price)[0];
    if (!leftValley || !rightValley) continue;
    const neckline = (leftValley.price + rightValley.price) / 2;
    const headDepth = head.price - neckline;
    if (headDepth <= 0) continue;
    const confirmIdx = candles.findIndex((c, idx) => idx > rs.index && c.c < neckline);
    const confirmed = confirmIdx !== -1;
    const symmetry = 1 - pctDiff(ls.price, rs.price) / (opts.similarityPct * 2);
    const headProminence = (head.price - Math.max(ls.price, rs.price)) / Math.max(ls.price, rs.price);
    const conf = confirmed ? Math.min(1, 0.5 + symmetry * 0.3 + Math.min(0.2, headProminence * 2)) : 0.3;
    hits.push({
      pattern: "headAndShoulders",
      startIndex: ls.index,
      endIndex: confirmed ? confirmIdx : rs.index,
      bullish: false,
      confidence: conf,
      breakoutLevel: neckline,
      target: neckline - headDepth,
      description: `H&S top: shoulders ${ls.price.toFixed(4)}/${rs.price.toFixed(4)}, head ${head.price.toFixed(4)}, neckline ${neckline.toFixed(4)}. ${confirmed ? "Neckline broken." : "Awaiting break."}`,
    });
  }

  // Inverse: left trough, deeper head, right trough
  for (let i = 2; i < lows.length; i++) {
    const ls = lows[i - 2]!, head = lows[i - 1]!, rs = lows[i]!;
    if (head.price >= ls.price || head.price >= rs.price) continue;
    if (pctDiff(ls.price, rs.price) > opts.similarityPct * 2) continue;
    if (head.index - ls.index < opts.minBarsBetween) continue;
    if (rs.index - head.index < opts.minBarsBetween) continue;
    const leftPeak = highs.filter((h) => h.index > ls.index && h.index < head.index).sort((p, q) => q.price - p.price)[0];
    const rightPeak = highs.filter((h) => h.index > head.index && h.index < rs.index).sort((p, q) => q.price - p.price)[0];
    if (!leftPeak || !rightPeak) continue;
    const neckline = (leftPeak.price + rightPeak.price) / 2;
    const headDepth = neckline - head.price;
    if (headDepth <= 0) continue;
    const confirmIdx = candles.findIndex((c, idx) => idx > rs.index && c.c > neckline);
    const confirmed = confirmIdx !== -1;
    const symmetry = 1 - pctDiff(ls.price, rs.price) / (opts.similarityPct * 2);
    const headProminence = (Math.min(ls.price, rs.price) - head.price) / Math.min(ls.price, rs.price);
    const conf = confirmed ? Math.min(1, 0.5 + symmetry * 0.3 + Math.min(0.2, headProminence * 2)) : 0.3;
    hits.push({
      pattern: "inverseHeadAndShoulders",
      startIndex: ls.index,
      endIndex: confirmed ? confirmIdx : rs.index,
      bullish: true,
      confidence: conf,
      breakoutLevel: neckline,
      target: neckline + headDepth,
      description: `Inverse H&S: shoulders ${ls.price.toFixed(4)}/${rs.price.toFixed(4)}, head ${head.price.toFixed(4)}, neckline ${neckline.toFixed(4)}. ${confirmed ? "Neckline broken." : "Awaiting break."}`,
    });
  }

  return hits;
}

/** ---------- Triangles ---------- */

function detectTriangles(
  candles: readonly Candle[],
  highs: Swing[],
  lows: Swing[],
): ChartPatternHit[] {
  const hits: ChartPatternHit[] = [];
  if (highs.length < 2 || lows.length < 2) return hits;

  // Use last 4 swings of each kind to detect a triangle near the right edge of the chart.
  const recentHighs = highs.slice(-4);
  const recentLows = lows.slice(-4);
  if (recentHighs.length < 2 || recentLows.length < 2) return hits;

  const highSlope = linearSlope(recentHighs.map((s) => [s.index, s.price]));
  const lowSlope = linearSlope(recentLows.map((s) => [s.index, s.price]));
  if (highSlope === null || lowSlope === null) return hits;

  const lastHigh = recentHighs[recentHighs.length - 1]!;
  const lastLow = recentLows[recentLows.length - 1]!;
  const startIdx = Math.min(recentHighs[0]!.index, recentLows[0]!.index);
  const endIdx = Math.max(lastHigh.index, lastLow.index);
  const meanPrice = (lastHigh.price + lastLow.price) / 2;

  // Slopes are absolute price/bar; normalize to %/bar to use a reasonable threshold.
  const highSlopePct = (highSlope / meanPrice) * 100;
  const lowSlopePct = (lowSlope / meanPrice) * 100;
  const flatThresholdPct = 0.05; // <0.05% per bar = essentially flat
  const slopingThresholdPct = 0.05;

  // Ascending triangle: flat top, rising lows
  if (Math.abs(highSlopePct) < flatThresholdPct && lowSlopePct > slopingThresholdPct) {
    const upper = recentHighs.reduce((acc, s) => acc + s.price, 0) / recentHighs.length;
    const confirmIdx = candles.findIndex((c, idx) => idx > endIdx && c.c > upper * 1.005);
    const confirmed = confirmIdx !== -1;
    const triangleHeight = upper - recentLows[0]!.price;
    hits.push({
      pattern: "ascendingTriangle",
      startIndex: startIdx,
      endIndex: confirmed ? confirmIdx : endIdx,
      bullish: true,
      confidence: confirmed ? 0.75 : 0.4,
      breakoutLevel: upper,
      target: upper + triangleHeight,
      description: `Ascending triangle: flat resistance ${upper.toFixed(4)}, rising support. ${confirmed ? "Broken upward." : "Awaiting breakout."}`,
    });
  }

  // Descending triangle: flat bottom, falling highs
  if (Math.abs(lowSlopePct) < flatThresholdPct && highSlopePct < -slopingThresholdPct) {
    const lower = recentLows.reduce((acc, s) => acc + s.price, 0) / recentLows.length;
    const confirmIdx = candles.findIndex((c, idx) => idx > endIdx && c.c < lower * 0.995);
    const confirmed = confirmIdx !== -1;
    const triangleHeight = recentHighs[0]!.price - lower;
    hits.push({
      pattern: "descendingTriangle",
      startIndex: startIdx,
      endIndex: confirmed ? confirmIdx : endIdx,
      bullish: false,
      confidence: confirmed ? 0.75 : 0.4,
      breakoutLevel: lower,
      target: lower - triangleHeight,
      description: `Descending triangle: flat support ${lower.toFixed(4)}, falling resistance. ${confirmed ? "Broken downward." : "Awaiting breakdown."}`,
    });
  }

  // Symmetrical triangle: converging slopes (highs falling, lows rising)
  if (highSlopePct < -slopingThresholdPct && lowSlopePct > slopingThresholdPct) {
    const upper = recentHighs[recentHighs.length - 1]!.price;
    const lower = recentLows[recentLows.length - 1]!.price;
    const confirmIdxUp = candles.findIndex((c, idx) => idx > endIdx && c.c > upper);
    const confirmIdxDown = candles.findIndex((c, idx) => idx > endIdx && c.c < lower);
    const breakUp = confirmIdxUp !== -1 && (confirmIdxDown === -1 || confirmIdxUp < confirmIdxDown);
    const breakDown = confirmIdxDown !== -1 && (confirmIdxUp === -1 || confirmIdxDown < confirmIdxUp);
    const triangleHeight = recentHighs[0]!.price - recentLows[0]!.price;
    if (breakUp || breakDown) {
      hits.push({
        pattern: "symmetricalTriangle",
        startIndex: startIdx,
        endIndex: breakUp ? confirmIdxUp : confirmIdxDown,
        bullish: breakUp,
        confidence: 0.7,
        breakoutLevel: breakUp ? upper : lower,
        target: breakUp ? upper + triangleHeight : lower - triangleHeight,
        description: `Symmetrical triangle: ${breakUp ? "broken upward" : "broken downward"}.`,
      });
    } else {
      hits.push({
        pattern: "symmetricalTriangle",
        startIndex: startIdx,
        endIndex: endIdx,
        bullish: true, // direction unknown — caller should not weight as bullish
        confidence: 0.3,
        breakoutLevel: (upper + lower) / 2,
        description: `Symmetrical triangle forming, awaiting breakout (resistance ${upper.toFixed(4)}, support ${lower.toFixed(4)}).`,
      });
    }
  }

  return hits;
}

/** ---------- Cup with Handle ---------- */

function detectCupAndHandle(candles: readonly Candle[]): ChartPatternHit[] {
  const hits: ChartPatternHit[] = [];
  if (candles.length < 30) return hits;

  // Heuristic: look for a U-shape over the last 50-150 bars, with a small handle.
  const window = Math.min(150, candles.length);
  const slice = candles.slice(-window);
  const offset = candles.length - window;
  const closes = slice.map((c) => c.c);
  const peak = Math.max(...closes.slice(0, Math.floor(window * 0.2)));
  const trough = Math.min(...closes.slice(Math.floor(window * 0.2), Math.floor(window * 0.8)));
  const recentHigh = Math.max(...closes.slice(Math.floor(window * 0.7)));
  const last = closes[closes.length - 1]!;

  const cupDepth = (peak - trough) / peak;
  if (!between(0.12, 0.50, cupDepth)) return hits;       // 12-50% deep
  if ((recentHigh - trough) / (peak - trough) < 0.7) return hits;  // recovered ≥70% of cup
  // Handle: shallow pullback after recovery
  const handleDepth = (recentHigh - last) / recentHigh;
  if (!between(0.02, cupDepth * 0.5, handleDepth)) return hits;     // handle ≤ ½ cup depth

  const breakLevel = peak;
  const targetMove = peak - trough;
  hits.push({
    pattern: "cupAndHandle",
    startIndex: offset,
    endIndex: candles.length - 1,
    bullish: true,
    confidence: 0.55,
    breakoutLevel: breakLevel,
    target: breakLevel + targetMove,
    description: `Cup & Handle forming: cup depth ${(cupDepth * 100).toFixed(0)}%, handle depth ${(handleDepth * 100).toFixed(1)}%. Break above ${breakLevel.toFixed(4)} confirms.`,
  });
  return hits;
}

/** ---------- High & Tight Flag ---------- */

function detectHighTightFlag(candles: readonly Candle[]): ChartPatternHit[] {
  const hits: ChartPatternHit[] = [];
  if (candles.length < 40) return hits;

  // Algorithm: the flag is the recent N bars of tight consolidation. The pole is what
  // came before. We try a few flag-length candidates (5..15) and a few pole-length
  // candidates (25..60) and look for the configuration matching Bulkowski's H&TF
  // criteria: ≥90% pole rise and ≤25% flag pullback from peak.
  for (let flagLen = 5; flagLen <= 15; flagLen++) {
    if (candles.length < flagLen + 25) continue;
    const flag = candles.slice(-flagLen);
    const flagHigh = Math.max(...flag.map((c) => c.h));
    const flagLow = Math.min(...flag.map((c) => c.l));
    const range = (flagHigh - flagLow) / flagHigh;
    if (range > 0.25) continue;

    for (let poleLen = 25; poleLen <= 60; poleLen++) {
      const startIdx = candles.length - flagLen - poleLen;
      if (startIdx < 0) continue;
      const poleStart = candles[startIdx]!.c;
      if (poleStart <= 0) continue;
      // Pole peak is the max high in the pole window OR at start of flag
      const polePeak = Math.max(
        ...candles.slice(startIdx, candles.length - flagLen).map((c) => c.h),
        flagHigh,
      );
      const rise = (polePeak - poleStart) / poleStart * 100;
      if (rise < 90) continue;
      const pullback = (polePeak - flagLow) / polePeak * 100;
      if (pullback > 25) continue;

      const breakLevel = flagHigh;
      const target = breakLevel + (polePeak - poleStart);
      hits.push({
        pattern: "highTightFlag",
        startIndex: startIdx,
        endIndex: candles.length - 1,
        bullish: true,
        confidence: 0.75,
        breakoutLevel: breakLevel,
        target,
        description: `High & Tight Flag: ${rise.toFixed(0)}% pole over ${poleLen} bars, ${pullback.toFixed(0)}% pullback over ${flagLen} bars. Break above ${breakLevel.toFixed(4)} → +${((target - breakLevel) / breakLevel * 100).toFixed(0)}% target.`,
      });
      return hits; // first match wins
    }
  }
  return hits;
}

/** ---------- Public API ---------- */

export function detectChartPatterns(candles: readonly Candle[], opts: DetectOpts = {}): ChartPatternHit[] {
  const o: Required<DetectOpts> = { ...D, ...opts };
  if (candles.length < 20) return [];

  const allSwings = swings(candles, o.swingLookback);
  const highs = allSwings.filter((s) => s.kind === "high");
  const lows = allSwings.filter((s) => s.kind === "low");

  return [
    ...detectDoubleExtremes(candles, highs, lows, o),
    ...detectTripleExtremes(candles, highs, lows, o),
    ...detectHeadAndShoulders(candles, highs, lows, o),
    ...detectTriangles(candles, highs, lows),
    ...detectCupAndHandle(candles),
    ...detectHighTightFlag(candles),
  ];
}

/** Pick the highest-confidence hit per pattern type. */
export function bestChartPatterns(hits: readonly ChartPatternHit[]): ChartPatternHit[] {
  const byPattern = new Map<string, ChartPatternHit>();
  for (const h of hits) {
    const cur = byPattern.get(h.pattern);
    if (!cur || h.confidence > cur.confidence) byPattern.set(h.pattern, h);
  }
  return Array.from(byPattern.values());
}

/** Linear least-squares slope (price units per bar). */
function linearSlope(points: Array<readonly [number, number]>): number | null {
  const n = points.length;
  if (n < 2) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const [x, y] of points) { sumX += x; sumY += y; sumXY += x * y; sumXX += x * x; }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}
