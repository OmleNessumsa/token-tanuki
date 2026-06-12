/**
 * H1 (CB-011) — cross-sectional momentum/reversal on daily bars.
 * Funnel Gate 1 (IC probe) + Gate 2 (stability) in one run.
 * Roadmap: docs/STRATEGY_ROADMAP_2026-06-12.md.
 *
 * Gate 0 (mechanism, passed): ~1-week reversal = retail overreaction
 * (counterparty: panic-sellers/FOMO-chasers); multi-week momentum = slow
 * capital / narrative diffusion (counterparty: late adopters). Documented
 * factor family in crypto academic lit; persists due to capacity and
 * short-borrow constraints.
 *
 * Four signal variants, each with its expected IC sign declared a priori
 * (signal value vs forward return, cross-sectional Spearman per day):
 *   REV5      r(t-5..t)        expected NEGATIVE (reversal)
 *   REV10     r(t-10..t)       expected NEGATIVE (reversal)
 *   MOM21     r(t-21..t)       expected POSITIVE (momentum)
 *   MOM21X5   r(t-21..t-5)     expected POSITIVE (momentum ex recent week)
 * Forward horizons: 5d and 10d. 8 tests total.
 *
 * Pre-registered PASS criteria (per variant × horizon, decided before run):
 *   1. mean daily cross-sectional IC, non-overlapping days (stride = h),
 *      expected direction, |t| ≥ 2.5 (threshold raised from 2.0 for the
 *      8-way multiple-testing burden), AND
 *   2. expected sign in ≥2/3 window-thirds (~year each), AND
 *   3. expected sign in BOTH window-halves.
 * Any variant passing all three → Gate 3 (cost-sim with measured turnover).
 * None passing → H1 dead, next hypothesis (H2).
 */

import { promises as fs } from "node:fs";
import { fetchBars, fetchTopUsdtPerps, meanT, spearman } from "./lib/bulk-fetch.js";

const WINDOW_DAYS = 1095;
const CANDIDATES = 45;
const MIN_HISTORY_DAYS = 180;
const MIN_XSEC = 15;
const DAY_MS = 86_400_000;
const HORIZONS_D = [5, 10];

interface Variant {
  key: string;
  lookbackFrom: number; // days back for the start of the return window
  lookbackTo: number;   // days back for the end (0 = today)
  expectedSign: 1 | -1;
}
const VARIANTS: Variant[] = [
  { key: "REV5", lookbackFrom: 5, lookbackTo: 0, expectedSign: -1 },
  { key: "REV10", lookbackFrom: 10, lookbackTo: 0, expectedSign: -1 },
  { key: "MOM21", lookbackFrom: 21, lookbackTo: 0, expectedSign: 1 },
  { key: "MOM21X5", lookbackFrom: 21, lookbackTo: 5, expectedSign: 1 },
];

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / DAY_MS) * DAY_MS; // last full UTC day boundary
const FROM_MS = TO_MS - WINDOW_DAYS * DAY_MS;
console.log(`window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)} (${WINDOW_DAYS}d)\n`);

console.log(`[1/3] universe + daily bars...`);
const universe = await fetchTopUsdtPerps(CANDIDATES);
interface Sym {
  instId: string;
  /** day timestamp (unix ms at bar open) → close */
  closeByDay: Map<number, number>;
}
const syms: Sym[] = [];
for (const instId of universe) {
  const bars = await fetchBars(instId, "1D", FROM_MS, TO_MS);
  if (bars.length < MIN_HISTORY_DAYS) {
    console.log(`  ${instId}: ${bars.length}d — drop (<${MIN_HISTORY_DAYS}d)`);
    continue;
  }
  const closeByDay = new Map<number, number>();
  for (const b of bars) closeByDay.set(b.t * 1000, b.c);
  syms.push({ instId, closeByDay });
  console.log(`  ${instId}: ${bars.length}d ✓`);
}
console.log(`  ${syms.length} symbols in play`);

console.log(`\n[2/3] daily cross-sectional ICs...`);
interface DayIc {
  dayMs: number;
  // variant key → horizon → { ic, n, q1mq5 } (q1mq5 = bottom-minus-top
  // signal-quintile mean forward return, for economic size)
  ics: Record<string, Record<number, { ic: number; n: number; q1mq5: number }>>;
}
const dayRows: DayIc[] = [];
const maxLookback = Math.max(...VARIANTS.map((v) => v.lookbackFrom));
const maxH = Math.max(...HORIZONS_D);

for (let dayMs = FROM_MS + maxLookback * DAY_MS; dayMs + maxH * DAY_MS < TO_MS; dayMs += DAY_MS) {
  const row: DayIc = { dayMs, ics: {} };
  let any = false;
  for (const v of VARIANTS) {
    for (const h of HORIZONS_D) {
      const sig: number[] = [];
      const fwd: number[] = [];
      for (const s of syms) {
        const c0 = s.closeByDay.get(dayMs);
        const cFrom = s.closeByDay.get(dayMs - v.lookbackFrom * DAY_MS);
        const cTo = s.closeByDay.get(dayMs - v.lookbackTo * DAY_MS);
        const cF = s.closeByDay.get(dayMs + h * DAY_MS);
        if (c0 === undefined || cFrom === undefined || cTo === undefined || cF === undefined) continue;
        sig.push(Math.log(cTo / cFrom));
        fwd.push(Math.log(cF / c0));
      }
      if (sig.length < MIN_XSEC) continue;
      const ic = spearman(sig, fwd);
      // Quintile spread: mean fwd of lowest-signal quintile minus highest.
      const order = sig.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
      const q = Math.floor(sig.length / 5);
      const lo = order.slice(0, q).reduce((a, [, i]) => a + fwd[i]!, 0) / q;
      const hi = order.slice(-q).reduce((a, [, i]) => a + fwd[i]!, 0) / q;
      row.ics[v.key] ??= {};
      row.ics[v.key]![h] = { ic, n: sig.length, q1mq5: lo - hi };
      any = true;
    }
  }
  if (any) dayRows.push(row);
}
console.log(`  ${dayRows.length} cross-section days`);

const tag = new Date(TO_MS).toISOString().slice(0, 10);
const outPath = `logs/probe-xsec-momentum-${tag}.json`;
await fs.mkdir("logs", { recursive: true });
await fs.writeFile(outPath, JSON.stringify({ fromMs: FROM_MS, toMs: TO_MS, universe: syms.map((s) => s.instId), dayRows }, null, 2));
console.log(`  raw rows persisted → ${outPath}`);

console.log(`\n[3/3] aggregation against pre-registered gates:`);
const THIRD = Math.floor((TO_MS - FROM_MS) / 3);
const HALF = Math.floor((TO_MS - FROM_MS) / 2);
let anyPass = false;

for (const v of VARIANTS) {
  for (const h of HORIZONS_D) {
    const days = dayRows.filter((r) => r.ics[v.key]?.[h] !== undefined);
    const strided = days.filter((_, i) => i % h === 0);
    const ics = strided.map((r) => r.ics[v.key]![h]!.ic);
    if (ics.length < 30) continue;
    const { mean, t, n } = meanT(ics);
    const dirT = t * v.expectedSign;
    const dirMean = mean * v.expectedSign;

    const thirdSigns = [0, 1, 2].map((k) => {
      const xs = strided
        .filter((r) => Math.min(2, Math.floor((r.dayMs - FROM_MS) / THIRD)) === k)
        .map((r) => r.ics[v.key]![h]!.ic);
      return xs.length ? Math.sign(xs.reduce((a, b) => a + b, 0) / xs.length) * v.expectedSign : 0;
    });
    const okThirds = thirdSigns.filter((s) => s > 0).length;
    const halfSigns = [0, 1].map((k) => {
      const xs = strided
        .filter((r) => Math.min(1, Math.floor((r.dayMs - FROM_MS) / HALF)) === k)
        .map((r) => r.ics[v.key]![h]!.ic);
      return xs.length ? Math.sign(xs.reduce((a, b) => a + b, 0) / xs.length) * v.expectedSign : 0;
    });
    const okHalves = halfSigns.filter((s) => s > 0).length;

    // q1mq5 = low-signal-minus-high-signal forward return. For a reversal
    // variant (expectedSign -1) that IS the hypothesis portfolio; for a
    // momentum variant it's the mirror. positive = hypothesis-consistent.
    const spread = meanT(strided.map((r) => -v.expectedSign * r.ics[v.key]![h]!.q1mq5));

    const pass = dirT >= 2.5 && okThirds >= 2 && okHalves === 2;
    anyPass ||= pass;
    console.log(
      `  ${v.key.padEnd(8)} h=${h.toString().padStart(2)}d  IC=${mean.toFixed(3).padStart(7)} (dir ${dirMean >= 0 ? "+" : "-"})  t(dir)=${dirT.toFixed(2).padStart(6)}  n=${n.toString().padStart(3)}  thirds ${okThirds}/3  halves ${okHalves}/2  L/S=${(spread.mean * 10_000).toFixed(0).padStart(5)}bps/${h}d  → ${pass ? "PASS" : "fail"}`,
    );
  }
}

console.log(`\nGATE 1+2 VERDICT: ${anyPass ? "PASS — proceed to Gate 3 (cost-sim, measured turnover)" : "FAIL — H1 dead, next hypothesis (H2 lead-lag)"}`);
