/**
 * C4 robustness check on the funding-percentile signal from
 * probe-funding-btc.ts. That probe showed negative IC strengthening with
 * horizon on BTC/ETH — but with two known inflation sources:
 *
 * 1. OVERLAP: settlements every 8h vs 72h forward windows → 9× overlapping
 *    observations → naive z-scores overstated ~3×. Fix: stride the
 *    observations so forward windows are disjoint.
 * 2. REGIME CONFOUND: one 90d window with known regime structure. High
 *    funding percentile = "after a rally" — in a net-bearish window that
 *    correlation is β, not α. Fix: split-half sign stability + 5 symbols.
 *
 * Pass criteria (decided BEFORE running, so no goalpost-moving):
 * - Non-overlapping IC at h=72 negative on ≥4/5 symbols, AND
 * - Full-sample IC at h=72 negative in BOTH 45d halves on ≥3/5 symbols.
 */

import { promises as fs } from "node:fs";
import { loadCachedSeries } from "../src/backtest/data-fetcher.js";
import { getFundingRateHistory } from "../src/clients/blofin.js";
import type { Candle } from "../src/analysis/indicators.js";

const SYMS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"];
const HOUR_SEC = 3600;
const LOOKBACK_SETTLEMENTS = 90;
const HORIZONS_H = [24, 72];

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

function percentile(window: readonly number[], x: number): number {
  let below = 0;
  let ties = 0;
  for (const w of window) {
    if (w < x) below++;
    else if (w === x) ties++;
  }
  return (below + ties / 2) / window.length;
}

function rank(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k]![1]] = avg;
    i = j + 1;
  }
  return ranks;
}

function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length < 3) return 0;
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let k = 0; k < n; k++) {
    const dx = rx[k]! - mx;
    const dy = ry[k]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

interface Obs {
  settleMs: number;
  pct: number;
  fwd: Record<number, number>;
}

interface SymResult {
  sym: string;
  n: number;
  icFull: Record<number, number>;
  icHalf1: Record<number, number>;
  icHalf2: Record<number, number>;
  icNonOverlap: Record<number, { ic: number; n: number; z: number }>;
}

const results: SymResult[] = [];

for (const sym of SYMS) {
  const series = await loadCachedSeries(sym);
  if (!series || series.candles.length === 0) {
    console.log(`${sym}: no candle cache — skip`);
    continue;
  }
  const hourly = aggregateTo1h(series.candles);
  const firstBarMs = hourly[0]!.t * 1000;
  const lastBarMs = hourly[hourly.length - 1]!.t * 1000;
  const fundingFromMs = firstBarMs - LOOKBACK_SETTLEMENTS * 8 * 3600 * 1000;
  const funding = await getFundingRateHistory(sym, fundingFromMs);
  const fundingNums = funding.map((f) => ({ tMs: Number(f.fundingTime), rate: Number(f.fundingRate) }));

  const barTimesMs = hourly.map((b) => b.t * 1000);
  const firstBarAtOrAfter = (ms: number): number => {
    let lo = 0;
    let hi = barTimesMs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (barTimesMs[mid]! < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const maxH = Math.max(...HORIZONS_H);
  const obs: Obs[] = [];
  for (let i = LOOKBACK_SETTLEMENTS; i < fundingNums.length; i++) {
    const f = fundingNums[i]!;
    if (f.tMs < firstBarMs || f.tMs > lastBarMs) continue;
    const entryIdx = firstBarAtOrAfter(f.tMs);
    if (entryIdx + maxH >= hourly.length) continue;
    const trailing = fundingNums.slice(i - LOOKBACK_SETTLEMENTS, i).map((x) => x.rate);
    const pct = percentile(trailing, f.rate);
    const entry = hourly[entryIdx]!.o;
    const fwd: Record<number, number> = {};
    for (const h of HORIZONS_H) {
      fwd[h] = Math.log(hourly[entryIdx + h]!.o / entry);
    }
    obs.push({ settleMs: f.tMs, pct, fwd });
  }
  if (obs.length < 50) {
    console.log(`${sym}: only ${obs.length} obs — skip`);
    continue;
  }

  const mid = obs[Math.floor(obs.length / 2)]!.settleMs;
  const half1 = obs.filter((o) => o.settleMs < mid);
  const half2 = obs.filter((o) => o.settleMs >= mid);

  const res: SymResult = {
    sym,
    n: obs.length,
    icFull: {},
    icHalf1: {},
    icHalf2: {},
    icNonOverlap: {},
  };
  for (const h of HORIZONS_H) {
    res.icFull[h] = spearman(obs.map((o) => o.pct), obs.map((o) => o.fwd[h]!));
    res.icHalf1[h] = spearman(half1.map((o) => o.pct), half1.map((o) => o.fwd[h]!));
    res.icHalf2[h] = spearman(half2.map((o) => o.pct), half2.map((o) => o.fwd[h]!));
    const stride = Math.ceil(h / 8);
    const strided = obs.filter((_, i) => i % stride === 0);
    const ic = spearman(strided.map((o) => o.pct), strided.map((o) => o.fwd[h]!));
    res.icNonOverlap[h] = { ic, n: strided.length, z: ic * Math.sqrt(Math.max(0, strided.length - 1)) };
  }
  results.push(res);
}

await fs.mkdir("logs", { recursive: true });
const tag = new Date(results.length ? Date.now() : 0).toISOString().slice(0, 10);
await fs.writeFile(`logs/probe-funding-robustness-${tag}.json`, JSON.stringify(results, null, 2));
console.log(`raw results persisted → logs/probe-funding-robustness-${tag}.json\n`);

for (const h of HORIZONS_H) {
  console.log(`========== h=${h}h ==========`);
  console.log(`sym         n     IC(full)  IC(half1)  IC(half2)  IC(non-ovl)  n(no)  z(no)`);
  for (const r of results) {
    const no = r.icNonOverlap[h]!;
    console.log(
      `${r.sym.padEnd(10)} ${r.n.toString().padStart(4)}  ${r.icFull[h]!.toFixed(3).padStart(8)}  ${r.icHalf1[h]!.toFixed(3).padStart(8)}  ${r.icHalf2[h]!.toFixed(3).padStart(8)}  ${no.ic.toFixed(3).padStart(9)}  ${no.n.toString().padStart(5)}  ${no.z.toFixed(2).padStart(6)}`,
    );
  }
  const negNonOverlap = results.filter((r) => r.icNonOverlap[h]!.ic < 0).length;
  const negBothHalves = results.filter((r) => r.icHalf1[h]! < 0 && r.icHalf2[h]! < 0).length;
  console.log(`  non-overlap IC negative: ${negNonOverlap}/${results.length}   both halves negative: ${negBothHalves}/${results.length}`);
}

console.log(`\nPass criteria (pre-registered): h=72 non-overlap negative ≥4/5 AND h=72 both-halves negative ≥3/5.`);
const no72 = results.filter((r) => r.icNonOverlap[72]!.ic < 0).length;
const bh72 = results.filter((r) => r.icHalf1[72]! < 0 && r.icHalf2[72]! < 0).length;
console.log(`Result: non-overlap ${no72}/${results.length}, both-halves ${bh72}/${results.length} → ${no72 >= 4 && bh72 >= 3 ? "PASS" : "FAIL"}`);
