/**
 * C3 regime check (D1-equivalent for 1h bars): the same 1h grid from
 * probe-1h-grid.ts, run on two NON-OVERLAPPING 45d windows carved from the
 * ~90d 5m cache. If the SHORT-side means / top configs flip sign between
 * windows, the 1h result is regime-tracking — same verdict as 5m — and C3
 * is dead.
 *
 * 45d × 1h = ~1080 bars; 200-bar warmup leaves ~36d tradeable per window.
 */

import { promises as fs } from "node:fs";
import { loadCachedSeries } from "../src/backtest/data-fetcher.js";
import { precomputeScores, getScoreAt } from "../src/backtest/score-cache.js";
import type { Candle } from "../src/analysis/indicators.js";
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
const WIN_DAYS = 45;
const HOUR_SEC = 3600;

const THRESHOLDS = [55, 60, 65, 70];
const STAGE2 = [true, false];
const ATR_MULT = [1.5, 2.5];
const SIDES: Array<"LONG" | "SHORT"> = ["LONG", "SHORT"];
const HORIZONS = [12, 24, 48];
const FIXED = {
  warmupBars: 200,
  cooldownBars: 6,
  stage2SmaPeriod: 150,
  requireBreakout: false,
};

function aggregateTo1h(candles: readonly Candle[]): Candle[] {
  const hourly: Candle[] = [];
  let bucket: Candle | null = null;
  for (const c of candles) {
    const hourT = Math.floor(c.t / HOUR_SEC) * HOUR_SEC;
    if (bucket && bucket.t === hourT) {
      bucket.h = Math.max(bucket.h, c.h);
      bucket.l = Math.min(bucket.l, c.l);
      bucket.c = c.c;
      bucket.v += c.v;
    } else {
      if (bucket) hourly.push(bucket);
      bucket = { t: hourT, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    }
  }
  if (bucket) hourly.push(bucket);
  return hourly;
}

interface ConfigSpec {
  id: string;
  cfg: BacktestConfig;
}

function buildGrid(): ConfigSpec[] {
  const out: ConfigSpec[] = [];
  for (const horizon of HORIZONS) {
    for (const t of THRESHOLDS) {
      for (const s2 of STAGE2) {
        for (const a of ATR_MULT) {
          for (const side of SIDES) {
            const s2Tag = s2 ? "s2T" : "s2F";
            out.push({
              id: `1h-${side}-c${t}-${s2Tag}-atr${a}-h${horizon}`,
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
  }
  return out;
}

console.log(`[1/3] loading cached 5m series...`);
const rawBySymbol: Record<string, Candle[]> = {};
let commonLastSec = Number.POSITIVE_INFINITY;
let commonFirstSec = 0;
for (const sym of SYMS) {
  const s = await loadCachedSeries(sym);
  if (!s || s.candles.length === 0) {
    console.log(`  ${sym}: no cache (skip)`);
    continue;
  }
  rawBySymbol[sym] = s.candles;
  const last = s.candles[s.candles.length - 1]!.t;
  const first = s.candles[0]!.t;
  if (last < commonLastSec) commonLastSec = last;
  if (first > commonFirstSec) commonFirstSec = first;
}
const TO_SEC = Math.floor(commonLastSec / HOUR_SEC) * HOUR_SEC;
const coveredDays = (TO_SEC - commonFirstSec) / 86_400;
console.log(`  common coverage: ${coveredDays.toFixed(1)}d ending ${new Date(TO_SEC * 1000).toISOString()}`);

const WINDOWS = [
  { name: "W1 (recent 45d)", fromSec: TO_SEC - WIN_DAYS * 86_400, toSec: TO_SEC },
  { name: "W2 (-90..-45d)", fromSec: TO_SEC - 2 * WIN_DAYS * 86_400, toSec: TO_SEC - WIN_DAYS * 86_400 },
];

interface Row {
  window: string;
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
const grid = buildGrid();

for (const win of WINDOWS) {
  console.log(`\n[2/3] ${win.name}: ${new Date(win.fromSec * 1000).toISOString().slice(0, 10)} → ${new Date(win.toSec * 1000).toISOString().slice(0, 10)}`);
  const seriesBySymbol: Record<string, Candle[]> = {};
  const scoreSeriesBySymbol: Record<string, ReturnType<typeof precomputeScores>> = {};
  for (const sym of Object.keys(rawBySymbol)) {
    const windowed = rawBySymbol[sym]!.filter((c) => c.t >= win.fromSec && c.t < win.toSec);
    const hourly = aggregateTo1h(windowed);
    seriesBySymbol[sym] = hourly;
    scoreSeriesBySymbol[sym] = precomputeScores(hourly, FIXED.warmupBars, FIXED.stage2SmaPeriod);
    console.log(`  ${sym}: ${hourly.length} × 1h bars, score-cache built`);
  }

  for (const spec of grid) {
    const allTrades: (BacktestTrade & { symbol: string })[] = [];
    for (const sym of Object.keys(seriesBySymbol)) {
      const ss = scoreSeriesBySymbol[sym]!;
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
      const trades = runStrategyOnSeries(seriesBySymbol[sym]!, spec.cfg, lookup);
      for (const t of trades) {
        allTrades.push({ ...applyCosts(t, DEFAULT_COST_MODEL), symbol: sym });
      }
    }
    const stats = summarize(allTrades);
    const conc = symbolConcentration(allTrades);
    let topShare = 0;
    for (const b of conc.bySymbol) {
      const a = Math.abs(b.share);
      if (a > topShare) topShare = a;
    }
    allRows.push({
      window: win.name,
      id: spec.id,
      horizon: spec.cfg.horizonBars,
      side: spec.cfg.side ?? "LONG",
      trades: stats.trades,
      netExp: stats.expectancy,
      netTotalR: stats.totalR,
      sharpe: sharpe(stats.rDistribution),
      topSymShare: topShare,
    });
  }
}

const anchorTag = new Date(TO_SEC * 1000).toISOString().slice(0, 10);
const outPath = `logs/probe-1h-windows-${anchorTag}.json`;
await fs.mkdir("logs", { recursive: true });
await fs.writeFile(
  outPath,
  JSON.stringify({ windows: WINDOWS, syms: SYMS, fixed: FIXED, rows: allRows }, null, 2),
);
console.log(`\nraw rows persisted → ${outPath}`);

console.log(`\n[3/3] cross-window comparison`);
console.log(`\nMean SHORT netExp by horizon, per window:`);
for (const win of WINDOWS) {
  for (const h of HORIZONS) {
    const rows = allRows.filter((r) => r.window === win.name && r.horizon === h && r.side === "SHORT");
    const mean = rows.reduce((a, r) => a + r.netExp, 0) / rows.length;
    const meanN = rows.reduce((a, r) => a + r.trades, 0) / rows.length;
    console.log(`  ${win.name.padEnd(16)} h=${h.toString().padStart(2)}  SHORT mean=${mean.toFixed(3).padStart(7)}  mean n=${meanN.toFixed(0)}`);
  }
}
console.log(`\nMean LONG netExp by horizon, per window:`);
for (const win of WINDOWS) {
  for (const h of HORIZONS) {
    const rows = allRows.filter((r) => r.window === win.name && r.horizon === h && r.side === "LONG");
    const mean = rows.reduce((a, r) => a + r.netExp, 0) / rows.length;
    const meanN = rows.reduce((a, r) => a + r.trades, 0) / rows.length;
    console.log(`  ${win.name.padEnd(16)} h=${h.toString().padStart(2)}  LONG  mean=${mean.toFixed(3).padStart(7)}  mean n=${meanN.toFixed(0)}`);
  }
}

console.log(`\nPer-config sign stability (configs with n>=10 in BOTH windows):`);
const byId = new Map<string, Row[]>();
for (const r of allRows) {
  const list = byId.get(r.id) ?? [];
  list.push(r);
  byId.set(r.id, list);
}
let stablePos = 0;
let flipped = 0;
let eligible = 0;
for (const [id, rows] of byId) {
  if (rows.length !== 2) continue;
  const [a, b] = rows as [Row, Row];
  if (a.trades < 10 || b.trades < 10) continue;
  eligible++;
  if (a.netExp > 0 && b.netExp > 0) {
    stablePos++;
    console.log(`  STABLE+  ${id.padEnd(38)} W1=${a.netExp.toFixed(3)} (n=${a.trades})  W2=${b.netExp.toFixed(3)} (n=${b.trades})`);
  } else if (a.netExp * b.netExp < 0) {
    flipped++;
  }
}
console.log(`\n  eligible (n>=10 both windows): ${eligible}`);
console.log(`  stable-positive in both:       ${stablePos}`);
console.log(`  sign-flipped:                  ${flipped}`);
