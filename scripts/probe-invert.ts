/**
 * B2 inversion test: at each bar where LONG strategy WOULD have fired LONG,
 * also compute what a SHORT trade at that same bar would have earned. And
 * vice versa. Outputs a 2x2 cross-table per symbol:
 *
 *                            executed=LONG   executed=SHORT
 *   signal-says-LONG (bull):  baseline LONG    inversion
 *   signal-says-SHORT (bear): inversion        baseline SHORT
 *
 * If both "baseline" cells are negative and both "inversion" cells positive,
 * the classifier is globally reversed. If only one is negative, it's a
 * side-specific bug.
 */

import { loadCachedSeries } from "../src/backtest/data-fetcher.js";
import { precomputeScores, getScoreAt } from "../src/backtest/score-cache.js";
import { atr } from "../src/analysis/indicators.js";

const SYMS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"];
const NOW = Date.now();
const WIN = 14 * 86_400_000;
const FROM = NOW - WIN;

const cfg = {
  warmupBars: 50,
  cooldownBars: 12,
  horizonBars: 36,
  stopAtrMult: 2.5,
  compositeThreshold: 60,
  // No requireBreakout, no requireStage2 — same as baseline probe.
};

type CellStat = { n: number; sumR: number };
const newCell = (): CellStat => ({ n: 0, sumR: 0 });

function simulateTrade(
  candles: any[],
  i: number,
  atrValue: number,
  executedSide: "LONG" | "SHORT",
): number | null {
  const entryPrice = candles[i].c;
  const stopPrice =
    executedSide === "SHORT"
      ? entryPrice + cfg.stopAtrMult * atrValue
      : entryPrice - cfg.stopAtrMult * atrValue;
  if (stopPrice <= 0) return null;

  let exitIdx = i + cfg.horizonBars;
  if (exitIdx >= candles.length) return null;
  let exitPrice = candles[exitIdx].c;

  for (let j = i + 1; j <= i + cfg.horizonBars; j++) {
    const bar = candles[j];
    const stopHit = executedSide === "SHORT" ? bar.h >= stopPrice : bar.l <= stopPrice;
    if (stopHit) {
      exitPrice = stopPrice;
      break;
    }
  }

  const initialRisk =
    executedSide === "SHORT" ? stopPrice - entryPrice : entryPrice - stopPrice;
  const realizedPnl =
    executedSide === "SHORT" ? entryPrice - exitPrice : exitPrice - entryPrice;
  return realizedPnl / initialRisk;
}

console.log(
  "sym         signal=LONG (bull)                  signal=SHORT (bear)",
);
console.log(
  "            exec=LONG       exec=SHORT          exec=LONG       exec=SHORT",
);
console.log(
  "----------- --------------- ---------------     --------------- ---------------",
);

for (const sym of SYMS) {
  const s = await loadCachedSeries(sym);
  if (!s) continue;
  const candles = s.candles.filter((c) => c.t * 1000 >= FROM && c.t * 1000 < NOW);
  if (candles.length < 200) continue;

  const scoreSeries = precomputeScores(candles, cfg.warmupBars, 150);
  const atrSeries = atr(candles, 14);

  const longLong = newCell();
  const longShort = newCell();
  const shortLong = newCell();
  const shortShort = newCell();

  let lastLongEntry = -Infinity;
  let lastShortEntry = -Infinity;

  for (let i = cfg.warmupBars; i < candles.length - cfg.horizonBars; i++) {
    const snap = getScoreAt(scoreSeries, i);
    if (!snap) continue;
    if (snap.score < cfg.compositeThreshold) continue;

    const atrIdx = i - 1;
    const atrValue = atrSeries[Math.max(0, atrIdx - 14)] ?? 0;
    if (atrValue <= 0) continue;

    // LONG-signal gates: trend != down (the engine's "reject downtrend" rule).
    const longSignal =
      snap.trend !== "down" && i - lastLongEntry >= cfg.cooldownBars;
    // SHORT-signal gates: trend === down.
    const shortSignal =
      snap.trend === "down" && i - lastShortEntry >= cfg.cooldownBars;

    if (longSignal) {
      const rLong = simulateTrade(candles, i, atrValue, "LONG");
      const rShort = simulateTrade(candles, i, atrValue, "SHORT");
      if (rLong !== null) {
        longLong.n++;
        longLong.sumR += rLong;
      }
      if (rShort !== null) {
        longShort.n++;
        longShort.sumR += rShort;
      }
      lastLongEntry = i;
    }
    if (shortSignal) {
      const rLong = simulateTrade(candles, i, atrValue, "LONG");
      const rShort = simulateTrade(candles, i, atrValue, "SHORT");
      if (rLong !== null) {
        shortLong.n++;
        shortLong.sumR += rLong;
      }
      if (rShort !== null) {
        shortShort.n++;
        shortShort.sumR += rShort;
      }
      lastShortEntry = i;
    }
  }

  const f = (c: CellStat) =>
    c.n === 0
      ? "n=0".padEnd(15)
      : `n=${c.n.toString().padStart(3)} exp=${(c.sumR / c.n).toFixed(3).padStart(7)}`;

  console.log(
    `${sym.padEnd(11)} ${f(longLong)} ${f(longShort)}     ${f(shortLong)} ${f(shortShort)}`,
  );
}
