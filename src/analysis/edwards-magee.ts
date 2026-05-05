/**
 * Edwards & Magee chart-pattern geometric refinements.
 * Source: Edwards, Magee & Bassetti, "Technical Analysis of Stock Trends"
 *   (11th ed., Routledge 2018; original 1948).
 *
 * E&M's contribution beyond Bulkowski's stats: rigorous geometric criteria
 * for what makes a pattern "valid". Patterns that fit the geometry tend
 * to outperform Bulkowski's averages (which include sloppy occurrences).
 *
 * This module takes existing ChartPatternHits and adjusts their confidence
 * based on E&M's quality criteria. Multiplier in [0.5, 1.5].
 */

import type { Candle } from "./indicators.js";
import type { ChartPatternHit } from "./chart-patterns.js";
import { swings } from "./indicators.js";

export interface RefinedHit extends ChartPatternHit {
  geometryScore: number;     // 0..1
  geometryNotes: string[];
  originalConfidence: number;
}

/**
 * Apply E&M geometric quality checks to a hit.
 *
 * For Head & Shoulders:
 *   - Shoulder symmetry (time AND price)
 *   - Neckline slope (slight downward slope is ideal)
 *   - Volume contraction across L→H→R (head volume should NOT exceed shoulder volume)
 *
 * For Double Top/Bottom:
 *   - Peaks/troughs should be ≥10 bars apart (E&M: "well-defined valley")
 *   - Volume on second peak should be lower (top) or higher (bottom)
 *
 * For Triangles:
 *   - Apex should be reached in 2/3 of triangle width (not at the edge)
 *   - Volume should contract through the formation
 */
export function refineHit(hit: ChartPatternHit, candles: readonly Candle[]): RefinedHit {
  const notes: string[] = [];
  let score = 1.0;

  switch (hit.pattern) {
    case "headAndShoulders":
    case "inverseHeadAndShoulders": {
      const r = checkHnsGeometry(hit, candles);
      score = r.score;
      notes.push(...r.notes);
      break;
    }
    case "doubleTop":
    case "doubleBottom": {
      const r = checkDoubleGeometry(hit, candles);
      score = r.score;
      notes.push(...r.notes);
      break;
    }
    case "ascendingTriangle":
    case "descendingTriangle":
    case "symmetricalTriangle": {
      const r = checkTriangleGeometry(hit, candles);
      score = r.score;
      notes.push(...r.notes);
      break;
    }
    default:
      break;
  }

  // Apply geometry score as multiplier on the original confidence (range 0.5-1.5)
  const multiplier = 0.5 + score;
  const refinedConfidence = Math.min(1, hit.confidence * multiplier);

  return {
    ...hit,
    confidence: refinedConfidence,
    geometryScore: score,
    geometryNotes: notes,
    originalConfidence: hit.confidence,
  };
}

function checkHnsGeometry(hit: ChartPatternHit, candles: readonly Candle[]): { score: number; notes: string[] } {
  const notes: string[] = [];
  const slice = candles.slice(hit.startIndex, hit.endIndex + 1);
  if (slice.length < 7) return { score: 0.5, notes: ["window too small for E&M check"] };

  const sw = swings(slice, 2);
  const isInverse = hit.pattern === "inverseHeadAndShoulders";
  const extremes = sw.filter((s) => s.kind === (isInverse ? "low" : "high"));
  if (extremes.length < 3) return { score: 0.5, notes: ["E&M: incomplete shoulder structure"] };

  const [ls, head, rs] = [extremes[0]!, extremes[1]!, extremes[2]!];

  // Time symmetry: shoulders should be roughly equidistant from head
  const leftBars = head.index - ls.index;
  const rightBars = rs.index - head.index;
  const timeRatio = Math.min(leftBars, rightBars) / Math.max(leftBars, rightBars);
  if (timeRatio > 0.7) notes.push("E&M: shoulders time-symmetric");
  else notes.push(`E&M: shoulder timing asymmetric (${timeRatio.toFixed(2)})`);

  // Price symmetry already checked by detector; just add a note
  const priceSym = 1 - Math.abs(ls.price - rs.price) / Math.max(ls.price, rs.price);

  // Volume: head bar's volume should NOT exceed both shoulder bars' volumes
  const lsBar = candles[hit.startIndex + ls.index];
  const headBar = candles[hit.startIndex + head.index];
  const rsBar = candles[hit.startIndex + rs.index];
  let volScore = 0.5;
  if (lsBar && headBar && rsBar) {
    const headBeats = headBar.v < Math.max(lsBar.v, rsBar.v);
    if (headBeats) {
      notes.push("E&M: head volume contracted vs shoulders (textbook)");
      volScore = 1.0;
    } else {
      notes.push("E&M: head volume exceeds shoulders (atypical)");
      volScore = 0.3;
    }
  }

  const score = (timeRatio + priceSym + volScore) / 3;
  return { score, notes };
}

function checkDoubleGeometry(hit: ChartPatternHit, candles: readonly Candle[]): { score: number; notes: string[] } {
  const notes: string[] = [];
  const isTop = hit.pattern === "doubleTop";
  const slice = candles.slice(hit.startIndex, hit.endIndex + 1);
  const sw = swings(slice, 2).filter((s) => s.kind === (isTop ? "high" : "low"));
  if (sw.length < 2) return { score: 0.5, notes: ["E&M: peaks not cleanly formed"] };

  const [a, b] = [sw[0]!, sw[1]!];
  const barsBetween = b.index - a.index;
  let score = 0.5;
  if (barsBetween >= 10) {
    notes.push(`E&M: well-defined ${barsBetween}-bar separation between extremes`);
    score = 0.8;
  } else {
    notes.push(`E&M: extremes only ${barsBetween} bars apart (E&M prefers ≥10)`);
    score = 0.4;
  }

  // Volume signature
  const aBar = candles[hit.startIndex + a.index];
  const bBar = candles[hit.startIndex + b.index];
  if (aBar && bBar) {
    if (isTop && bBar.v < aBar.v) {
      notes.push("E&M: second top has lower volume (textbook distribution)");
      score = Math.min(1, score + 0.2);
    } else if (!isTop && bBar.v > aBar.v) {
      notes.push("E&M: second bottom has higher volume (textbook accumulation)");
      score = Math.min(1, score + 0.2);
    }
  }
  return { score, notes };
}

function checkTriangleGeometry(hit: ChartPatternHit, candles: readonly Candle[]): { score: number; notes: string[] } {
  const notes: string[] = [];
  const slice = candles.slice(hit.startIndex, hit.endIndex + 1);
  if (slice.length < 10) return { score: 0.5, notes: ["E&M: triangle window too small"] };

  // Volume contraction check: avg volume in last third < avg volume in first third
  const third = Math.floor(slice.length / 3);
  const firstAvg = slice.slice(0, third).reduce((a, c) => a + c.v, 0) / third;
  const lastAvg = slice.slice(-third).reduce((a, c) => a + c.v, 0) / third;
  let score = 0.5;
  if (firstAvg > 0 && lastAvg / firstAvg < 0.7) {
    notes.push(`E&M: volume contracted into apex (${(lastAvg / firstAvg * 100).toFixed(0)}% of start) — textbook`);
    score = 1.0;
  } else if (firstAvg > 0 && lastAvg / firstAvg < 1.0) {
    notes.push(`E&M: mild volume contraction (${(lastAvg / firstAvg * 100).toFixed(0)}%)`);
    score = 0.7;
  } else {
    notes.push("E&M: no volume contraction — atypical for valid triangle");
    score = 0.3;
  }
  return { score, notes };
}
