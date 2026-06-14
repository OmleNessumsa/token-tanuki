/**
 * Fase-1 OOS gate (CRYPTOTRADER_BUILD_PLAN.md §14) — the decisive
 * out-of-sample test of the risk-managed beta harvester.
 *
 * The harvester (BTC vol-target + 100d-MA regime filter) was tuned on
 * 2023-06..2026-06 (Blofin cache) — ONE bull-bear cycle. The whole worry is
 * that the trend filter is fit to that single 2025-26 decline. This probe
 * runs the SAME strategy with the SAME fixed, pre-registered parameters
 * (MA=100, targetVol=0.40, volLB=30) on the PRIOR cycle using Binance daily
 * history back to 2018 — data the strategy has never seen.
 *
 * Note on data: Binance BTCUSDT/ETHUSDT spot, not Blofin perp. For a daily
 * low-turnover beta strategy the spot/perp basis is negligible; beta is
 * beta. Costs kept at the conservative 14bps/leg round-trip.
 *
 * Parameters are FROZEN before looking at pre-2023 results. No tuning here.
 *
 * Pre-registered PASS gate:
 *   A) Clean OOS (2018-01..2022-12, fully before the fit window): strategy
 *      Sharpe > buy-hold Sharpe AND strategy maxDD < 35% AND strategy
 *      maxDD < buy-hold maxDD.
 *   B) Walk-forward: across rolling 182-day folds over the FULL 2018-2026
 *      series, strategy beats buy-hold Sharpe in >= 60% of folds.
 * Both A and B must hold. Pass -> build (Fase 2). Fail -> one-cycle-fit ->
 * DCA fallback or Strategy B.
 */

import { promises as fs } from "node:fs";
import { meanT } from "./lib/bulk-fetch.js";
import type { Candle } from "../src/analysis/indicators.js";

const DAY_MS = 86_400_000;
const VOL_LB = 30;
const MA_LB = 100;
const TARGET_VOL = 0.4;
const COST = 0.0014;
const ANN = Math.sqrt(365);
const START_MS = Date.parse("2018-01-01T00:00:00Z");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBinanceDaily(symbol: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let start = START_MS;
  for (let page = 0; page < 50; page++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${start}&limit=1000`;
    let rows: unknown[] | null = null;
    for (let attempt = 0; attempt < 4 && rows === null; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** attempt);
      try {
        const res = await fetch(url);
        if (res.ok) rows = (await res.json()) as unknown[];
      } catch {
        /* retry */
      }
    }
    if (!rows || rows.length === 0) break;
    for (const r of rows as [number, string, string, string, string, string][]) {
      out.push({ t: Math.floor(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    }
    const lastMs = (rows[rows.length - 1] as [number])[0];
    if (rows.length < 1000) break;
    start = lastMs + DAY_MS;
    await sleep(200);
  }
  // dedupe + sort
  const seen = new Set<number>();
  return out.filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true))).sort((a, b) => a.t - b.t);
}

console.log(`[1/3] fetching Binance daily history (2018→now)...`);
const btcBars = await fetchBinanceDaily("BTCUSDT");
const ethBars = await fetchBinanceDaily("ETHUSDT");
console.log(`  BTC ${btcBars.length}d (${new Date(btcBars[0]!.t * 1000).toISOString().slice(0, 10)} → ${new Date(btcBars[btcBars.length - 1]!.t * 1000).toISOString().slice(0, 10)})`);
console.log(`  ETH ${ethBars.length}d`);

function toMap(bars: Candle[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of bars) m.set(b.t * 1000, b.c);
  return m;
}
const BTC = toMap(btcBars);
const ETH = toMap(ethBars);
const grid = btcBars.map((b) => b.t * 1000);

function lr(m: Map<number, number>, a: number, b: number): number | undefined {
  const x = m.get(a);
  const y = m.get(b);
  return x !== undefined && y !== undefined && x > 0 && y > 0 ? Math.log(y / x) : undefined;
}
function realVol(m: Map<number, number>, day: number): number | undefined {
  const r: number[] = [];
  for (let k = 0; k < VOL_LB; k++) { const v = lr(m, day - (k + 1) * DAY_MS, day - k * DAY_MS); if (v === undefined) return undefined; r.push(v); }
  const mn = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, x) => a + (x - mn) ** 2, 0) / (r.length - 1));
  return sd > 0 ? sd * ANN : undefined;
}
function aboveMA(m: Map<number, number>, day: number): boolean | undefined {
  const c = m.get(day);
  if (c === undefined) return undefined;
  let s = 0, n = 0;
  for (let k = 0; k < MA_LB; k++) { const v = m.get(day - k * DAY_MS); if (v !== undefined) { s += v; n++; } }
  return n < MA_LB * 0.8 ? undefined : c > s / n;
}

/** Per-day strategy & buy-hold returns over [fromMs,toMs). */
function series(m: Map<number, number>, fromMs: number, toMs: number) {
  const stratR: number[] = [], holdR: number[] = [], stamps: number[] = [];
  let prevW = 0;
  for (let i = 1; i < grid.length; i++) {
    const day = grid[i]!;
    if (day < fromMs || day >= toMs) continue;
    const r = lr(m, grid[i - 1]!, day);
    const hold = r !== undefined ? Math.exp(r) - 1 : 0;
    const v = realVol(m, day);
    const up = aboveMA(m, day);
    const w = v && up ? Math.min(1, TARGET_VOL / v) : 0;
    let sr = r !== undefined ? prevW * (Math.exp(r) - 1) : 0;
    sr -= Math.abs(w - prevW) * COST;
    stratR.push(sr); holdR.push(hold); stamps.push(day);
    prevW = w;
  }
  return { stratR, holdR, stamps };
}
function stat(rets: number[]) {
  if (rets.length < 2) return { sharpe: 0, annRet: 0, maxDD: 0 };
  const eq = [1];
  for (const r of rets) eq.push(eq[eq.length - 1]! * (1 + r));
  let peak = eq[0]!, maxDD = 0;
  for (const e of eq) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > maxDD) maxDD = dd; }
  const { mean } = meanT(rets);
  const sd = Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (rets.length - 1));
  return { sharpe: sd > 0 ? (mean / sd) * ANN : 0, annRet: mean * 365, maxDD };
}

console.log(`\n[2/3] OOS slice + walk-forward...`);
const OOS_FROM = Date.parse("2018-01-01T00:00:00Z");
const OOS_TO = Date.parse("2023-01-01T00:00:00Z");
const FULL_TO = grid[grid.length - 1]! + DAY_MS;

// A) Clean OOS 2018-2022, BTC.
const oos = series(BTC, OOS_FROM, OOS_TO);
const oosStrat = stat(oos.stratR);
const oosHold = stat(oos.holdR);

// Per-year (full range), BTC.
const full = series(BTC, OOS_FROM, FULL_TO);
const yearMap = new Map<number, { s: number; h: number }>();
for (let i = 0; i < full.stratR.length; i++) {
  const y = new Date(full.stamps[i]!).getUTCFullYear();
  const e = yearMap.get(y) ?? { s: 0, h: 0 };
  e.s += Math.log(1 + full.stratR[i]!); e.h += Math.log(1 + full.holdR[i]!);
  yearMap.set(y, e);
}
const byYear = [...yearMap.entries()].map(([year, e]) => ({ year, strat: Math.exp(e.s) - 1, hold: Math.exp(e.h) - 1 })).sort((a, b) => a.year - b.year);

// B) Walk-forward 182d folds over full range, BTC.
const FOLD = 182;
const foldResults: { from: string; stratSharpe: number; holdSharpe: number; win: boolean }[] = [];
for (let f = OOS_FROM; f + FOLD * DAY_MS <= FULL_TO; f += FOLD * DAY_MS) {
  const s = series(BTC, f, f + FOLD * DAY_MS);
  if (s.stratR.length < 60) continue;
  const ss = stat(s.stratR).sharpe, hs = stat(s.holdR).sharpe;
  foldResults.push({ from: new Date(f).toISOString().slice(0, 7), stratSharpe: ss, holdSharpe: hs, win: ss > hs });
}
const winFolds = foldResults.filter((f) => f.win).length;

await fs.mkdir("logs", { recursive: true });
await fs.writeFile(`logs/probe-beta-oos-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ oosStrat, oosHold, byYear, foldResults }, null, 2));

console.log(`\n[3/3] results vs pre-registered gate:\n`);
console.log(`  A) CLEAN OOS 2018-2022 (BTC, frozen params MA=${MA_LB} tvol=${TARGET_VOL}):`);
console.log(`     strategy:  Sharpe=${oosStrat.sharpe.toFixed(2)}  annRet=${(oosStrat.annRet * 100).toFixed(0)}%  maxDD=${(oosStrat.maxDD * 100).toFixed(0)}%`);
console.log(`     buy-hold:  Sharpe=${oosHold.sharpe.toFixed(2)}  annRet=${(oosHold.annRet * 100).toFixed(0)}%  maxDD=${(oosHold.maxDD * 100).toFixed(0)}%`);
const gateA = oosStrat.sharpe > oosHold.sharpe && oosStrat.maxDD < 0.35 && oosStrat.maxDD < oosHold.maxDD;
console.log(`     → gate A ${gateA ? "PASS" : "FAIL"} [strat Sharpe>hold, maxDD<35%, maxDD<hold]\n`);

console.log(`  per-year (strategy vs buy-hold):`);
for (const y of byYear) console.log(`     ${y.year}  strat ${(y.strat * 100).toFixed(0).padStart(5)}%   hold ${(y.hold * 100).toFixed(0).padStart(5)}%`);

console.log(`\n  B) walk-forward 182d folds: strategy beats buy-hold in ${winFolds}/${foldResults.length} (${((winFolds / foldResults.length) * 100).toFixed(0)}%)`);
const gateB = winFolds / foldResults.length >= 0.6;
console.log(`     → gate B ${gateB ? "PASS" : "FAIL"} [≥60% of folds]\n`);

console.log(`OOS VERDICT: ${gateA && gateB ? "PASS — harvester survives the prior cycle → BUILD (Fase 2)" : "FAIL — one-cycle-fit → DCA fallback or Strategy B"}`);
