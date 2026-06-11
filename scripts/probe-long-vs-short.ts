/**
 * One-off probe: trade count + avg R per side, on cached data.
 * Goal: confirm whether LONG's 1000-2000R DD is "thousands of small losses"
 * or "a math bug in the engine".
 */

import { loadCachedSeries } from "../src/backtest/data-fetcher.js";
import { runStrategyOnSeries, summarize, type BarScore } from "../src/analysis/backtest.js";
import { precomputeScores, getScoreAt } from "../src/backtest/score-cache.js";

const SYMS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"];
const NOW = Date.now();
const WIN = 14 * 86_400_000; // 14d slice keeps probe under 1 min wall-clock
const FROM = NOW - WIN;

const cfg = {
  warmupBars: 50,
  cooldownBars: 12,
  horizonBars: 36,
  stopAtrMult: 2.5,
  thresholdComposite: 60,
  stage2Required: false,
};

for (const sym of SYMS) {
  const s = await loadCachedSeries(sym);
  if (!s) {
    console.log(`${sym}: no cache`);
    continue;
  }
  const candles = s.candles.filter((c) => c.t * 1000 >= FROM && c.t * 1000 < NOW);
  if (candles.length < 200) {
    console.log(`${sym}: too few bars (${candles.length})`);
    continue;
  }

  // Build a score cache so the engine is O(N) per side, not O(N²).
  const scoreSeries = precomputeScores(candles, cfg.warmupBars, 150);
  const lookup = (i: number): BarScore | null => {
    const snap = getScoreAt(scoreSeries, i);
    if (!snap) return null;
    return {
      score: snap.score,
      trend: snap.trend,
      hasBreakout: snap.hasBreakout,
      closeAboveStage2Sma: snap.closeAboveStage2Sma,
    };
  };
  const longTrades = runStrategyOnSeries(candles, { ...cfg, side: "LONG" }, lookup);
  const shortTrades = runStrategyOnSeries(candles, { ...cfg, side: "SHORT" }, lookup);
  const ls = summarize(longTrades);
  const ss = summarize(shortTrades);

  console.log(
    `${sym.padEnd(10)} bars=${candles.length}  LONG: n=${ls.trades.toString().padStart(4)} exp=${ls.expectancy.toFixed(3)} DD=${ls.maxDrawdownR.toFixed(1)}  |  SHORT: n=${ss.trades.toString().padStart(4)} exp=${ss.expectancy.toFixed(3)} DD=${ss.maxDrawdownR.toFixed(1)}`,
  );
}
