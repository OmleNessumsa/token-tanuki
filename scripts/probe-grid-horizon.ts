/**
 * C2 horizon-extension probe: same 32 SMOKE_GRID configs (no invert) tested
 * at three horizons — 36 (3h, smoke #2 baseline), 144 (12h), 288 (24h).
 *
 * Goal: is the strategy's lack of edge a horizon issue? If the composite
 * + trend gates fire at local-top conditions, mean-reversion on 3h would
 * destroy them, but trend-continuation on 24h might recover edge.
 *
 * Reuses the same score-cache structure (warmup=200, stage2=150) for all
 * horizons — only the engine's forward-walk window varies.
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
const HORIZONS = [36, 144, 288];
const FIXED = {
  warmupBars: 200,
  cooldownBars: 12,
  stage2SmaPeriod: 150,
  requireBreakout: false,
};

interface ConfigSpec {
  id: string;
  cfg: BacktestConfig;
}

function buildGrid(horizon: number): ConfigSpec[] {
  const out: ConfigSpec[] = [];
  for (const t of THRESHOLDS) {
    for (const s2 of STAGE2) {
      for (const a of ATR_MULT) {
        for (const side of SIDES) {
          const s2Tag = s2 ? "s2T" : "s2F";
          const id = `${side}-c${t}-${s2Tag}-atr${a}-h${horizon}`;
          out.push({
            id,
            cfg: {
              thresholdComposite: t,
              requireStage2: s2,
              stopAtrMult: a,
              horizonBars: horizon,
              ...FIXED,
              side,
            },
          });
        }
      }
    }
  }
  return out;
}

console.log(`[1/3] loading cached series (${WIN_DAYS}d window)...`);
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

console.log(`\n[2/3] precomputing score-cache (warmup=${FIXED.warmupBars}, stage2=${FIXED.stage2SmaPeriod})...`);
const t0 = performance.now();
const scoreSeriesBySymbol: Record<string, any> = {};
for (const sym of Object.keys(seriesBySymbol)) {
  const candles = seriesBySymbol[sym];
  const ts = performance.now();
  const ss = precomputeScores(candles, FIXED.warmupBars, FIXED.stage2SmaPeriod);
  const te = performance.now();
  scoreSeriesBySymbol[sym] = ss;
  console.log(`  ${sym}: ${((te - ts) / 1000).toFixed(1)}s`);
}
console.log(`  cache total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

interface Row {
  id: string;
  horizon: number;
  side: "LONG" | "SHORT";
  trades: number;
  netExp: number;
  netTotalR: number;
  sharpe: number;
  topSymShare: number;
}

const allRows: Row[] = [];

for (const horizon of HORIZONS) {
  console.log(`\n[3/3] sweeping h=${horizon} (${(horizon * 5) / 60}h horizon)...`);
  const grid = buildGrid(horizon);
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
    allRows.push({
      id: spec.id,
      horizon,
      side: spec.cfg.side ?? "LONG",
      trades: stats.trades,
      netExp: stats.expectancy,
      netTotalR: stats.totalR,
      sharpe: sh,
      topSymShare: topShare,
    });
  }
}

console.log(`\n========================================================================`);
console.log(`Top-10 by net OOS expectancy across all horizons (costs applied):`);
console.log(`========================================================================`);
const sorted = [...allRows].sort((a, b) => b.netExp - a.netExp);
console.log(
  "rank  config                              h     n      netExp    totalR   sharpe   topSym%   gates(exp/sh/conc)",
);
console.log(
  "----  ----------------------------------- ---   ----   --------  -------- -------- --------- ------------------",
);
for (let i = 0; i < Math.min(10, sorted.length); i++) {
  const r = sorted[i]!;
  const expG = r.netExp > 0.1 ? "P" : ".";
  const shG = r.sharpe > 1.0 ? "P" : ".";
  const concG = r.topSymShare <= 0.5 ? "P" : ".";
  console.log(
    `${(i + 1).toString().padStart(4)}  ${r.id.padEnd(35)} ${r.horizon.toString().padStart(3)}   ${r.trades.toString().padStart(4)}   ${r.netExp.toFixed(3).padStart(8)} ${r.netTotalR.toFixed(1).padStart(8)} ${r.sharpe.toFixed(2).padStart(8)} ${(r.topSymShare * 100).toFixed(1).padStart(8)}%  ${expG}/${shG}/${concG}`,
  );
}

console.log(`\nSummary by horizon (mean of all 32 configs at that horizon):`);
for (const h of HORIZONS) {
  const rows = allRows.filter((r) => r.horizon === h);
  const meanExp = rows.reduce((a, r) => a + r.netExp, 0) / rows.length;
  const meanShar = rows.reduce((a, r) => a + r.sharpe, 0) / rows.length;
  const meanTrades = rows.reduce((a, r) => a + r.trades, 0) / rows.length;
  const longRows = rows.filter((r) => r.side === "LONG");
  const shortRows = rows.filter((r) => r.side === "SHORT");
  const meanLongExp = longRows.reduce((a, r) => a + r.netExp, 0) / longRows.length;
  const meanShortExp = shortRows.reduce((a, r) => a + r.netExp, 0) / shortRows.length;
  console.log(
    `  h=${h.toString().padStart(3)} (${((h * 5) / 60).toString().padStart(2)}h)  mean netExp=${meanExp.toFixed(3)}  LONG mean=${meanLongExp.toFixed(3)}  SHORT mean=${meanShortExp.toFixed(3)}  mean Sharpe=${meanShar.toFixed(2)}  mean n=${meanTrades.toFixed(0)}`,
  );
}

const passes = allRows.filter(
  (r) => r.netExp > 0.1 && r.sharpe > 1.0 && r.topSymShare <= 0.5,
);
console.log(`\n${passes.length}/${allRows.length} configs pass all three gates.`);
