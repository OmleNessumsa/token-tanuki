/**
 * C4 first experiment (HANDOVER_2026-06-12 §C4, "Funding-rate gradient"):
 * does the funding-rate PERCENTILE predict forward returns on Blofin perps?
 *
 * Hypothesis: funding is mean-reverting on multi-hour scales — extreme
 * positive funding (crowded longs) precedes drops, extreme negative funding
 * (crowded shorts) precedes bounces. If true, funding percentile should have
 * a NEGATIVE rank correlation with forward returns, concentrated in the
 * extreme buckets.
 *
 * This is a SIGNAL-QUALITY probe, not a trade simulation: no stops, no
 * costs, no config grid. If the raw signal shows no monotone relationship
 * here, no amount of grid-sweeping will save it (the 5m/1h scoreChart arc
 * proved that lesson). BTC is the headline test per the handover; ETH runs
 * as a free robustness check.
 *
 * Method:
 * - Funding history fetched back to (cache start - LOOKBACK), so the first
 *   evaluated settlement already has a full trailing window.
 * - Percentile of each settlement's rate vs the trailing 90 settlements
 *   (30d). Signal timestamped AT settlement; entry price is the open of the
 *   first 1h bar starting at/after settlement → no look-ahead.
 * - Forward log-returns over 8h/24h/48h/72h.
 * - Spearman IC per horizon + quintile table + extreme-decile buckets.
 */

import { promises as fs } from "node:fs";
import { loadCachedSeries } from "../src/backtest/data-fetcher.js";
import { getFundingRateHistory } from "../src/clients/blofin.js";
import type { Candle } from "../src/analysis/indicators.js";

const SYMS = ["BTC-USDT", "ETH-USDT"];
const HOUR_SEC = 3600;
const LOOKBACK_SETTLEMENTS = 90; // 30d of 8h cycles
const HORIZONS_H = [8, 24, 48, 72];

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

/** Fraction of trailing window strictly below x (ties count half). */
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
  rate: number;
  pct: number; // trailing percentile, 0..1
  fwd: Record<number, number>; // horizon hours → log return
}

const report: Record<string, unknown> = {};

for (const sym of SYMS) {
  console.log(`\n================ ${sym} ================`);
  const series = await loadCachedSeries(sym);
  if (!series || series.candles.length === 0) {
    console.log("  no candle cache — skip");
    continue;
  }
  const hourly = aggregateTo1h(series.candles);
  const firstBarMs = hourly[0]!.t * 1000;
  const lastBarMs = hourly[hourly.length - 1]!.t * 1000;
  const fundingFromMs = firstBarMs - LOOKBACK_SETTLEMENTS * 8 * 3600 * 1000;

  console.log(`[1/3] fetching funding history from ${new Date(fundingFromMs).toISOString().slice(0, 10)}...`);
  const funding = await getFundingRateHistory(sym, fundingFromMs);
  if (funding.length === 0) {
    console.log("  no funding history — skip");
    continue;
  }
  const fundingNums = funding.map((f) => ({ tMs: Number(f.fundingTime), rate: Number(f.fundingRate) }));
  console.log(
    `  ${fundingNums.length} settlements, ${new Date(fundingNums[0]!.tMs).toISOString().slice(0, 10)} → ${new Date(fundingNums[fundingNums.length - 1]!.tMs).toISOString().slice(0, 10)}`,
  );

  console.log(`[2/3] computing percentiles + forward returns...`);
  // Bar index lookup: first hourly bar with t*1000 >= settleMs.
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
    if (entryIdx + maxH >= hourly.length) continue; // need full forward window
    const trailing = fundingNums.slice(i - LOOKBACK_SETTLEMENTS, i).map((x) => x.rate);
    const pct = percentile(trailing, f.rate);
    const entry = hourly[entryIdx]!.o;
    const fwd: Record<number, number> = {};
    for (const h of HORIZONS_H) {
      fwd[h] = Math.log(hourly[entryIdx + h]!.o / entry);
    }
    obs.push({ settleMs: f.tMs, rate: f.rate, pct, fwd });
  }
  console.log(`  ${obs.length} usable observations`);
  if (obs.length < 50) {
    console.log("  too few observations for inference — skip analysis");
    continue;
  }

  // Persist raw observations BEFORE display formatting.
  const tag = new Date(lastBarMs).toISOString().slice(0, 10);
  const outPath = `logs/probe-funding-${sym}-${tag}.json`;
  await fs.mkdir("logs", { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({ sym, lookback: LOOKBACK_SETTLEMENTS, horizons: HORIZONS_H, obs }, null, 2));
  console.log(`  raw observations persisted → ${outPath}`);

  console.log(`[3/3] analysis (forward returns in bps; hypothesis predicts NEGATIVE IC):`);
  const symReport: Record<string, unknown> = { n: obs.length };

  console.log(`\n  Spearman IC (funding percentile vs forward return):`);
  for (const h of HORIZONS_H) {
    const ic = spearman(obs.map((o) => o.pct), obs.map((o) => o.fwd[h]!));
    // Approximate significance: |IC| * sqrt(n-1) ~ N(0,1) under H0.
    const z = ic * Math.sqrt(obs.length - 1);
    console.log(`    h=${h.toString().padStart(2)}h  IC=${ic.toFixed(3).padStart(7)}   z≈${z.toFixed(2)}`);
    symReport[`ic_h${h}`] = ic;
  }

  console.log(`\n  Mean forward return (bps) by funding-percentile quintile:`);
  console.log(`    quintile      n     ${HORIZONS_H.map((h) => `h=${h}h`.padStart(9)).join("  ")}`);
  for (let q = 0; q < 5; q++) {
    const lo = q / 5;
    const hi = (q + 1) / 5;
    const bucket = obs.filter((o) => o.pct >= lo && (q === 4 ? o.pct <= hi : o.pct < hi));
    if (bucket.length === 0) continue;
    const cells = HORIZONS_H.map((h) => {
      const mean = (bucket.reduce((a, o) => a + o.fwd[h]!, 0) / bucket.length) * 10_000;
      return mean.toFixed(1).padStart(9);
    });
    console.log(`    Q${q + 1} [${lo.toFixed(1)}-${hi.toFixed(1)})  ${bucket.length.toString().padStart(4)} ${cells.join("  ")}`);
  }

  console.log(`\n  Extreme deciles (hypothesis: top decile → negative fwd, bottom → positive):`);
  for (const [label, filt] of [
    ["pct ≥ 0.9 (crowded longs)", (o: Obs) => o.pct >= 0.9],
    ["pct ≤ 0.1 (crowded shorts)", (o: Obs) => o.pct <= 0.1],
  ] as const) {
    const bucket = obs.filter(filt);
    if (bucket.length < 5) {
      console.log(`    ${label}: n=${bucket.length} — too few`);
      continue;
    }
    const cells = HORIZONS_H.map((h) => {
      const xs = bucket.map((o) => o.fwd[h]!);
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1));
      const t = sd > 0 ? mean / (sd / Math.sqrt(xs.length)) : 0;
      return `${(mean * 10_000).toFixed(1)}bps(t=${t.toFixed(1)})`.padStart(18);
    });
    console.log(`    ${label}  n=${bucket.length}`);
    console.log(`      ${HORIZONS_H.map((h) => `h=${h}h`.padStart(18)).join("")}`);
    console.log(`      ${cells.join("")}`);
  }
  report[sym] = symReport;
}

console.log(`\ndone.`);
