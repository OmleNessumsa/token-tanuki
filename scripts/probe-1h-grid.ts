/**
 * C3 timeframe-shift probe: the same scoreChart composite + trend/stage2
 * signal set, but on 1h bars aggregated from the cached 5m series.
 *
 * Hypothesis (HANDOVER_2026-06-12 §C3): 5m is too noisy; trend continuation
 * may exist on 1h that does not exist on 5m. If mean LONG/SHORT expectancy
 * on 1h looks materially different from the 5m baselines (LONG ≈ -0.66 to
 * -1.03R, SHORT regime-flipping), proceed to a multi-window check; otherwise
 * C3 is dead and the next step is C4 (new signal source).
 *
 * Design choices:
 * - 60d window (≈1440 1h bars) so the 200-bar warmup (8.3d) still leaves
 *   ~50d of tradeable bars. The 30d window of the 5m probes would lose 28%
 *   of its bars to warmup on 1h.
 * - Horizons in TIME, not bar-count: 6h/12h/24h/48h (= 6/12/24/48 bars).
 *   The 5m probes covered 3h-24h; 48h extends the trend-continuation side.
 * - cooldownBars = 6 (6h). The 5m grid used 12 bars = 1h; scaling by time
 *   would give 1 bar, scaling by bar-count gives 12 (12h). 6 is the
 *   documented middle ground — a probe-level choice, not a tunable to sweep.
 * - Window anchored on the last cached bar (common across symbols), not
 *   wall-clock now, so a stale cache doesn't silently shorten the window.
 * - Raw rows are persisted to logs/ BEFORE any display formatting.
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
const WIN_DAYS = 60;
const HOUR_SEC = 3600;

const THRESHOLDS = [55, 60, 65, 70];
const STAGE2 = [true, false];
const ATR_MULT = [1.5, 2.5];
const SIDES: Array<"LONG" | "SHORT"> = ["LONG", "SHORT"];
/** 1h bars → horizon bars are literal hours. */
const HORIZONS = [6, 12, 24, 48];
const FIXED = {
  warmupBars: 200,
  cooldownBars: 6,
  stage2SmaPeriod: 150,
  requireBreakout: false,
};

/**
 * Aggregate oldest-first 5m candles into 1h candles aligned on the hour.
 * O = first bar's open, H/L = extremes, C = last bar's close, V = sum.
 * Partial buckets (data gaps) are kept — their OHLC is still the true OHLC
 * of the observed bars — but counted and reported.
 */
function aggregateTo1h(candles: readonly Candle[]): { hourly: Candle[]; partial: number } {
  const hourly: Candle[] = [];
  let partial = 0;
  let bucket: Candle | null = null;
  let bucketCount = 0;
  for (const c of candles) {
    const hourT = Math.floor(c.t / HOUR_SEC) * HOUR_SEC;
    if (bucket && bucket.t === hourT) {
      bucket.h = Math.max(bucket.h, c.h);
      bucket.l = Math.min(bucket.l, c.l);
      bucket.c = c.c;
      bucket.v += c.v;
      bucketCount++;
    } else {
      if (bucket) {
        if (bucketCount < 12) partial++;
        hourly.push(bucket);
      }
      bucket = { t: hourT, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
      bucketCount = 1;
    }
  }
  if (bucket) {
    if (bucketCount < 12) partial++;
    hourly.push(bucket);
  }
  return { hourly, partial };
}

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
          const id = `1h-${side}-c${t}-${s2Tag}-atr${a}-h${horizon}`;
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

console.log(`[1/4] loading cached 5m series...`);
const rawBySymbol: Record<string, Candle[]> = {};
let commonLastSec = Number.POSITIVE_INFINITY;
for (const sym of SYMS) {
  const s = await loadCachedSeries(sym);
  if (!s || s.candles.length === 0) {
    console.log(`  ${sym}: no cache (skip)`);
    continue;
  }
  rawBySymbol[sym] = s.candles;
  const last = s.candles[s.candles.length - 1]!.t;
  if (last < commonLastSec) commonLastSec = last;
  console.log(`  ${sym}: ${s.candles.length} bars, last=${new Date(last * 1000).toISOString()}`);
}
if (!Number.isFinite(commonLastSec)) {
  console.error("no cached data at all — run the orchestrator with --cache-only first");
  process.exit(1);
}

// Common anchor: end of the last fully-shared hour bucket.
const TO_SEC = Math.floor(commonLastSec / HOUR_SEC) * HOUR_SEC;
const FROM_SEC = TO_SEC - WIN_DAYS * 86_400;
console.log(`  window: ${new Date(FROM_SEC * 1000).toISOString()} → ${new Date(TO_SEC * 1000).toISOString()} (${WIN_DAYS}d)`);

console.log(`\n[2/4] aggregating 5m → 1h...`);
const seriesBySymbol: Record<string, Candle[]> = {};
for (const sym of Object.keys(rawBySymbol)) {
  const windowed = rawBySymbol[sym]!.filter((c) => c.t >= FROM_SEC && c.t < TO_SEC);
  const { hourly, partial } = aggregateTo1h(windowed);
  seriesBySymbol[sym] = hourly;
  console.log(`  ${sym}: ${windowed.length} × 5m → ${hourly.length} × 1h (${partial} partial buckets)`);
}

console.log(`\n[3/4] precomputing score-cache on 1h bars (warmup=${FIXED.warmupBars}, stage2=${FIXED.stage2SmaPeriod})...`);
const t0 = performance.now();
const scoreSeriesBySymbol: Record<string, ReturnType<typeof precomputeScores>> = {};
for (const sym of Object.keys(seriesBySymbol)) {
  const ts = performance.now();
  scoreSeriesBySymbol[sym] = precomputeScores(seriesBySymbol[sym]!, FIXED.warmupBars, FIXED.stage2SmaPeriod);
  console.log(`  ${sym}: ${((performance.now() - ts) / 1000).toFixed(1)}s`);
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

console.log(`\n[4/4] sweeping ${HORIZONS.length} horizons × 32 configs...`);
for (const horizon of HORIZONS) {
  const grid = buildGrid(horizon);
  for (const spec of grid) {
    const allTrades: (BacktestTrade & { symbol: string })[] = [];
    for (const sym of Object.keys(seriesBySymbol)) {
      const candles = seriesBySymbol[sym]!;
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
  console.log(`  h=${horizon} done`);
}

// Persist raw rows BEFORE any display formatting (HANDOVER: probe-grid-windows
// lost a 16-min cache build to a display-stage typo).
const anchorTag = new Date(TO_SEC * 1000).toISOString().slice(0, 10);
const outPath = `logs/probe-1h-grid-${anchorTag}.json`;
await fs.mkdir("logs", { recursive: true });
await fs.writeFile(
  outPath,
  JSON.stringify({ windowDays: WIN_DAYS, fromSec: FROM_SEC, toSec: TO_SEC, syms: Object.keys(seriesBySymbol), fixed: FIXED, rows: allRows }, null, 2),
);
console.log(`\nraw rows persisted → ${outPath}`);

console.log(`\n========================================================================`);
console.log(`Top-10 by net expectancy, 1h bars, ${WIN_DAYS}d window (costs applied):`);
console.log(`========================================================================`);
const sorted = [...allRows].sort((a, b) => b.netExp - a.netExp);
console.log(
  "rank  config                                  h     n      netExp    totalR   sharpe   topSym%   gates(exp/sh/conc)",
);
console.log(
  "----  --------------------------------------- ---   ----   --------  -------- -------- --------- ------------------",
);
for (let i = 0; i < Math.min(10, sorted.length); i++) {
  const r = sorted[i]!;
  const expG = r.netExp > 0.1 ? "P" : ".";
  const shG = r.sharpe > 1.0 ? "P" : ".";
  const concG = r.topSymShare <= 0.5 ? "P" : ".";
  console.log(
    `${(i + 1).toString().padStart(4)}  ${r.id.padEnd(39)} ${r.horizon.toString().padStart(3)}   ${r.trades.toString().padStart(4)}   ${r.netExp.toFixed(3).padStart(8)} ${r.netTotalR.toFixed(1).padStart(8)} ${r.sharpe.toFixed(2).padStart(8)} ${(r.topSymShare * 100).toFixed(1).padStart(8)}%  ${expG}/${shG}/${concG}`,
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
    `  h=${h.toString().padStart(2)} (${h}h)  mean netExp=${meanExp.toFixed(3)}  LONG mean=${meanLongExp.toFixed(3)}  SHORT mean=${meanShortExp.toFixed(3)}  mean Sharpe=${meanShar.toFixed(2)}  mean n=${meanTrades.toFixed(0)}`,
  );
}

const passes = allRows.filter(
  (r) => r.netExp > 0.1 && r.sharpe > 1.0 && r.topSymShare <= 0.5,
);
console.log(`\n${passes.length}/${allRows.length} configs pass all three gates.`);
console.log(`5m baselines for comparison (HANDOVER §C2): LONG mean -0.66..-1.03R; SHORT h=36 -0.40R, h=288 +0.35R (regime-fit).`);
