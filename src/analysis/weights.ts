import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

interface ChartPatternDirection {
  failure_bull_pct?: number;
  failure_bear_pct?: number;
  avg_rise_pct_bull?: number;
  avg_rise_pct_bear?: number;
  avg_decline_pct_bull?: number;
  avg_decline_pct_bear?: number;
  throwback_pct_bull?: number;
  pullback_pct_bull?: number;
  target_hit_bull_pct?: number;
  rank_bull?: { position: number; of: number };
}

interface ChartPattern {
  pattern: string;
  directions: Record<string, ChartPatternDirection>;
}

interface CandlePattern {
  pattern: string;
  metrics: {
    overall_rank?: number; // performance sum %
    reversal_bull_pct?: number;
    reversal_bear_pct?: number;
    continuation_bull_pct?: number;
    continuation_bear_pct?: number;
    perf_10d_bull_up_pct?: number;
  };
}

const chartData: { patterns: ChartPattern[] } = JSON.parse(
  readFileSync(join(dataDir, "bulkowski-chart-patterns.json"), "utf8"),
);

const candleData: { patterns: CandlePattern[] } = JSON.parse(
  readFileSync(join(dataDir, "bulkowski-candlestick.json"), "utf8"),
);

const normalize = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[,_-]/g, " ")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();

const chartByName = new Map<string, ChartPattern>();
for (const p of chartData.patterns) chartByName.set(normalize(p.pattern), p);

const candleByName = new Map<string, CandlePattern>();
for (const p of candleData.patterns) candleByName.set(normalize(p.pattern), p);

const CANDLE_ALIASES: Record<string, string[]> = {
  bullishEngulfing: ["engulfing bullish", "engulfing"],
  bearishEngulfing: ["engulfing bearish", "engulfing"],
  hammer: ["hammer"],
  invertedHammer: ["hammer inverted"],
  shootingStar: ["shooting star"],
  hangingMan: ["hanging man"],
  morningStar: ["morning star"],
  eveningStar: ["evening star"],
  threeWhiteSoldiers: ["three white soldiers"],
  threeBlackCrows: ["three black crows"],
  bullishHarami: ["harami bullish", "harami"],
  bearishHarami: ["harami bearish", "harami"],
  piercingLine: ["piercing"],
  darkCloudCover: ["dark cloud cover", "dark cloud"],
  doji: ["doji"],
  marubozu: ["belt hold bullish", "belt hold bearish"],
  bullishKicker: ["separating lines bullish"],
  bearishKicker: ["separating lines bearish"],
  abandonedBabyBullish: ["abandoned baby bullish"],
  abandonedBabyBearish: ["abandoned baby bearish"],
  threeLineStrikeBullish: ["three line strike bullish"],
  threeLineStrikeBearish: ["three line strike bearish"],
};

const CHART_ALIASES: Record<string, string[]> = {
  headAndShoulders: ["head and shoulders", "head and shoulders tops"],
  inverseHeadAndShoulders: ["head and shoulders"], // top: down → bottom; we use generic head/shoulders direction=down for bottoms
  doubleTop: ["double tops"],
  doubleBottom: ["double bottoms"],
  tripleTop: ["triple tops"],
  tripleBottom: ["triple bottoms"],
  ascendingTriangle: ["triangles ascending"],
  descendingTriangle: ["triangles descending"],
  symmetricalTriangle: ["triangles symmetrical"],
  bullFlag: ["flags"],
  bearFlag: ["flags"],
  highTightFlag: ["flags high and tight"],
  pennant: ["pennants"],
  cupAndHandle: ["cup with handle"],
  cupAndHandleInverted: ["cup with handle inverted"],
  fallingWedge: ["wedges falling"],
  risingWedge: ["wedges rising"],
  rectangleTop: ["rectangle tops"],
  rectangleBottom: ["rectangle bottoms"],
  roundingBottom: ["rounding bottoms"],
  roundingTop: ["rounding tops"],
  diamondTop: ["diamond tops"],
  diamondBottom: ["diamond bottoms"],
  islandReversal: ["island reversals"],
  pipeBottom: ["pipe bottoms"],
  pipeTop: ["pipe tops"],
  scallopAscending: ["scallops ascending"],
  scallopDescending: ["scallops descending"],
};

export interface PatternWeight {
  pattern: string;
  weight: number;     // 0–20 score contribution
  bullish: boolean;
  source: "bulkowski-chart" | "bulkowski-candle" | "fallback";
  rationale: string;
}

/**
 * Convert Bulkowski's failure rate + average rise into a 0–20 weight.
 *
 * Logic: lower failure rate AND higher avg move = more reliable bullish setup.
 * Score = (1 - failure/100) * sqrt(avgMove) * 2.
 *   - failure 0%, avgMove 69% (high&tight flag) → 1.0 * 8.31 * 2 = ~16.6 → cap at 20
 *   - failure 4%, avgMove 38% (inverse H&S)    → 0.96 * 6.16 * 2 = ~11.8
 *   - failure 13%, avgMove 35% (asc. triangle) → 0.87 * 5.92 * 2 = ~10.3
 */
function chartWeight(failurePct: number | undefined, avgMovePct: number | undefined): number {
  if (failurePct === undefined || avgMovePct === undefined) return 5;
  const reliability = Math.max(0, 1 - failurePct / 100);
  const magnitude = Math.sqrt(Math.max(0, avgMovePct));
  return Math.min(20, reliability * magnitude * 2);
}

/**
 * Convert candle reversal/continuation rate into 0–10 weight.
 * Bulkowski calls anything <60% near-random. We compress into [0, 10].
 */
function candleWeight(rate: number | undefined): number {
  if (rate === undefined) return 1; // pattern not in top 15 → low weight
  const above = Math.max(0, rate - 50);
  return Math.min(10, (above / 50) * 10);
}

const fallbackWeights: Record<string, number> = {
  bullishEngulfing: 5,
  bearishEngulfing: 5,
  hammer: 4,
  shootingStar: 4,
  morningStar: 9,
  eveningStar: 9,
  threeWhiteSoldiers: 10,
  threeBlackCrows: 9,
  doji: 1,
};

export function getCandleWeight(patternKey: string): PatternWeight {
  const aliases = CANDLE_ALIASES[patternKey] ?? [normalize(patternKey)];
  const isBearish = /bearish|bear|shooting|hanging|cloud|crow|evening|sell/i.test(patternKey);

  for (const alias of aliases) {
    const match = candleByName.get(normalize(alias));
    if (match) {
      const m = match.metrics;
      const rate = isBearish
        ? (m.reversal_bear_pct ?? m.continuation_bear_pct)
        : (m.reversal_bull_pct ?? m.continuation_bull_pct);
      if (rate !== undefined) {
        return {
          pattern: patternKey,
          weight: candleWeight(rate),
          bullish: !isBearish,
          source: "bulkowski-candle",
          rationale: `Bulkowski reversal/continuation rate ${rate}% (bull ${m.reversal_bull_pct ?? "?"} / bear ${m.reversal_bear_pct ?? "?"})`,
        };
      }
      if (m.overall_rank !== undefined) {
        return {
          pattern: patternKey,
          weight: Math.min(10, Math.max(1, m.overall_rank / 10)),
          bullish: !isBearish,
          source: "bulkowski-candle",
          rationale: `Bulkowski overall performance sum ${m.overall_rank.toFixed(1)}%`,
        };
      }
    }
  }
  const fb = fallbackWeights[patternKey] ?? 2;
  return {
    pattern: patternKey,
    weight: fb,
    bullish: !isBearish,
    source: "fallback",
    rationale: "no Bulkowski entry — fallback weight",
  };
}

export interface ChartPatternWeight extends PatternWeight {
  failurePct?: number;
  avgMovePct?: number;
  targetHitPct?: number;
  throwbackPct?: number;
}

export function getChartPatternWeight(patternKey: string): ChartPatternWeight {
  const aliases = CHART_ALIASES[patternKey] ?? [normalize(patternKey)];
  const isBearish = /bear|top|down|descending|rising[Ww]edge/.test(patternKey) && !patternKey.startsWith("inverse");

  for (const alias of aliases) {
    const match = chartByName.get(normalize(alias));
    if (!match) continue;
    // Pick the direction matching this pattern variant.
    // For "doubleBottom" we want directions.up; for "doubleTop" directions.down.
    // The chart-patterns JSON keys directions by the breakout direction, so:
    // - top/down patterns use direction=down or up depending on entry; pick whichever exists.
    // For simplicity: try matching direction first, else fallback to any direction.
    const wantDir = isBearish ? "down" : "up";
    const dirObj = match.directions[wantDir] ?? Object.values(match.directions)[0];
    if (!dirObj) continue;
    const failure = dirObj.failure_bull_pct;
    const move = isBearish ? Math.abs(dirObj.avg_decline_pct_bull ?? 0) : (dirObj.avg_rise_pct_bull);
    return {
      pattern: patternKey,
      weight: chartWeight(failure, move),
      bullish: !isBearish,
      source: "bulkowski-chart",
      rationale: `Bulkowski: failure ${failure ?? "?"}%, avg move ${move ?? "?"}% (n samples ranked ${dirObj.rank_bull?.position}/${dirObj.rank_bull?.of})`,
      failurePct: failure,
      avgMovePct: move,
      targetHitPct: dirObj.target_hit_bull_pct,
      throwbackPct: dirObj.throwback_pct_bull ?? dirObj.pullback_pct_bull,
    };
  }
  return {
    pattern: patternKey,
    weight: 5,
    bullish: !isBearish,
    source: "fallback",
    rationale: "no Bulkowski entry — fallback weight",
  };
}
