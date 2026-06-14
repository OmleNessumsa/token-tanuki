/**
 * P0.1c — robustness of the P0.1b PASS. Cell 2 (BTC vol-target + 100d MA)
 * cleared the gate, but a trend filter on a single bull-then-bear cycle is
 * exactly the regime-fit that killed every other hypothesis. If the PASS
 * is real (mechanism: trend-overlay on a risky asset — a universal, well-
 * documented effect), it should hold across a GRID of MA lengths and vol
 * targets, not knife-edge on (100, 0.40). If only one corner passes, it's
 * a fit.
 *
 * Sweep: MA ∈ {50,100,150,200} × targetVol ∈ {0.30,0.40,0.50}, BTC.
 * Report Sharpe / maxDD for every cell; count how many beat buy-hold
 * (Sharpe>bench AND maxDD<35%). Robust ⇒ large majority pass.
 */

import { promises as fs } from "node:fs";
import { fetchBars, meanT } from "./lib/bulk-fetch.js";
import type { Candle } from "../src/analysis/indicators.js";

const WINDOW_DAYS = 1095;
const DAY_MS = 86_400_000;
const VOL_LB = 30;
const COST = 0.0014;
const ANN = Math.sqrt(365);
const MAS = [50, 100, 150, 200];
const TVOLS = [0.3, 0.4, 0.5];

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / DAY_MS) * DAY_MS;
const FROM_MS = TO_MS - WINDOW_DAYS * DAY_MS;

const bars: Candle[] = await fetchBars("BTC-USDT", "1D", FROM_MS, TO_MS);
const BTC = new Map<number, number>();
for (const b of bars) BTC.set(b.t * 1000, b.c);
const grid = [...BTC.keys()].filter((d) => d >= FROM_MS && d < TO_MS).sort((a, b) => a - b);

const lr = (a: number, b: number): number | undefined => {
  const x = BTC.get(a);
  const y = BTC.get(b);
  return x !== undefined && y !== undefined && x > 0 && y > 0 ? Math.log(y / x) : undefined;
};
function realVol(day: number): number | undefined {
  const r: number[] = [];
  for (let k = 0; k < VOL_LB; k++) { const v = lr(day - (k + 1) * DAY_MS, day - k * DAY_MS); if (v === undefined) return undefined; r.push(v); }
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1));
  return sd > 0 ? sd * ANN : undefined;
}
function aboveMA(day: number, lb: number): boolean | undefined {
  const c = BTC.get(day);
  if (c === undefined) return undefined;
  let s = 0, n = 0;
  for (let k = 0; k < lb; k++) { const v = BTC.get(day - k * DAY_MS); if (v !== undefined) { s += v; n++; } }
  return n < lb * 0.8 ? undefined : c > s / n;
}
function run(ma: number | null, tvol: number) {
  const rets: number[] = [];
  let prevW = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = lr(grid[i - 1]!, grid[i]!);
    let pr = r !== undefined ? prevW * (Math.exp(r) - 1) : 0;
    const v = realVol(grid[i]!);
    const up = ma === null ? true : aboveMA(grid[i]!, ma);
    const w = v && up ? Math.min(1, tvol / v) : (ma === null && v ? Math.min(1, tvol / v) : 0);
    pr -= Math.abs(w - prevW) * COST;
    rets.push(pr);
    prevW = w;
  }
  const eq = [1];
  for (const r of rets) eq.push(eq[eq.length - 1]! * (1 + r));
  let peak = eq[0]!, maxDD = 0;
  for (const e of eq) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > maxDD) maxDD = dd; }
  const { mean } = meanT(rets);
  const sd = Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  return { sharpe: sd > 0 ? (mean / sd) * ANN : 0, annRet: mean * 365, maxDD };
}

// Buy-hold benchmark.
const bench = (() => {
  const rets: number[] = [];
  for (let i = 1; i < grid.length; i++) { const r = lr(grid[i - 1]!, grid[i]!); if (r !== undefined) rets.push(Math.exp(r) - 1); }
  const { mean } = meanT(rets);
  const sd = Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  return sd > 0 ? (mean / sd) * ANN : 0;
})();

console.log(`window 3y. buy-hold BTC Sharpe=${bench.toFixed(2)}\n`);
console.log(`grid: rows=MA length, cols=target vol. cell = Sharpe / maxDD%  (* = beats bench & maxDD<35%)\n`);
console.log(`         ${TVOLS.map((t) => `tvol=${t}`.padStart(16)).join("")}`);
let passCount = 0;
const out: Record<string, unknown>[] = [];
for (const ma of MAS) {
  const cells = TVOLS.map((tv) => {
    const r = run(ma, tv);
    const ok = r.sharpe > bench && r.maxDD < 0.35;
    if (ok) passCount++;
    out.push({ ma, tvol: tv, ...r, pass: ok });
    return `${r.sharpe.toFixed(2)}/${(r.maxDD * 100).toFixed(0)}%${ok ? "*" : " "}`.padStart(16);
  });
  console.log(`  MA=${ma.toString().padStart(3)}  ${cells.join("")}`);
}
// No-filter row (vol-target only) for contrast.
const nf = TVOLS.map((tv) => { const r = run(null, tv); return `${r.sharpe.toFixed(2)}/${(r.maxDD * 100).toFixed(0)}%`.padStart(16); });
console.log(`  noMA   ${nf.join("")}`);

await fs.mkdir("logs", { recursive: true });
await fs.writeFile(`logs/probe-beta-robust-${new Date(TO_MS).toISOString().slice(0, 10)}.json`, JSON.stringify({ bench, cells: out }, null, 2));
console.log(`\nrobustness: ${passCount}/${MAS.length * TVOLS.length} MA×tvol cells beat buy-hold with maxDD<35%.`);
console.log(passCount >= 9 ? "ROBUST — PASS is not knife-edge; trend-overlay effect holds across the grid." : passCount >= 5 ? "PARTIAL — effect present but parameter-sensitive; treat with caution." : "FRAGILE — likely regime-fit to this one cycle.");
