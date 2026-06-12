/**
 * C4 decisive experiment: funding-percentile signal over a FULL YEAR.
 *
 * The 90d robustness probe (probe-funding-robustness.ts) failed its pass
 * criteria, but with only ~29 non-overlapping 72h observations per symbol
 * the test was underpowered — it could neither confirm nor kill the signal.
 * Blofin serves native 1H candles and funding history 3+ years back
 * (verified 2026-06-12), so we can run the same test with ~4× the power and
 * regime diversity (a year spans multiple regimes by construction).
 *
 * Data: 365d of native 1H candles + funding history per symbol, fetched
 * directly (no 5m cache dependency).
 *
 * Pass criteria (pre-registered, decided before running):
 * - h=72 non-overlapping IC negative on ≥4/5 symbols, AND
 * - pooled per-quarter IC (all symbols' obs in that quarter) negative in
 *   ≥3/4 quarters at h=72.
 * If PASS → next step is a costed trade-simulation probe on the extreme
 * deciles. If FAIL → funding-percentile (this construction) joins the
 * scoreChart composite in the graveyard and C4 moves to the next candidate
 * (regime detection) or C5.
 */

import { promises as fs } from "node:fs";
import { getNativeCandles, getFundingRateHistory } from "../src/clients/blofin.js";
import type { Candle } from "../src/analysis/indicators.js";

const SYMS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"];
const WINDOW_DAYS = 365;
const LOOKBACK_SETTLEMENTS = 90; // 30d of 8h cycles
const HORIZONS_H = [24, 72];
const PAGE_LIMIT = 1440;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Paginate 1H candles back from `toMs` until `fromMs`, oldest-first. */
async function fetch1hCandles(instId: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = toMs;
  for (let page = 0; page < 30; page++) {
    const batch = await getNativeCandles(instId, "1H", { after: cursor, limit: PAGE_LIMIT });
    if (batch.length === 0) break;
    all.push(...batch);
    const oldestMs = batch[0]!.t * 1000;
    if (oldestMs <= fromMs) break;
    cursor = oldestMs;
    await sleep(250);
  }
  const seen = new Set<number>();
  return all
    .filter((c) => c.t * 1000 >= fromMs && c.t * 1000 < toMs)
    .filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)))
    .sort((a, b) => a.t - b.t);
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
  sym: string;
  settleMs: number;
  rate: number;
  pct: number;
  fwd: Record<number, number>;
}

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / 3_600_000) * 3_600_000 - 3_600_000; // last full hour
const FROM_MS = TO_MS - WINDOW_DAYS * 86_400_000;
const FUNDING_FROM_MS = FROM_MS - LOOKBACK_SETTLEMENTS * 8 * 3_600_000;

console.log(`window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)} (${WINDOW_DAYS}d)\n`);

const allObs: Obs[] = [];

for (const sym of SYMS) {
  console.log(`${sym}:`);
  const candles = await fetch1hCandles(sym, FROM_MS, TO_MS);
  console.log(`  ${candles.length} × 1h candles (expect ~${WINDOW_DAYS * 24})`);
  if (candles.length < WINDOW_DAYS * 24 * 0.9) {
    console.log(`  insufficient candle coverage — skip`);
    continue;
  }
  const funding = await getFundingRateHistory(sym, FUNDING_FROM_MS);
  const fundingNums = funding
    .map((f) => ({ tMs: Number(f.fundingTime), rate: Number(f.fundingRate) }))
    .filter((f) => f.tMs < TO_MS);
  console.log(`  ${fundingNums.length} funding settlements (expect ~${Math.round((TO_MS - FUNDING_FROM_MS) / (8 * 3_600_000))})`);

  const barTimesMs = candles.map((b) => b.t * 1000);
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
  let count = 0;
  for (let i = LOOKBACK_SETTLEMENTS; i < fundingNums.length; i++) {
    const f = fundingNums[i]!;
    if (f.tMs < FROM_MS) continue;
    const entryIdx = firstBarAtOrAfter(f.tMs);
    if (entryIdx + maxH >= candles.length) continue;
    // Guard against data gaps: forward bar must actually be maxH hours later.
    if (candles[entryIdx + maxH]!.t - candles[entryIdx]!.t !== maxH * 3600) continue;
    const trailing = fundingNums.slice(i - LOOKBACK_SETTLEMENTS, i).map((x) => x.rate);
    const pct = percentile(trailing, f.rate);
    const entry = candles[entryIdx]!.o;
    const fwd: Record<number, number> = {};
    for (const h of HORIZONS_H) {
      fwd[h] = Math.log(candles[entryIdx + h]!.o / entry);
    }
    allObs.push({ sym, settleMs: f.tMs, rate: f.rate, pct, fwd });
    count++;
  }
  console.log(`  ${count} usable observations`);
}

await fs.mkdir("logs", { recursive: true });
const tag = new Date(TO_MS).toISOString().slice(0, 10);
const outPath = `logs/probe-funding-1y-${tag}.json`;
await fs.writeFile(outPath, JSON.stringify({ fromMs: FROM_MS, toMs: TO_MS, lookback: LOOKBACK_SETTLEMENTS, horizons: HORIZONS_H, obs: allObs }, null, 2));
console.log(`\nraw observations persisted → ${outPath}`);

// ---- Analysis ----
const QUARTER_MS = Math.floor((TO_MS - FROM_MS) / 4);
const quarterOf = (ms: number): number => Math.min(3, Math.floor((ms - FROM_MS) / QUARTER_MS));

for (const h of HORIZONS_H) {
  console.log(`\n========== h=${h}h ==========`);
  const stride = Math.ceil(h / 8);
  console.log(`sym         n(all)  IC(full)  IC(non-ovl)  n(no)  z(no)   quarters(IC)`);
  const noNegBySym: string[] = [];
  for (const sym of SYMS) {
    const obs = allObs.filter((o) => o.sym === sym);
    if (obs.length < 100) continue;
    const icFull = spearman(obs.map((o) => o.pct), obs.map((o) => o.fwd[h]!));
    const strided = obs.filter((_, i) => i % stride === 0);
    const icNo = spearman(strided.map((o) => o.pct), strided.map((o) => o.fwd[h]!));
    const z = icNo * Math.sqrt(Math.max(0, strided.length - 1));
    if (icNo < 0) noNegBySym.push(sym);
    const qIcs = [0, 1, 2, 3].map((q) => {
      const qo = obs.filter((o) => quarterOf(o.settleMs) === q);
      return spearman(qo.map((o) => o.pct), qo.map((o) => o.fwd[h]!));
    });
    console.log(
      `${sym.padEnd(10)} ${obs.length.toString().padStart(6)}  ${icFull.toFixed(3).padStart(8)}  ${icNo.toFixed(3).padStart(9)}  ${strided.length.toString().padStart(5)}  ${z.toFixed(2).padStart(6)}   [${qIcs.map((x) => x.toFixed(2)).join(", ")}]`,
    );
  }

  const pooledQ: number[] = [];
  for (let q = 0; q < 4; q++) {
    const qo = allObs.filter((o) => quarterOf(o.settleMs) === q);
    pooledQ.push(spearman(qo.map((o) => o.pct), qo.map((o) => o.fwd[h]!)));
  }
  console.log(`pooled per-quarter IC: [${pooledQ.map((x) => x.toFixed(3)).join(", ")}]`);

  console.log(`extreme deciles, pooled, non-overlapping (stride=${stride}):`);
  for (const [label, filt] of [
    ["pct ≥ 0.9", (o: Obs) => o.pct >= 0.9],
    ["pct ≤ 0.1", (o: Obs) => o.pct <= 0.1],
  ] as const) {
    const bucket = allObs.filter((o, i) => i % stride === 0 && filt(o));
    if (bucket.length < 10) {
      console.log(`  ${label}: n=${bucket.length} — too few`);
      continue;
    }
    const xs = bucket.map((o) => o.fwd[h]!);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1));
    const t = sd > 0 ? mean / (sd / Math.sqrt(xs.length)) : 0;
    console.log(`  ${label}  n=${bucket.length}  mean=${(mean * 10_000).toFixed(1)}bps  t=${t.toFixed(2)}`);
  }

  if (h === 72) {
    const negQuarters = pooledQ.filter((x) => x < 0).length;
    const pass = noNegBySym.length >= 4 && negQuarters >= 3;
    console.log(`\nPASS CRITERIA @ h=72: non-overlap IC<0 on ${noNegBySym.length}/5 syms (need ≥4); pooled quarters negative ${negQuarters}/4 (need ≥3) → ${pass ? "PASS" : "FAIL"}`);
  }
}
