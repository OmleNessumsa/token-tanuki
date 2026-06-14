/**
 * P0.1b — the question P0.1 raised. Trend-TIMING added nothing (it's
 * repackaged beta), but the book IS crypto beta and beta is the one thing
 * that demonstrably pays here. So: can RISK-MANAGED beta (vol-targeting +
 * drawdown/regime control) beat naive buy-and-hold BTC on a risk-adjusted
 * basis? This is a risk-management question, NOT an alpha question — a
 * different thing than anything in the 9-hypothesis graveyard.
 *
 * If yes → a "working cryptotrader" exists honestly: a disciplined beta
 * harvester that captures the trend/right-skew with controlled drawdown.
 * If no → even risk management adds nothing over holding, and the honest
 * answer is "just hold/DCA, no bot needed" (a form of C5).
 *
 * Cells (pre-registered, decided before running), long-only, de-risk only
 * (weight capped at 1.0 — never levered):
 *   0. BTC buy-and-hold                         (benchmark)
 *   1. BTC vol-targeted (target 40% ann)
 *   2. BTC vol-targeted + 100d-MA regime filter (flat below MA)
 *   3. Basket{BTC,ETH,SOL,BNB} inverse-vol + portfolio vol-target + MA filter
 *
 * Weight changes are slow → low turnover; cost charged on |Δw| at
 * 14bps/leg round-trip.
 *
 * Pre-registered PASS gate (per managed cell):
 *   Sharpe >= 1.0 AND maxDD < 35% AND Sharpe > buy-hold BTC Sharpe.
 * Any pass → Path 1 (beta harvester) is the build target.
 * None → no risk-managed beta edge → hold/DCA (C5-beta).
 */

import { promises as fs } from "node:fs";
import { fetchBars, meanT } from "./lib/bulk-fetch.js";
import type { Candle } from "../src/analysis/indicators.js";

const WINDOW_DAYS = 1095;
const DAY_MS = 86_400_000;
const VOL_LB = 30;
const MA_LB = 100;
const TARGET_VOL = 0.40;
const COST = 0.0014;
const ANN = Math.sqrt(365);

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / DAY_MS) * DAY_MS;
const FROM_MS = TO_MS - WINDOW_DAYS * DAY_MS;
console.log(`window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)}\n`);

async function load(instId: string): Promise<Map<number, number>> {
  const bars: Candle[] = await fetchBars(instId, "1D", FROM_MS, TO_MS);
  const m = new Map<number, number>();
  for (const b of bars) m.set(b.t * 1000, b.c);
  return m;
}
const BTC = await load("BTC-USDT");
const ETH = await load("ETH-USDT");
const SOL = await load("SOL-USDT");
const BNB = await load("BNB-USDT");
const grid = [...BTC.keys()].filter((d) => d >= FROM_MS && d < TO_MS).sort((a, b) => a - b);

const lr = (m: Map<number, number>, a: number, b: number): number | undefined => {
  const x = m.get(a);
  const y = m.get(b);
  return x !== undefined && y !== undefined && x > 0 && y > 0 ? Math.log(y / x) : undefined;
};
function realVol(m: Map<number, number>, day: number): number | undefined {
  const r: number[] = [];
  for (let k = 0; k < VOL_LB; k++) {
    const v = lr(m, day - (k + 1) * DAY_MS, day - k * DAY_MS);
    if (v === undefined) return undefined;
    r.push(v);
  }
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.length - 1));
  return sd > 0 ? sd * ANN : undefined;
}
function aboveMA(m: Map<number, number>, day: number): boolean | undefined {
  const c = m.get(day);
  if (c === undefined) return undefined;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < MA_LB; k++) {
    const v = m.get(day - k * DAY_MS);
    if (v !== undefined) { sum += v; n++; }
  }
  if (n < MA_LB * 0.8) return undefined;
  return c > sum / n;
}

function stats(rets: number[], stamps: number[], turns: number[]) {
  const eq = [1];
  for (const r of rets) eq.push(eq[eq.length - 1]! * (1 + r));
  let peak = eq[0]!;
  let maxDD = 0;
  for (const e of eq) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > maxDD) maxDD = dd; }
  const { mean } = meanT(rets);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const sharpe = sd > 0 ? (mean / sd) * ANN : 0;
  const ym = new Map<number, number>();
  for (let i = 0; i < rets.length; i++) {
    const y = new Date(stamps[i]!).getUTCFullYear();
    ym.set(y, (ym.get(y) ?? 0) + Math.log(1 + rets[i]!));
  }
  const byYear = [...ym.entries()].map(([year, l]) => ({ year, ret: Math.exp(l) - 1 })).sort((a, b) => a.year - b.year);
  return { sharpe, annRet: mean * 365, annVol: sd * ANN, maxDD, byYear, meanTurnover: turns.reduce((a, b) => a + b, 0) / Math.max(1, turns.length) };
}

// Generic single/basket simulator. `targetW(day)` returns desired weights
// per asset (already vol-targeted & regime-filtered); we realize them on
// next-day returns and charge cost on weight changes.
function simulate(assets: { id: string; m: Map<number, number> }[], targetW: (day: number) => Map<string, number>) {
  const rets: number[] = [];
  const stamps: number[] = [];
  const turns: number[] = [];
  let w = new Map<string, number>();
  for (let i = 1; i < grid.length; i++) {
    const yest = grid[i - 1]!;
    const today = grid[i]!;
    let pr = 0;
    for (const [id, wi] of w) {
      const a = assets.find((x) => x.id === id)!;
      const r = lr(a.m, yest, today);
      if (r !== undefined) pr += wi * (Math.exp(r) - 1);
    }
    const nw = targetW(today);
    const ids = new Set([...w.keys(), ...nw.keys()]);
    let turn = 0;
    for (const id of ids) turn += Math.abs((nw.get(id) ?? 0) - (w.get(id) ?? 0));
    pr -= turn * COST;
    rets.push(pr);
    stamps.push(today);
    turns.push(turn);
    w = nw;
  }
  return stats(rets, stamps, turns);
}

const btcAsset = [{ id: "BTC-USDT", m: BTC }];
const basket = [
  { id: "BTC-USDT", m: BTC }, { id: "ETH-USDT", m: ETH },
  { id: "SOL-USDT", m: SOL }, { id: "BNB-USDT", m: BNB },
];

// Cell 0: buy-hold BTC.
const c0 = simulate(btcAsset, () => new Map([["BTC-USDT", 1]]));
// Cell 1: BTC vol-target.
const c1 = simulate(btcAsset, (day) => {
  const v = realVol(BTC, day);
  return new Map([["BTC-USDT", v ? Math.min(1, TARGET_VOL / v) : 0]]);
});
// Cell 2: BTC vol-target + MA filter.
const c2 = simulate(btcAsset, (day) => {
  const v = realVol(BTC, day);
  const up = aboveMA(BTC, day);
  return new Map([["BTC-USDT", v && up ? Math.min(1, TARGET_VOL / v) : 0]]);
});
// Cell 3: basket inverse-vol + portfolio vol-target + MA filter.
const c3 = simulate(basket, (day) => {
  const elig = basket
    .map((a) => ({ id: a.id, v: realVol(a.m, day), up: aboveMA(a.m, day) }))
    .filter((a) => a.v !== undefined && a.up === true) as { id: string; v: number; up: boolean }[];
  const out = new Map<string, number>();
  if (elig.length === 0) return out;
  const sumInv = elig.reduce((s, a) => s + 1 / a.v, 0);
  // inverse-vol weights → book vol proxy = weighted-avg name vol (corr~1 stress)
  const bookVol = elig.reduce((s, a) => s + (1 / a.v / sumInv) * a.v, 0);
  const scale = Math.min(1, TARGET_VOL / bookVol);
  for (const a of elig) out.set(a.id, (1 / a.v / sumInv) * scale);
  return out;
});

const cells = [
  { name: "0 BTC buy-hold        ", r: c0, managed: false },
  { name: "1 BTC vol-target      ", r: c1, managed: true },
  { name: "2 BTC vol-tgt + MA    ", r: c2, managed: true },
  { name: "3 Basket vol-tgt + MA ", r: c3, managed: true },
];

const tag = new Date(TO_MS).toISOString().slice(0, 10);
await fs.mkdir("logs", { recursive: true });
await fs.writeFile(`logs/probe-beta-harvest-${tag}.json`, JSON.stringify({ fromMs: FROM_MS, toMs: TO_MS, cells: cells.map((c) => ({ name: c.name.trim(), ...c.r })) }, null, 2));

console.log(`results vs pre-registered gate (Sharpe≥1.0 AND maxDD<35% AND Sharpe>BTC buy-hold):\n`);
const benchSharpe = c0.sharpe;
let anyPass = false;
for (const c of cells) {
  const pass = c.managed && c.r.sharpe >= 1.0 && c.r.maxDD < 0.35 && c.r.sharpe > benchSharpe;
  anyPass ||= pass;
  console.log(`  ${c.name} Sharpe=${c.r.sharpe.toFixed(2)}  annRet=${(c.r.annRet * 100).toFixed(0)}%  annVol=${(c.r.annVol * 100).toFixed(0)}%  maxDD=${(c.r.maxDD * 100).toFixed(0)}%  turn/d=${(c.r.meanTurnover * 100).toFixed(1)}%  ${c.managed ? (pass ? "→ PASS" : "→ fail") : "(bench)"}`);
  console.log(`     by year: ${c.r.byYear.map((y) => `${y.year}:${(y.ret * 100).toFixed(0)}%`).join("  ")}`);
}
console.log(`\nP0.1b VERDICT: ${anyPass ? "PASS — risk-managed beta beats buy-hold → Path 1 (beta harvester) is the build target" : "FAIL — risk management adds no risk-adjusted edge over holding → honest answer is hold/DCA (C5-beta)"}`);
