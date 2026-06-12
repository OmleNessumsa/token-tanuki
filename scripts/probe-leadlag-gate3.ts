/**
 * H2 Gate 3 (CB-012) — cost-sim with MEASURED turnover for the design-A
 * cells that passed Gate 1+2 in probe-leadlag.ts (L=1h lookback,
 * h ∈ {1,4,12} rebalance/hold).
 *
 * Portfolio per rebalance: rank alts by laggard score (−ret over the past
 * 1h), LONG the top quintile (biggest laggards), SHORT the bottom quintile
 * (biggest leaders), equal-weight, hold h hours. Costs: 14bps round-trip
 * per leg (locked PRD §9.3+9.4), charged on the FRACTION of each basket
 * actually replaced (measured, not assumed).
 *
 * Pre-registered Gate-3 criteria (roadmap): net t ≥ 2.0 AND net ≥ 5bps/day.
 * Context from Gate 1: gross spreads were 2.2/4.1/7.7 bps per 1/4/12h —
 * the prior is that costs kill this. We measure rather than assume.
 */

import { promises as fs } from "node:fs";
import { fetchBars, fetchTopUsdtPerps, meanT } from "./lib/bulk-fetch.js";

const WINDOW_DAYS = 1095;
const CANDIDATES = 45;
const MIN_HISTORY_HOURS = 180 * 24;
const MIN_XSEC = 15;
const HOUR_MS = 3_600_000;
const LOOKBACK_H = 1;
const HORIZONS_H = [1, 4, 12];
const COST_PER_LEG_RT = 0.0014;

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / HOUR_MS) * HOUR_MS - HOUR_MS;
const FROM_MS = TO_MS - WINDOW_DAYS * 24 * HOUR_MS;
console.log(`window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)}\n`);

console.log(`[1/3] universe + 1H bars...`);
const universe = await fetchTopUsdtPerps(CANDIDATES);
interface Sym {
  instId: string;
  closeByHour: Map<number, number>;
}
const syms: Sym[] = [];
for (const instId of universe) {
  const bars = await fetchBars(instId, "1H", FROM_MS, TO_MS);
  if (bars.length < MIN_HISTORY_HOURS) continue;
  const m = new Map<number, number>();
  for (const b of bars) m.set(b.t * 1000, b.c);
  syms.push({ instId, closeByHour: m });
}
const alts = syms.filter((s) => s.instId !== "BTC-USDT");
console.log(`  ${alts.length} alts`);

const ret = (s: Sym, fromMs: number, toMs: number): number | undefined => {
  const a = s.closeByHour.get(fromMs);
  const b = s.closeByHour.get(toMs);
  return a !== undefined && b !== undefined ? Math.log(b / a) : undefined;
};

console.log(`\n[2/3] simulating per horizon...`);
interface RebRow {
  tMs: number;
  gross: number;
  turnover: number; // mean replaced fraction across both legs
  net: number;
}
const results: Record<number, RebRow[]> = {};

for (const h of HORIZONS_H) {
  const rows: RebRow[] = [];
  let prevLong: Set<string> | null = null;
  let prevShort: Set<string> | null = null;
  for (let tMs = FROM_MS + LOOKBACK_H * HOUR_MS; tMs + h * HOUR_MS < TO_MS; tMs += h * HOUR_MS) {
    const entries: { id: string; score: number; fwd: number }[] = [];
    for (const s of alts) {
      const rl = ret(s, tMs - LOOKBACK_H * HOUR_MS, tMs);
      const rf = ret(s, tMs, tMs + h * HOUR_MS);
      if (rl === undefined || rf === undefined) continue;
      entries.push({ id: s.instId, score: -rl, fwd: rf });
    }
    if (entries.length < MIN_XSEC) {
      prevLong = prevShort = null;
      continue;
    }
    entries.sort((a, b) => b.score - a.score);
    const q = Math.floor(entries.length / 5);
    const longB = entries.slice(0, q);
    const shortB = entries.slice(-q);
    const gross =
      longB.reduce((a, e) => a + e.fwd, 0) / q - shortB.reduce((a, e) => a + e.fwd, 0) / q;
    const longSet = new Set(longB.map((e) => e.id));
    const shortSet = new Set(shortB.map((e) => e.id));
    let turnover = 1;
    if (prevLong && prevShort) {
      const keptL = [...longSet].filter((x) => prevLong!.has(x)).length / q;
      const keptS = [...shortSet].filter((x) => prevShort!.has(x)).length / q;
      turnover = 1 - (keptL + keptS) / 2;
    }
    const net = gross - 2 * turnover * COST_PER_LEG_RT;
    rows.push({ tMs, gross, turnover, net });
    prevLong = longSet;
    prevShort = shortSet;
  }
  results[h] = rows;
  console.log(`  h=${h}h: ${rows.length} rebalances`);
}

const tag = new Date(TO_MS).toISOString().slice(0, 10);
const outPath = `logs/probe-leadlag-gate3-${tag}.json`;
await fs.mkdir("logs", { recursive: true });
await fs.writeFile(outPath, JSON.stringify({ fromMs: FROM_MS, toMs: TO_MS, lookbackH: LOOKBACK_H, results }, null, 2));
console.log(`  raw rows persisted → ${outPath}`);

console.log(`\n[3/3] Gate-3 verdicts (net t ≥ 2.0 AND net ≥ 5bps/day):`);
let anyPass = false;
for (const h of HORIZONS_H) {
  const rows = results[h]!;
  const g = meanT(rows.map((r) => r.gross));
  const n = meanT(rows.map((r) => r.net));
  const to = rows.reduce((a, r) => a + r.turnover, 0) / rows.length;
  const netPerDay = n.mean * (24 / h) * 10_000;
  const pass = n.t >= 2.0 && netPerDay >= 5;
  anyPass ||= pass;
  console.log(
    `  h=${h.toString().padStart(2)}h  gross=${(g.mean * 10_000).toFixed(1).padStart(6)}bps (t=${g.t.toFixed(1)})  turnover=${(to * 100).toFixed(0)}%  net=${(n.mean * 10_000).toFixed(1).padStart(6)}bps/reb (t=${n.t.toFixed(2)})  net/day=${netPerDay.toFixed(1).padStart(7)}bps  → ${pass ? "PASS" : "fail"}`,
  );
}
console.log(`\nGATE 3 VERDICT: ${anyPass ? "PASS — proceed to Gate 4 (walk-forward cert)" : "FAIL — signal real but sub-cost; H2 dead, next hypothesis (H3)"}`);
