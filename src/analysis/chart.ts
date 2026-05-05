import type { Candle } from "./indicators.js";
import { ema, rsi, sma, atr, detectRsiDivergence, trendDirection, pctChange, maxDrawdown } from "./indicators.js";
import { detectCandlePatterns, recentPatterns } from "./patterns.js";
import { detectChartPatterns, bestChartPatterns, type ChartPatternHit } from "./chart-patterns.js";
import { refineHit } from "./edwards-magee.js";
import { tdSequential, recentTdSignal } from "./demark.js";
import { kst, kstCrossover } from "./indicators.js";
import { getCandleWeight, getChartPatternWeight } from "./weights.js";

export interface ChartScore {
  score: number; // 0-100
  trend: "up" | "down" | "flat";
  rsi: number | null;
  rsiDivergence: "bullish" | "bearish" | null;
  recentBullishPatterns: string[];
  recentBearishPatterns: string[];
  chartPatterns: ChartPatternHit[];
  volumeConfirmation: boolean;
  notes: string[];
}

export function scoreChart(daily: readonly Candle[], hourly: readonly Candle[]): ChartScore {
  const notes: string[] = [];
  let score = 50;

  const dailyCloses = daily.map((c) => c.c);
  const hourlyCloses = hourly.map((c) => c.c);
  const trend = trendDirection(dailyCloses.length >= 50 ? dailyCloses : hourlyCloses);

  if (trend === "up") { score += 15; notes.push("HTF trend up"); }
  else if (trend === "down") { score -= 20; notes.push("HTF trend down"); }
  else notes.push("HTF trend flat / unclear");

  const rsiVals = rsi(hourlyCloses, 14);
  const lastRsi = rsiVals.length > 0 ? rsiVals[rsiVals.length - 1]! : null;
  let rsiDiv: "bullish" | "bearish" | null = null;
  if (lastRsi !== null) {
    if (lastRsi < 30) { score += 5; notes.push(`RSI ${lastRsi.toFixed(0)} oversold`); }
    else if (lastRsi > 75 && trend !== "up") { score -= 10; notes.push(`RSI ${lastRsi.toFixed(0)} overbought outside trend`); }
    else if (lastRsi > 50 && lastRsi < 70) { score += 5; notes.push(`RSI ${lastRsi.toFixed(0)} momentum healthy`); }

    const divs = detectRsiDivergence(hourly, rsiVals);
    const recentDiv = divs.find((d) => hourly.length - d.toIndex < 10);
    if (recentDiv) {
      if (recentDiv.kind === "bullish" || recentDiv.kind === "hiddenBullish") {
        rsiDiv = "bullish"; score += 8; notes.push(`RSI ${recentDiv.kind} divergence`);
      } else {
        rsiDiv = "bearish"; score -= 8; notes.push(`RSI ${recentDiv.kind} divergence`);
      }
    }
  }

  const allPatterns = detectCandlePatterns(hourly);
  const recent = recentPatterns(allPatterns, hourly.length, 4);
  const bullish: string[] = [];
  const bearish: string[] = [];
  // Deduplicate: count each pattern only once even if it fires on multiple recent bars.
  const seen = new Set<string>();
  for (const hit of recent) {
    if (hit.pattern === "doji" || seen.has(hit.pattern)) continue;
    seen.add(hit.pattern);
    if (hit.bullish) bullish.push(hit.pattern);
    else bearish.push(hit.pattern);
    const w = getCandleWeight(hit.pattern).weight;
    score += hit.bullish ? w : -w;
  }

  const recentVol = hourly.slice(-1)[0]?.v ?? 0;
  const volSma = sma(hourly.map((c) => c.v), 20);
  const lastVolSma = volSma[volSma.length - 1] ?? 0;
  const volumeConfirmation = lastVolSma > 0 && recentVol > lastVolSma * 1.5;
  if (volumeConfirmation) { score += 5; notes.push("Volume > 1.5x avg"); }

  // Multi-bar chart patterns (run on whichever timeframe has more data — daily preferred)
  const seriesForChart = daily.length >= 30 ? daily : hourly;
  const rawHits = bestChartPatterns(detectChartPatterns(seriesForChart));
  const chartPatterns = rawHits.map((h) => refineHit(h, seriesForChart));
  for (const hit of chartPatterns) {
    const w = getChartPatternWeight(hit.pattern);
    const contribution = w.weight * hit.confidence;
    score += hit.bullish ? contribution : -contribution;
  }

  // DeMark TD Sequential exhaustion signals
  const td = tdSequential(seriesForChart);
  const tdSig = recentTdSignal(td, 3);
  if (tdSig) {
    if (tdSig.kind === "buySetup") { score += 5; notes.push("DeMark Buy Setup (9) — downtrend exhaustion"); }
    else if (tdSig.kind === "sellSetup") { score -= 5; notes.push("DeMark Sell Setup (9) — uptrend exhaustion"); }
    else if (tdSig.kind === "buyCountdown") { score += 12; notes.push("DeMark Buy Countdown (13) — strong reversal candidate"); }
    else if (tdSig.kind === "sellCountdown") { score -= 12; notes.push("DeMark Sell Countdown (13) — strong top candidate"); }
  }

  // Pring KST crossover (using daily closes for "long" variant; falls back to hourly)
  const kstResult = kst(seriesForChart.map((c) => c.c), "long");
  const kstSig = kstCrossover(kstResult, 3);
  if (kstSig === "bullish") { score += 6; notes.push("Pring KST bullish crossover"); }
  else if (kstSig === "bearish") { score -= 6; notes.push("Pring KST bearish crossover"); }

  if (dailyCloses.length >= 30) {
    const dd = maxDrawdown(dailyCloses);
    if (dd > 0.7) { score -= 8; notes.push(`Max drawdown ${(dd * 100).toFixed(0)}%`); }
  }

  if (hourlyCloses.length >= 24) {
    const change24h = pctChange(hourlyCloses[hourlyCloses.length - 25] ?? hourlyCloses[0]!, hourlyCloses[hourlyCloses.length - 1]!);
    if (change24h > 100) { score -= 10; notes.push(`Up ${change24h.toFixed(0)}% in 24h — late chase risk`); }
  }

  // Touch unused imports for lint quietness
  void ema; void atr;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    trend,
    rsi: lastRsi,
    rsiDivergence: rsiDiv,
    recentBullishPatterns: bullish,
    recentBearishPatterns: bearish,
    chartPatterns,
    volumeConfirmation,
    notes,
  };
}
