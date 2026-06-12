/**
 * H5a (CB-015) — liquidation-cascade PROXY probe on cached 1H bars.
 * Funnel Gate 1+2. Roadmap: docs/STRATEGY_ROADMAP_2026-06-12.md.
 *
 * Gate 0 (mechanism, strongest of the backlog): liquidations are FORCED,
 * non-informative flow with a named counterparty (the liquidated trader).
 * The overshoot they cause should revert once the cascade exhausts.
 * Unlike H1-H4 this is not short-tail: it buys AFTER the crash.
 *
 * Proxy (no external data needed): a cascade leaves a fingerprint in price
 * + volume we already have —
 *   CRASH event: 1h return z-score ≤ -3 (vs trailing 30d hourly vol) AND
 *                volume ≥ 3× trailing 30d median hourly volume.
 *   PUMP event:  z ≥ +3 AND the same volume condition (short-liquidation
 *                cascade; expected to fade).
 * If real liquidation data would show an effect, this proxy should show
 * it too (cascades ARE extreme moves on extreme volume). H5b (external
 * OI/liquidation data, pricing live-verified first) only happens if this
 * proxy gives a signal worth sharpening.
 *
 * Entry at the close of the event bar. Forward horizons: 4h, 12h, 48h.
 * Expected: crash → POSITIVE forward (bounce), pump → NEGATIVE (fade).
 *
 * Honest aggregation:
 * - Market-wide cascades hit many symbols in the same hour → same-hour
 *   events are CLUSTERED into one observation (mean forward return across
 *   involved symbols). No cross-symbol double counting.
 * - Per horizon, clustered events are greedily spaced ≥ h hours apart →
 *   no overlapping forward windows.
 *
 * Pre-registered PASS per cell (2 sides × 3 horizons = 6 tests):
 *   expected-direction t ≥ 2.5, AND expected sign in ≥2/3 window-thirds,
 *   AND |mean| ≥ 30bps per event (stressed-cost floor: cascade-time
 *   slippage is a multiple of the normal 0.01%; 30bps ≈ 2× a stressed
 *   round-trip). Any pass → Gate 3 with a stressed cost model + H5b
 *   sharpening. None → H5 dead → C5 (pre-committed).
 */

import { promises as fs } from "node:fs";
import { fetchBars, fetchTopUsdtPerps, meanT } from "./lib/bulk-fetch.js";
import type { Candle } from "../src/analysis/indicators.js";

const WINDOW_DAYS = 1095;
const CANDIDATES = 45;
const MIN_HISTORY_HOURS = 180 * 24;
const HOUR_MS = 3_600_000;
const TRAIL_H = 720; // 30d of hourly bars
const Z_THRESHOLD = 3;
const VOL_MULT = 3;
const HORIZONS_H = [4, 12, 48];

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / HOUR_MS) * HOUR_MS - HOUR_MS;
const FROM_MS = TO_MS - WINDOW_DAYS * 24 * HOUR_MS;
console.log(`window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)}\n`);

console.log(`[1/3] universe + 1H bars (cache-hot)...`);
const universe = await fetchTopUsdtPerps(CANDIDATES);
interface Sym {
  instId: string;
  bars: Candle[];
}
const syms: Sym[] = [];
for (const instId of universe) {
  const bars = await fetchBars(instId, "1H", FROM_MS, TO_MS);
  if (bars.length < MIN_HISTORY_HOURS) continue;
  syms.push({ instId, bars });
}
console.log(`  ${syms.length} symbols`);

console.log(`\n[2/3] detecting cascade events...`);
interface Event {
  tMs: number;
  sym: string;
  z: number;
  volRatio: number;
  fwd: Record<number, number>;
}
const events: Event[] = [];
const maxH = Math.max(...HORIZONS_H);

for (const { instId, bars } of syms) {
  // Rolling sums for hourly-return mean/sd over TRAIL_H bars.
  const rets: number[] = [0];
  for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i]!.c / bars[i - 1]!.c));
  let s = 0;
  let s2 = 0;
  for (let i = 1; i < bars.length; i++) {
    s += rets[i]!;
    s2 += rets[i]! ** 2;
    if (i > TRAIL_H) {
      s -= rets[i - TRAIL_H]!;
      s2 -= rets[i - TRAIL_H]! ** 2;
    }
    if (i <= TRAIL_H || i + maxH >= bars.length) continue;
    const n = TRAIL_H;
    const mean = s / n;
    const sd = Math.sqrt(Math.max(0, s2 / n - mean ** 2));
    if (sd === 0) continue;
    const z = (rets[i]! - mean) / sd;
    if (Math.abs(z) < Z_THRESHOLD) continue;
    // Volume condition: current bar volume vs trailing median (computed
    // lazily — only at z-candidates, ~1% of bars).
    const volWin: number[] = [];
    for (let k = i - TRAIL_H; k < i; k++) volWin.push(bars[k]!.v);
    volWin.sort((a, b) => a - b);
    const medVol = volWin[Math.floor(volWin.length / 2)]!;
    if (medVol <= 0 || bars[i]!.v < VOL_MULT * medVol) continue;
    // Contiguity guard for forward windows.
    if (bars[i + maxH]!.t - bars[i]!.t !== maxH * 3600) continue;
    const fwd: Record<number, number> = {};
    for (const h of HORIZONS_H) fwd[h] = Math.log(bars[i + h]!.c / bars[i]!.c);
    events.push({ tMs: bars[i]!.t * 1000, sym: instId, z, volRatio: bars[i]!.v / medVol, fwd });
  }
}
console.log(`  ${events.length} raw symbol-events (${events.filter((e) => e.z < 0).length} crash, ${events.filter((e) => e.z > 0).length} pump)`);

// Cluster same-hour events per side.
interface Cluster {
  tMs: number;
  nSyms: number;
  fwd: Record<number, number>;
}
function clusterSide(side: "crash" | "pump"): Cluster[] {
  const byHour = new Map<number, Event[]>();
  for (const e of events) {
    if ((side === "crash") !== e.z < 0) continue;
    const list = byHour.get(e.tMs) ?? [];
    list.push(e);
    byHour.set(e.tMs, list);
  }
  return [...byHour.entries()]
    .map(([tMs, es]) => {
      const fwd: Record<number, number> = {};
      for (const h of HORIZONS_H) fwd[h] = es.reduce((a, e) => a + e.fwd[h]!, 0) / es.length;
      return { tMs, nSyms: es.length, fwd };
    })
    .sort((a, b) => a.tMs - b.tMs);
}
const crashes = clusterSide("crash");
const pumps = clusterSide("pump");
console.log(`  clustered: ${crashes.length} crash-hours, ${pumps.length} pump-hours`);

const tag = new Date(TO_MS).toISOString().slice(0, 10);
const outPath = `logs/probe-cascade-${tag}.json`;
await fs.mkdir("logs", { recursive: true });
await fs.writeFile(outPath, JSON.stringify({ fromMs: FROM_MS, toMs: TO_MS, zThreshold: Z_THRESHOLD, volMult: VOL_MULT, events, crashes, pumps }, null, 2));
console.log(`  raw events persisted → ${outPath}`);

console.log(`\n[3/3] aggregation vs pre-registered gates (t≥2.5, ≥2/3 thirds, |mean|≥30bps):`);
const THIRD = Math.floor((TO_MS - FROM_MS) / 3);
const thirdOf = (ms: number): number => Math.min(2, Math.floor((ms - FROM_MS) / THIRD));
let anyPass = false;

for (const [side, clusters, expSign] of [
  ["CRASH→bounce", crashes, 1],
  ["PUMP→fade", pumps, -1],
] as const) {
  for (const h of HORIZONS_H) {
    // Greedy non-overlap: accept clusters ≥ h hours after the last accepted.
    const picked: Cluster[] = [];
    let lastMs = -Infinity;
    for (const c of clusters) {
      if (c.tMs - lastMs >= h * HOUR_MS) {
        picked.push(c);
        lastMs = c.tMs;
      }
    }
    if (picked.length < 30) {
      console.log(`  ${side.padEnd(13)} h=${h.toString().padStart(2)}h  n=${picked.length} — too few events`);
      continue;
    }
    const vals = picked.map((c) => c.fwd[h]!);
    const { mean, t, n } = meanT(vals);
    const dirT = t * expSign;
    const thirds = [0, 1, 2]
      .map((k) => {
        const xs = picked.filter((c) => thirdOf(c.tMs) === k).map((c) => c.fwd[h]!);
        return xs.length ? Math.sign(xs.reduce((a, b) => a + b, 0) / xs.length) * expSign : 0;
      })
      .filter((sgn) => sgn > 0).length;
    const floor = Math.abs(mean) >= 0.003 && Math.sign(mean) === expSign;
    const pass = dirT >= 2.5 && thirds >= 2 && floor;
    anyPass ||= pass;
    console.log(
      `  ${side.padEnd(13)} h=${h.toString().padStart(2)}h  mean=${(mean * 10_000).toFixed(1).padStart(7)}bps  t(dir)=${dirT.toFixed(2).padStart(6)}  n=${n}  thirds ${thirds}/3  → ${pass ? "PASS" : "fail"}`,
    );
  }
}

console.log(`\nGATE 1+2 VERDICT: ${anyPass ? "PASS — Gate 3 (stressed costs) + H5b sharpening" : "FAIL — H5 proxy dead → C5 (pre-committed)"}`);
