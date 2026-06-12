/**
 * H3 (CB-013) — low-vol anomaly, cross-sectional on daily bars.
 * Funnel Gate 1+2. Roadmap: docs/STRATEGY_ROADMAP_2026-06-12.md.
 *
 * Gate 0 (mechanism, passed with a modest prior): lottery preference —
 * retail overpays high-vol "moonshot" coins; counterparty: gamblers buying
 * convexity. Documented in equities; crypto evidence mixed, and the raw
 * low-minus-high-vol portfolio is short-beta in a trending market — which
 * is exactly what the raw-return cells measure honestly.
 *
 * Signal: trailing 30d realized vol (sd of daily log returns), ranked
 * cross-sectionally each day. Four pre-registered cells:
 *   RAW   IC(vol rank, fwd raw return)            expected NEGATIVE, h ∈ {5,10}
 *   RADJ  IC(vol rank, fwd return / trailing vol) expected NEGATIVE, h ∈ {5,10}
 *
 * Pre-registered PASS per cell (4-test burden): expected-direction t ≥ 2.5
 * on non-overlapping days, expected sign in ≥2/3 thirds AND both halves.
 * Any pass → Gate 3. None → H3 dead, next hypothesis (H4 seasonality).
 */

import { promises as fs } from "node:fs";
import { fetchBars, fetchTopUsdtPerps, meanT, spearman } from "./lib/bulk-fetch.js";

const WINDOW_DAYS = 1095;
const CANDIDATES = 45;
const MIN_HISTORY_DAYS = 180;
const MIN_XSEC = 15;
const DAY_MS = 86_400_000;
const VOL_LOOKBACK_D = 30;
const HORIZONS_D = [5, 10];

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / DAY_MS) * DAY_MS;
const FROM_MS = TO_MS - WINDOW_DAYS * DAY_MS;
console.log(`window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)}\n`);

console.log(`[1/3] universe + daily bars...`);
const universe = await fetchTopUsdtPerps(CANDIDATES);
interface Sym {
  instId: string;
  closeByDay: Map<number, number>;
}
const syms: Sym[] = [];
for (const instId of universe) {
  const bars = await fetchBars(instId, "1D", FROM_MS, TO_MS);
  if (bars.length < MIN_HISTORY_DAYS) continue;
  const m = new Map<number, number>();
  for (const b of bars) m.set(b.t * 1000, b.c);
  syms.push({ instId, closeByDay: m });
}
console.log(`  ${syms.length} symbols`);

/** Trailing 30d realized vol at day t (sd of daily log returns); undefined on gaps. */
function trailingVol(s: Sym, dayMs: number): number | undefined {
  const rets: number[] = [];
  for (let k = 0; k < VOL_LOOKBACK_D; k++) {
    const a = s.closeByDay.get(dayMs - (k + 1) * DAY_MS);
    const b = s.closeByDay.get(dayMs - k * DAY_MS);
    if (a === undefined || b === undefined) return undefined;
    rets.push(Math.log(b / a));
  }
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  return Math.sqrt(rets.reduce((x, r) => x + (r - mean) ** 2, 0) / (rets.length - 1));
}

console.log(`\n[2/3] daily cross-sectional ICs...`);
interface DayRow {
  dayMs: number;
  cells: Record<string, { ic: number; n: number; q1mq5: number }>;
}
const rows: DayRow[] = [];
const maxH = Math.max(...HORIZONS_D);

for (let dayMs = FROM_MS + (VOL_LOOKBACK_D + 1) * DAY_MS; dayMs + maxH * DAY_MS < TO_MS; dayMs += DAY_MS) {
  const base: { s: Sym; vol: number }[] = [];
  for (const s of syms) {
    const v = trailingVol(s, dayMs);
    if (v !== undefined && v > 0) base.push({ s, vol: v });
  }
  if (base.length < MIN_XSEC) continue;
  const row: DayRow = { dayMs, cells: {} };
  let any = false;
  for (const h of HORIZONS_D) {
    const vol: number[] = [];
    const raw: number[] = [];
    const radj: number[] = [];
    for (const { s, vol: v } of base) {
      const c0 = s.closeByDay.get(dayMs);
      const cF = s.closeByDay.get(dayMs + h * DAY_MS);
      if (c0 === undefined || cF === undefined) continue;
      const r = Math.log(cF / c0);
      vol.push(v);
      raw.push(r);
      radj.push(r / v);
    }
    if (vol.length < MIN_XSEC) continue;
    for (const [key, tgt] of [["RAW", raw], ["RADJ", radj]] as const) {
      const ic = spearman(vol, tgt);
      const order = vol.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
      const q = Math.floor(vol.length / 5);
      const lo = order.slice(0, q).reduce((a, [, i]) => a + tgt[i]!, 0) / q;
      const hi = order.slice(-q).reduce((a, [, i]) => a + tgt[i]!, 0) / q;
      row.cells[`${key}h${h}`] = { ic, n: vol.length, q1mq5: lo - hi }; // low-vol minus high-vol = hypothesis portfolio
      any = true;
    }
  }
  if (any) rows.push(row);
}
console.log(`  ${rows.length} cross-section days`);

const tag = new Date(TO_MS).toISOString().slice(0, 10);
const outPath = `logs/probe-lowvol-${tag}.json`;
await fs.mkdir("logs", { recursive: true });
await fs.writeFile(outPath, JSON.stringify({ fromMs: FROM_MS, toMs: TO_MS, universe: syms.map((s) => s.instId), rows }, null, 2));
console.log(`  raw rows persisted → ${outPath}`);

console.log(`\n[3/3] aggregation against pre-registered gates (expected IC sign: NEGATIVE):`);
const THIRD = Math.floor((TO_MS - FROM_MS) / 3);
const HALF = Math.floor((TO_MS - FROM_MS) / 2);
let anyPass = false;
for (const key of ["RAW", "RADJ"]) {
  for (const h of HORIZONS_D) {
    const cellKey = `${key}h${h}`;
    const days = rows.filter((r) => r.cells[cellKey] !== undefined);
    const strided = days.filter((_, i) => i % h === 0);
    if (strided.length < 30) continue;
    const ics = strided.map((r) => r.cells[cellKey]!.ic);
    const { mean, t, n } = meanT(ics);
    const dirT = -t; // expected negative
    const thirds = [0, 1, 2]
      .map((k) => {
        const xs = strided
          .filter((r) => Math.min(2, Math.floor((r.dayMs - FROM_MS) / THIRD)) === k)
          .map((r) => r.cells[cellKey]!.ic);
        return xs.length ? -Math.sign(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
      })
      .filter((s) => s > 0).length;
    const halves = [0, 1]
      .map((k) => {
        const xs = strided
          .filter((r) => Math.min(1, Math.floor((r.dayMs - FROM_MS) / HALF)) === k)
          .map((r) => r.cells[cellKey]!.ic);
        return xs.length ? -Math.sign(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
      })
      .filter((s) => s > 0).length;
    const spread = meanT(strided.map((r) => r.cells[cellKey]!.q1mq5));
    const pass = dirT >= 2.5 && thirds >= 2 && halves === 2;
    anyPass ||= pass;
    const unit = key === "RAW" ? `bps/${h}d` : `volU/${h}d`;
    const spreadStr = key === "RAW" ? (spread.mean * 10_000).toFixed(0) : spread.mean.toFixed(2);
    console.log(
      `  ${key.padEnd(5)} h=${h.toString().padStart(2)}d  IC=${mean.toFixed(3).padStart(7)}  t(dir)=${dirT.toFixed(2).padStart(6)}  n=${n.toString().padStart(3)}  thirds ${thirds}/3  halves ${halves}/2  L/S=${spreadStr.padStart(6)}${unit}  → ${pass ? "PASS" : "fail"}`,
    );
  }
}
console.log(`\nGATE 1+2 VERDICT: ${anyPass ? "PASS — proceed to Gate 3" : "FAIL — H3 dead, next hypothesis (H4 seasonality)"}`);
