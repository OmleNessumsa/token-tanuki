/**
 * P0.1 (Fase 0, CRYPTOTRADER_BUILD_PLAN.md) — the decisive test of
 * Strategy A: long-biased, vol-targeted, low-turnover time-series trend
 * following. This is the one strategy CLASS the 9-hypothesis graveyard
 * never tested, and the one the market picture (trending, right-skewed)
 * structurally favors.
 *
 * Design (pre-registered, decided before running):
 * - Universe: cached daily bars, symbols with >= 2.5y history (so every
 *   year-bucket is populated). BTC included as both a holding and the
 *   benchmark.
 * - Signal per symbol per day: TSMOM — long if trailing-L-day log return
 *   > 0, else FLAT. No shorts (H3 tail rule). Two pre-registered lookbacks:
 *   L = 30 and L = 90 days.
 * - Sizing: inverse-vol. Each held symbol weighted by 1/vol(30d), weights
 *   normalized across currently-long symbols, then the whole book scaled
 *   to a target annualized vol (50%) with a max gross leverage of 1.0
 *   (no leverage — long-only cash book). This directly fixes H3 (no single
 *   moonshot/crash dominates) and the funding-xsec beta-blindness.
 * - Rebalance: weekly (every 7 trading days) → LOW turnover, so the cost
 *   wall that killed H2 is non-binding. Costs charged on measured turnover
 *   at 14bps/leg round-trip.
 * - Benchmark: buy-and-hold BTC over the same window.
 *
 * Pre-registered PASS gate (per lookback):
 *   net Sharpe >= 1.0 over full window, AND net return positive in >= 2/3
 *   calendar-year buckets, AND max drawdown < 30%, AND net Sharpe >
 *   BTC buy-hold Sharpe.
 * Any lookback passing -> Strategy A is alive -> Fase 1 (refine + cert).
 * Neither -> trend class dead too -> lean to B (maker) or C5.
 */

import { promises as fs } from "node:fs";
import { fetchBars, meanT } from "./lib/bulk-fetch.js";
import type { Candle } from "../src/analysis/indicators.js";

const WINDOW_DAYS = 1095;
const DAY_MS = 86_400_000;
const MIN_HISTORY_DAYS = 900; // ~2.5y
const LOOKBACKS_D = [30, 90];
const VOL_LOOKBACK_D = 30;
const REBALANCE_D = 7;
const TARGET_ANN_VOL = 0.5; // 50% annualized portfolio vol target
const MAX_GROSS = 1.0; // long-only, no leverage
const COST_PER_LEG_RT = 0.0014;
const ANN = Math.sqrt(365);

// Universe: the symbols we know have deep history (from H1/H3 runs).
const UNIVERSE = [
  "BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT", "ADA-USDT",
  "AVAX-USDT", "LINK-USDT", "ATOM-USDT", "BCH-USDT", "LTC-USDT", "BNB-USDT",
  "TRX-USDT", "XLM-USDT", "SUI-USDT", "APT-USDT", "NEAR-USDT", "FIL-USDT",
  "INJ-USDT", "ARB-USDT", "OP-USDT", "PEPE-USDT", "WLD-USDT", "CRV-USDT",
  "DOT-USDT", "AAVE-USDT",
];

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / DAY_MS) * DAY_MS;
const FROM_MS = TO_MS - WINDOW_DAYS * DAY_MS;
console.log(`window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)} (${WINDOW_DAYS}d)\n`);

console.log(`[1/3] loading cached daily bars...`);
interface Sym {
  instId: string;
  days: number[]; // sorted day-open ms
  close: Map<number, number>;
}
const syms: Sym[] = [];
for (const instId of UNIVERSE) {
  let bars: Candle[];
  try {
    bars = await fetchBars(instId, "1D", FROM_MS, TO_MS);
  } catch {
    continue;
  }
  if (bars.length < MIN_HISTORY_DAYS) {
    console.log(`  ${instId}: ${bars.length}d — drop`);
    continue;
  }
  const close = new Map<number, number>();
  for (const b of bars) close.set(b.t * 1000, b.c);
  syms.push({ instId, days: bars.map((b) => b.t * 1000).sort((a, b) => a - b), close });
}
console.log(`  ${syms.length} symbols in universe`);
const btc = syms.find((s) => s.instId === "BTC-USDT")!;

// Master daily grid = BTC's days (the most complete series).
const grid = btc.days.filter((d) => d >= FROM_MS && d < TO_MS);

const logret = (s: Sym, fromMs: number, toMs: number): number | undefined => {
  const a = s.close.get(fromMs);
  const b = s.close.get(toMs);
  return a !== undefined && b !== undefined && a > 0 && b > 0 ? Math.log(b / a) : undefined;
};

function trailingVol(s: Sym, dayMs: number): number | undefined {
  const rets: number[] = [];
  for (let k = 0; k < VOL_LOOKBACK_D; k++) {
    const r = logret(s, dayMs - (k + 1) * DAY_MS, dayMs - k * DAY_MS);
    if (r === undefined) return undefined;
    rets.push(r);
  }
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1));
  return v > 0 ? v : undefined;
}

interface YearStat { year: number; ret: number }
interface Result {
  lookback: number;
  dailyRets: number[];
  equity: number[];
  sharpe: number;
  annRet: number;
  annVol: number;
  maxDD: number;
  meanTurnover: number;
  byYear: YearStat[];
}

function summarize(lookback: number, dailyRets: number[], dayStamps: number[], turnovers: number[]): Result {
  const eq: number[] = [1];
  for (const r of dailyRets) eq.push(eq[eq.length - 1]! * (1 + r));
  let peak = eq[0]!;
  let maxDD = 0;
  for (const e of eq) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const { mean, t } = meanT(dailyRets);
  void t;
  const sd = Math.sqrt(dailyRets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, dailyRets.length - 1));
  const sharpe = sd > 0 ? (mean / sd) * ANN : 0;
  const annRet = mean * 365;
  const annVol = sd * ANN;
  const yearMap = new Map<number, number>();
  for (let i = 0; i < dailyRets.length; i++) {
    const y = new Date(dayStamps[i]!).getUTCFullYear();
    yearMap.set(y, (yearMap.get(y) ?? 0) + Math.log(1 + dailyRets[i]!));
  }
  const byYear = [...yearMap.entries()].map(([year, lr]) => ({ year, ret: Math.exp(lr) - 1 })).sort((a, b) => a.year - b.year);
  return {
    lookback, dailyRets, equity: eq, sharpe, annRet, annVol, maxDD,
    meanTurnover: turnovers.reduce((a, b) => a + b, 0) / Math.max(1, turnovers.length),
    byYear,
  };
}

console.log(`\n[2/3] simulating...`);
const results: Result[] = [];

for (const L of LOOKBACKS_D) {
  const dailyRets: number[] = [];
  const dayStamps: number[] = [];
  const turnovers: number[] = [];
  let weights = new Map<string, number>(); // current target weights

  for (let gi = 1; gi < grid.length; gi++) {
    const today = grid[gi]!;
    const yest = grid[gi - 1]!;

    // Realize yesterday's weights against today's per-symbol return.
    let portRet = 0;
    for (const [id, w] of weights) {
      const s = syms.find((x) => x.instId === id)!;
      const r = logret(s, yest, today);
      if (r !== undefined) portRet += w * (Math.exp(r) - 1);
    }
    dailyRets.push(portRet);
    dayStamps.push(today);

    // Rebalance every REBALANCE_D days (using info available at `today`).
    if ((gi - 1) % REBALANCE_D === 0) {
      const cand: { id: string; invVol: number }[] = [];
      for (const s of syms) {
        const mom = logret(s, today - L * DAY_MS, today);
        if (mom === undefined || mom <= 0) continue; // long only if uptrend
        const vol = trailingVol(s, today);
        if (vol === undefined) continue;
        cand.push({ id: s.instId, invVol: 1 / vol });
      }
      const newW = new Map<string, number>();
      if (cand.length > 0) {
        const sumInv = cand.reduce((a, c) => a + c.invVol, 0);
        // Inverse-vol weights, then scale book to target vol via a crude
        // estimate: portfolio vol ~ weighted-avg single-name vol / sqrt(n)
        // is too optimistic; use weighted-avg single-name vol as the
        // conservative book-vol proxy (assumes correlation ~1 in stress).
        const wavgVol = cand.reduce((a, c) => a + (c.invVol / sumInv) * (1 / c.invVol), 0); // = n/sumInv
        const annNameVol = wavgVol * ANN;
        const scale = Math.min(MAX_GROSS, TARGET_ANN_VOL / annNameVol);
        for (const c of cand) newW.set(c.id, (c.invVol / sumInv) * scale);
      }
      // Turnover = sum |new - old| across union, charged as cost.
      const ids = new Set([...weights.keys(), ...newW.keys()]);
      let turnover = 0;
      for (const id of ids) turnover += Math.abs((newW.get(id) ?? 0) - (weights.get(id) ?? 0));
      turnovers.push(turnover);
      // Subtract cost from today's return.
      dailyRets[dailyRets.length - 1]! -= turnover * COST_PER_LEG_RT;
      weights = newW;
    }
  }
  results.push(summarize(L, dailyRets, dayStamps, turnovers));
  console.log(`  L=${L}d done (${dailyRets.length} days)`);
}

// BTC buy-and-hold benchmark.
const btcRets: number[] = [];
const btcStamps: number[] = [];
for (let gi = 1; gi < grid.length; gi++) {
  const r = logret(btc, grid[gi - 1]!, grid[gi]!);
  if (r !== undefined) { btcRets.push(Math.exp(r) - 1); btcStamps.push(grid[gi]!); }
}
const btcRes = summarize(-1, btcRets, btcStamps, [0]);

const tag = new Date(TO_MS).toISOString().slice(0, 10);
await fs.mkdir("logs", { recursive: true });
await fs.writeFile(
  `logs/probe-trend-cert-${tag}.json`,
  JSON.stringify({ fromMs: FROM_MS, toMs: TO_MS, universe: syms.map((s) => s.instId), results, btc: btcRes }, null, 2),
);

console.log(`\n[3/3] results vs pre-registered gates:\n`);
console.log(`  BENCHMARK BTC buy-hold:  Sharpe=${btcRes.sharpe.toFixed(2)}  annRet=${(btcRes.annRet * 100).toFixed(0)}%  annVol=${(btcRes.annVol * 100).toFixed(0)}%  maxDD=${(btcRes.maxDD * 100).toFixed(0)}%`);
console.log(`     by year: ${btcRes.byYear.map((y) => `${y.year}:${(y.ret * 100).toFixed(0)}%`).join("  ")}\n`);

let anyPass = false;
for (const r of results) {
  const posYears = r.byYear.filter((y) => y.ret > 0).length;
  const pass = r.sharpe >= 1.0 && posYears >= Math.ceil((r.byYear.length * 2) / 3) && r.maxDD < 0.30 && r.sharpe > btcRes.sharpe;
  anyPass ||= pass;
  console.log(`  TSMOM L=${r.lookback}d:  Sharpe=${r.sharpe.toFixed(2)}  annRet=${(r.annRet * 100).toFixed(0)}%  annVol=${(r.annVol * 100).toFixed(0)}%  maxDD=${(r.maxDD * 100).toFixed(0)}%  turnover/reb=${(r.meanTurnover * 100).toFixed(0)}%`);
  console.log(`     by year: ${r.byYear.map((y) => `${y.year}:${(y.ret * 100).toFixed(0)}%`).join("  ")}  (${posYears}/${r.byYear.length} positive)`);
  console.log(`     → ${pass ? "PASS" : "fail"}  [need Sharpe≥1.0, ≥${Math.ceil((r.byYear.length * 2) / 3)}/${r.byYear.length} yrs +, maxDD<30%, Sharpe>BTC(${btcRes.sharpe.toFixed(2)})]\n`);
}

console.log(`P0.1 VERDICT: ${anyPass ? "PASS — Strategy A alive → proceed to Fase 1 (refine + walk-forward cert)" : "FAIL — trend class also dead on this universe → lean to Strategy B (maker) or C5"}`);
