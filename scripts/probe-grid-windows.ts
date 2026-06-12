/**
 * D1 regime-robustness check: same 32 SMOKE_GRID configs at horizon=288
 * (the C2 sweet-spot), tested on TWO earlier 30d windows that don't overlap
 * with the recent test slice. If SHORT-c65-atr1.5-h288 reproduces +0.7R
 * netExp on both, the edge is robust. If it craters, C2 was regime-fit.
 *
 * Windows:
 *   W2: NOW - 60d → NOW - 30d   (earlier OOS)
 *   W3: NOW - 90d → NOW - 60d   (earlier still)
 *
 * Compares to W1 result (NOW - 30d → NOW) from logs/probe-grid-horizon.log
 * line "h=288 SHORT mean +0.347, top SHORT-c65-s2T-atr1.5 +0.788".
 */

import { writeFileSync } from "node:fs";
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
const DAY = 86_400_000;

interface Window {
  label: string;
  fromMs: number;
  toMs: number;
}

const WINDOWS: Window[] = [
  { label: "W2_60-30d_back", fromMs: NOW - 60 * DAY, toMs: NOW - 30 * DAY },
  { label: "W3_90-60d_back", fromMs: NOW - 90 * DAY, toMs: NOW - 60 * DAY },
];

const THRESHOLDS = [55, 60, 65, 70];
const STAGE2 = [true, false];
const ATR_MULT = [1.5, 2.5];
const SIDES: Array<"LONG" | "SHORT"> = ["LONG", "SHORT"];
const HORIZON = 288;
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

function buildGrid(): ConfigSpec[] {
  const out: ConfigSpec[] = [];
  for (const t of THRESHOLDS) {
    for (const s2 of STAGE2) {
      for (const a of ATR_MULT) {
        for (const side of SIDES) {
          const s2Tag = s2 ? "s2T" : "s2F";
          out.push({
            id: `${side}-c${t}-${s2Tag}-atr${a}-h${HORIZON}`,
            cfg: {
              thresholdComposite: t,
              requireStage2: s2,
              stopAtrMult: a,
              horizonBars: HORIZON,
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

interface Row {
  window: string;
  id: string;
  side: "LONG" | "SHORT";
  trades: number;
  netExp: number;
  sharpe: number;
  topSymShare: number;
}
const allRows: Row[] = [];

for (const win of WINDOWS) {
  console.log(`\n========================================================`);
  console.log(`Window ${win.label}: ${new Date(win.fromMs).toISOString().slice(0, 10)} → ${new Date(win.toMs).toISOString().slice(0, 10)}`);
  console.log(`========================================================`);

  const seriesBySymbol: Record<string, any> = {};
  for (const sym of SYMS) {
    const s = await loadCachedSeries(sym);
    if (!s) continue;
    const candles = s.candles.filter(
      (c) => c.t * 1000 >= win.fromMs && c.t * 1000 < win.toMs,
    );
    seriesBySymbol[sym] = candles;
  }
  console.log(`  bars/sym: ${Object.values(seriesBySymbol).map((c: any) => c.length).join(", ")}`);

  console.log(`  precomputing scores...`);
  const scoreSeriesBySymbol: Record<string, any> = {};
  const tCacheStart = performance.now();
  for (const sym of Object.keys(seriesBySymbol)) {
    const ts = performance.now();
    const ss = precomputeScores(seriesBySymbol[sym], FIXED.warmupBars, FIXED.stage2SmaPeriod);
    scoreSeriesBySymbol[sym] = ss;
    console.log(`    ${sym}: ${((performance.now() - ts) / 1000).toFixed(1)}s`);
  }
  console.log(`  cache total: ${((performance.now() - tCacheStart) / 1000).toFixed(1)}s`);

  const grid = buildGrid();
  console.log(`  sweeping ${grid.length} configs at h=${HORIZON}...`);
  for (const spec of grid) {
    const allTrades: (BacktestTrade & { symbol: string })[] = [];
    for (const sym of Object.keys(seriesBySymbol)) {
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
      const trades = runStrategyOnSeries(seriesBySymbol[sym], spec.cfg, lookup);
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
      window: win.label,
      id: spec.id,
      side: spec.cfg.side ?? "LONG",
      trades: stats.trades,
      netExp: stats.expectancy,
      sharpe: sh,
      topSymShare: topShare,
    });
  }
}

// Persist raw rows BEFORE display so a formatter crash doesn't wipe 16min.
const ROWS_OUT = "logs/probe-grid-windows-rows.json";
writeFileSync(ROWS_OUT, JSON.stringify(allRows, null, 2));
console.log(`\nraw rows persisted to ${ROWS_OUT}`);

console.log(`\n========================================================`);
console.log(`Side-by-side compare: top-tier configs across windows`);
console.log(`========================================================`);
const headlineIds = [
  "SHORT-c65-s2T-atr1.5-h288",
  "SHORT-c65-s2F-atr1.5-h288",
  "SHORT-c65-s2T-atr2.5-h288",
  "SHORT-c65-s2F-atr2.5-h288",
  "SHORT-c70-s2T-atr1.5-h288",
  "SHORT-c70-s2F-atr1.5-h288",
];
console.log(
  "config                              W1 (recent 30d)*    W2 (60-30d back)     W3 (90-60d back)",
);
console.log(
  "                                    netExp / n          netExp / n           netExp / n",
);
console.log(
  "----------------------------------- ------------------- -------------------- --------------------",
);

const W1_REFERENCE: Record<string, { netExp: number; n: number }> = {
  "SHORT-c65-s2T-atr1.5-h288": { netExp: 0.788, n: 29 },
  "SHORT-c65-s2F-atr1.5-h288": { netExp: 0.715, n: 30 },
  "SHORT-c65-s2T-atr2.5-h288": { netExp: 0.213, n: 29 },
  "SHORT-c65-s2F-atr2.5-h288": { netExp: 0.435, n: 30 },
  "SHORT-c70-s2T-atr1.5-h288": { netExp: 1.701, n: 8 },
  "SHORT-c70-s2F-atr1.5-h288": { netExp: 1.701, n: 8 },
};

for (const id of headlineIds) {
  const w1 = W1_REFERENCE[id];
  const w2 = allRows.find((r) => r.window === "W2_60-30d_back" && r.id === id);
  const w3 = allRows.find((r) => r.window === "W3_90-60d_back" && r.id === id);
  const fmt = (r: { netExp: number; trades?: number; n?: number } | undefined) => {
    if (!r) return "n/a".padEnd(18);
    const count = r.trades ?? r.n ?? 0;
    return `${r.netExp.toFixed(3).padStart(7)} / n=${count.toString().padStart(3)}`.padEnd(18);
  };
  console.log(`${id.padEnd(35)} ${fmt(w1)}  ${fmt(w2)}  ${fmt(w3)}`);
}
console.log(`\n* W1 reference values are from logs/probe-grid-horizon.log (the C2 probe).`);

console.log(`\nPer-window summary (mean over 32 configs):`);
for (const win of WINDOWS) {
  const rows = allRows.filter((r) => r.window === win.label);
  const meanExp = rows.reduce((a, r) => a + r.netExp, 0) / rows.length;
  const longRows = rows.filter((r) => r.side === "LONG");
  const shortRows = rows.filter((r) => r.side === "SHORT");
  const meanLong = longRows.reduce((a, r) => a + r.netExp, 0) / longRows.length;
  const meanShort = shortRows.reduce((a, r) => a + r.netExp, 0) / shortRows.length;
  const passes = rows.filter((r) => r.netExp > 0.1 && r.sharpe > 1.0 && r.topSymShare <= 0.5).length;
  console.log(
    `  ${win.label}  mean netExp=${meanExp.toFixed(3)}  LONG=${meanLong.toFixed(3)}  SHORT=${meanShort.toFixed(3)}  passes(all 3 gates)=${passes}/32`,
  );
}
