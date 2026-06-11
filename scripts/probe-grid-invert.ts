/**
 * C1 grid-invert probe: 32 SMOKE_GRID configs × 5 cached symbols × 30d window,
 * with `invertExecution: true` on every config. Apply costs. Rank by net
 * expectancy across the full window (no train/test split — this is a sign-test,
 * not a certification).
 *
 * Goal: decide whether the engine's invertExecution flag flips the smoke's
 * 0/32 negative result into a credible positive one ACROSS the grid, or
 * whether the C1 fix only helps a slice.
 */

import { loadCachedSeries } from "../src/backtest/data-fetcher.js";
import { precomputeScores, getScoreAt } from "../src/backtest/score-cache.js";
import {
  runStrategyOnSeries,
  summarize,
  type BarScore,
  type BacktestConfig,
  type BacktestTrade,
} from "../src/analysis/backtest.js";
import {
  applyCosts,
  DEFAULT_COST_MODEL,
  sharpe,
  symbolConcentration,
} from "../src/backtest/metrics.js";

const SYMS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"];
const NOW = Date.now();
const WIN_DAYS = 30;
const WIN = WIN_DAYS * 86_400_000;
const FROM = NOW - WIN;

const THRESHOLDS = [55, 60, 65, 70];
const STAGE2 = [true, false];
const ATR_MULT = [1.5, 2.5];
const SIDES: Array<"LONG" | "SHORT"> = ["LONG", "SHORT"];
const FIXED = {
  warmupBars: 200,
  horizonBars: 36,
  cooldownBars: 12,
  stage2SmaPeriod: 150,
  requireBreakout: false,
};

interface ConfigSpec {
  id: string;
  cfg: BacktestConfig;
}

function buildGrid(invert: boolean): ConfigSpec[] {
  const out: ConfigSpec[] = [];
  for (const t of THRESHOLDS) {
    for (const s2 of STAGE2) {
      for (const a of ATR_MULT) {
        for (const side of SIDES) {
          const s2Tag = s2 ? "s2T" : "s2F";
          const id = `${side}-c${t}-${s2Tag}-atr${a}${invert ? "-INV" : ""}`;
          out.push({
            id,
            cfg: {
              thresholdComposite: t,
              requireStage2: s2,
              stopAtrMult: a,
              ...FIXED,
              side,
              invertExecution: invert,
            },
          });
        }
      }
    }
  }
  return out;
}

console.log(`[1/3] loading cached series (${WIN_DAYS}d window)...`);
type Series = { instId: string; candles: Awaited<ReturnType<typeof loadCachedSeries>> };
const seriesBySymbol: Record<string, any> = {};
for (const sym of SYMS) {
  const s = await loadCachedSeries(sym);
  if (!s) {
    console.log(`  ${sym}: no cache (skip)`);
    continue;
  }
  const candles = s.candles.filter((c) => c.t * 1000 >= FROM && c.t * 1000 < NOW);
  seriesBySymbol[sym] = candles;
  console.log(`  ${sym}: ${candles.length} bars`);
}

console.log(`\n[2/3] precomputing score-cache per symbol (warmup=${FIXED.warmupBars}, stage2=${FIXED.stage2SmaPeriod})...`);
const t0 = performance.now();
const scoreSeriesBySymbol: Record<string, any> = {};
for (const sym of Object.keys(seriesBySymbol)) {
  const candles = seriesBySymbol[sym];
  const ts = performance.now();
  const ss = precomputeScores(candles, FIXED.warmupBars, FIXED.stage2SmaPeriod);
  const te = performance.now();
  scoreSeriesBySymbol[sym] = ss;
  console.log(`  ${sym}: built in ${((te - ts) / 1000).toFixed(1)}s`);
}
const t1 = performance.now();
console.log(`  cache total: ${((t1 - t0) / 1000).toFixed(1)}s`);

console.log(`\n[3/3] running 32 inverted configs...`);
const grid = buildGrid(true);

interface Row {
  id: string;
  trades: number;
  netExp: number;
  netTotalR: number;
  sharpe: number;
  topSymShare: number;
  conc: number;
}

const rows: Row[] = [];

for (const spec of grid) {
  const allTrades: (BacktestTrade & { symbol: string })[] = [];
  for (const sym of Object.keys(seriesBySymbol)) {
    const candles = seriesBySymbol[sym];
    const ss = scoreSeriesBySymbol[sym];
    const lookup = (i: number): BarScore | null => {
      const snap = getScoreAt(ss, i);
      if (!snap) return null;
      return {
        score: snap.score,
        trend: snap.trend,
        hasBreakout: snap.hasBreakout,
        closeAboveStage2Sma: snap.closeAboveStage2Sma,
      };
    };
    const trades = runStrategyOnSeries(candles, spec.cfg, lookup);
    for (const t of trades) {
      const costed = applyCosts(t, DEFAULT_COST_MODEL);
      allTrades.push({ ...costed, symbol: sym });
    }
  }
  const stats = summarize(allTrades);
  const sh = sharpe(stats.rDistribution);
  const conc = symbolConcentration(allTrades);
  let topShare = 0;
  for (const b of conc.bySymbol) {
    const a = Math.abs(b.share);
    if (a > topShare) topShare = a;
  }
  rows.push({
    id: spec.id,
    trades: stats.trades,
    netExp: stats.expectancy,
    netTotalR: stats.totalR,
    sharpe: sh,
    topSymShare: topShare,
    conc: conc.killSwitchTripped ? 1 : 0,
  });
}

rows.sort((a, b) => b.netExp - a.netExp);

console.log(`\nResults (sorted by net OOS expectancy, costs applied):\n`);
console.log(
  "rank  config                              n     netExp    totalR   sharpe   topSym%   exp-gate  sharpe-gate  conc-gate",
);
console.log(
  "----  ----------------------------------- ----- --------- -------- -------- --------- --------- ----------- ---------",
);
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]!;
  const expGate = r.netExp > 0.1 ? "PASS" : "fail";
  const shGate = r.sharpe > 1.0 ? "PASS" : "fail";
  const concGate = r.topSymShare <= 0.5 ? "PASS" : "fail";
  console.log(
    `${(i + 1).toString().padStart(4)}  ${r.id.padEnd(35)} ${r.trades.toString().padStart(5)} ${r.netExp.toFixed(3).padStart(9)} ${r.netTotalR.toFixed(2).padStart(8)} ${r.sharpe.toFixed(2).padStart(8)} ${(r.topSymShare * 100).toFixed(1).padStart(8)}%  ${expGate.padEnd(8)}  ${shGate.padEnd(10)}  ${concGate}`,
  );
}

const passes = rows.filter((r) => r.netExp > 0.1 && r.sharpe > 1.0 && r.topSymShare <= 0.5);
console.log(`\n${passes.length}/32 configs pass all three gates (exp/sharpe/conc).`);
