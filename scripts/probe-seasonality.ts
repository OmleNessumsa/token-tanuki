/**
 * H4 (CB-014) — seasonality / flow-windows on 1H bars.
 * Funnel Gate 1+2. Roadmap: docs/STRATEGY_ROADMAP_2026-06-12.md.
 *
 * Gate 0 (mechanism, passed with a LOW prior): mechanical flow concentrates
 * at predictable times — funding settlements (00/08/16 UTC), US equity
 * open (13:30 UTC), weekend liquidity drought. No specific counterparty is
 * exploited; it's flow timing, so the multiple-testing burden is severe and
 * the bar is set accordingly.
 *
 * Construction: equal-weight index of the universe (one observation per
 * timestamp — cross-symbol correlation can't inflate t-stats).
 * 31 pre-registered buckets:
 *   - 24 × hour-of-day (UTC), hourly index log returns
 *   - 7 × day-of-week, daily index log returns (UTC days)
 *
 * Pre-registered PASS per bucket (Bonferroni for 31 two-sided tests):
 *   |t| ≥ 3.5, AND same sign in 3/3 window-thirds, AND economic floor
 *   |mean| ≥ 2bps for hourly buckets / ≥ 20bps for daily buckets (anything
 *   smaller can never clear the 14bps round-trip even when chained into
 *   windows). Any pass → Gate 3 (contiguous-window cost-sim). None → H4
 *   dead → Fase-2 beslismoment (roadmap).
 */

import { promises as fs } from "node:fs";
import { fetchBars, fetchTopUsdtPerps, meanT } from "./lib/bulk-fetch.js";

const WINDOW_DAYS = 1095;
const CANDIDATES = 45;
const MIN_HISTORY_HOURS = 180 * 24;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / HOUR_MS) * HOUR_MS - HOUR_MS;
const FROM_MS = TO_MS - WINDOW_DAYS * 24 * HOUR_MS;
console.log(`window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)}\n`);

console.log(`[1/3] universe + 1H bars...`);
const universe = await fetchTopUsdtPerps(CANDIDATES);
const closeMaps: Map<number, number>[] = [];
for (const instId of universe) {
  const bars = await fetchBars(instId, "1H", FROM_MS, TO_MS);
  if (bars.length < MIN_HISTORY_HOURS) continue;
  const m = new Map<number, number>();
  for (const b of bars) m.set(b.t * 1000, b.c);
  closeMaps.push(m);
}
console.log(`  ${closeMaps.length} symbols`);

console.log(`\n[2/3] equal-weight index returns...`);
// Hourly index log return at t = mean of per-symbol log returns over [t-1h, t].
const hourly: { tMs: number; r: number }[] = [];
for (let tMs = FROM_MS + HOUR_MS; tMs < TO_MS; tMs += HOUR_MS) {
  let sum = 0;
  let n = 0;
  for (const m of closeMaps) {
    const a = m.get(tMs - HOUR_MS);
    const b = m.get(tMs);
    if (a === undefined || b === undefined) continue;
    sum += Math.log(b / a);
    n++;
  }
  if (n >= 15) hourly.push({ tMs, r: sum / n });
}
console.log(`  ${hourly.length} hourly index returns`);

// Daily index returns by UTC day.
const dailyByDay = new Map<number, number>();
for (const { tMs, r } of hourly) {
  const day = Math.floor((tMs - 1) / DAY_MS) * DAY_MS; // hour t belongs to the day containing (t-1h, t]
  dailyByDay.set(day, (dailyByDay.get(day) ?? 0) + r);
}
const daily = [...dailyByDay.entries()].map(([dayMs, r]) => ({ dayMs, r })).sort((a, b) => a.dayMs - b.dayMs);
console.log(`  ${daily.length} daily index returns`);

const tag = new Date(TO_MS).toISOString().slice(0, 10);
const outPath = `logs/probe-seasonality-${tag}.json`;
await fs.mkdir("logs", { recursive: true });
await fs.writeFile(outPath, JSON.stringify({ fromMs: FROM_MS, toMs: TO_MS, nSyms: closeMaps.length, hourly, daily }, null, 2));
console.log(`  raw series persisted → ${outPath}`);

console.log(`\n[3/3] buckets vs pre-registered gates (|t|≥3.5, 3/3 thirds, economic floor):`);
const THIRD = Math.floor((TO_MS - FROM_MS) / 3);
const thirdOf = (ms: number): number => Math.min(2, Math.floor((ms - FROM_MS) / THIRD));
let anyPass = false;

console.log(`\n  hour-of-day (UTC), hourly index returns, floor |mean| ≥ 2bps:`);
for (let hod = 0; hod < 24; hod++) {
  const xs = hourly.filter((x) => new Date(x.tMs - 1).getUTCHours() === hod);
  const { mean, t, n } = meanT(xs.map((x) => x.r));
  const thirds = [0, 1, 2]
    .map((k) => {
      const v = xs.filter((x) => thirdOf(x.tMs) === k).map((x) => x.r);
      return v.length ? Math.sign(v.reduce((a, b) => a + b, 0)) === Math.sign(mean) : false;
    })
    .filter(Boolean).length;
  const pass = Math.abs(t) >= 3.5 && thirds === 3 && Math.abs(mean) >= 0.0002;
  anyPass ||= pass;
  const flag = Math.abs(t) >= 2 ? (pass ? " → PASS" : "  (*)") : "";
  console.log(`    ${hod.toString().padStart(2)}:00  mean=${(mean * 10_000).toFixed(2).padStart(6)}bps  t=${t.toFixed(2).padStart(6)}  n=${n}  thirds ${thirds}/3${flag}`);
}

console.log(`\n  day-of-week (UTC), daily index returns, floor |mean| ≥ 20bps:`);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
for (let dow = 0; dow < 7; dow++) {
  const xs = daily.filter((x) => new Date(x.dayMs).getUTCDay() === dow);
  const { mean, t, n } = meanT(xs.map((x) => x.r));
  const thirds = [0, 1, 2]
    .map((k) => {
      const v = xs.filter((x) => thirdOf(x.dayMs) === k).map((x) => x.r);
      return v.length ? Math.sign(v.reduce((a, b) => a + b, 0)) === Math.sign(mean) : false;
    })
    .filter(Boolean).length;
  const pass = Math.abs(t) >= 3.5 && thirds === 3 && Math.abs(mean) >= 0.002;
  anyPass ||= pass;
  const flag = Math.abs(t) >= 2 ? (pass ? " → PASS" : "  (*)") : "";
  console.log(`    ${DOW[dow]}  mean=${(mean * 10_000).toFixed(1).padStart(7)}bps  t=${t.toFixed(2).padStart(6)}  n=${n}  thirds ${thirds}/3${flag}`);
}

console.log(`\n  (*) = |t|≥2 but below the pre-registered bar — listed for transparency, NOT a pass.`);
console.log(`\nGATE 1+2 VERDICT: ${anyPass ? "PASS — proceed to Gate 3 (window cost-sim)" : "FAIL — H4 dead → Fase-2 beslismoment (roadmap §fasering)"}`);
