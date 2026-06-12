/**
 * H2 (CB-012) — BTC→alt lead-lag on 1-4h bars. Funnel Gate 1+2.
 * Roadmap: docs/STRATEGY_ROADMAP_2026-06-12.md.
 *
 * Gate 0 (mechanism, passed with a LOW prior): BTC is where macro flow
 * lands first; thin alt books reprice with a lag. Counterparty: stale
 * quotes / slow capital. Known to decay as HFT arbs it — we test whether
 * anything is left at the 1h+ scale a retail-latency strategy could trade.
 *
 * Two designs (both pre-registered, 12 cells total):
 *
 * A) CROSS-SECTIONAL "catch-up" — honest label: relative short-horizon
 *    reversal. In cross-sectional ranks BTC's own move cancels, so the
 *    signal reduces to: alts that lagged the common move (low own return
 *    over lookback L) outperform peers over the next h hours. Fama-MacBeth
 *    style: per-timestamp Spearman IC across alts of (−ret_L,i) vs fwd_h,i,
 *    aggregated over non-overlapping timestamps. Expected POSITIVE.
 *    L ∈ {1,4}, h ∈ {1,4,12}.
 *
 * B) TIME-SERIES index lead-lag — the literal "alts follow BTC" claim:
 *    signal = btcRet_L(t) − altIndexRet_L(t) (how far the equal-weight alt
 *    index lags BTC's move), target = altIndexFwd_h(t) − btcFwd_h(t)
 *    (the catch-up). Spearman on non-overlapping timestamps. Expected
 *    POSITIVE. Same L × h grid.
 *
 * Pre-registered PASS criteria per cell (12-test burden):
 *   t ≥ 2.5 in expected direction (non-overlapping), AND
 *   expected sign in ≥2/3 window-thirds, AND expected sign in both halves.
 * Any cell passing → Gate 3. None → H2 dead, next hypothesis (H3).
 */

import { promises as fs } from "node:fs";
import { fetchBars, fetchTopUsdtPerps, meanT, spearman } from "./lib/bulk-fetch.js";

const WINDOW_DAYS = 1095;
const CANDIDATES = 45;
const MIN_HISTORY_HOURS = 180 * 24;
const MIN_XSEC = 15;
const HOUR_MS = 3_600_000;
const LOOKBACKS_H = [1, 4];
const HORIZONS_H = [1, 4, 12];

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / HOUR_MS) * HOUR_MS - HOUR_MS;
const FROM_MS = TO_MS - WINDOW_DAYS * 24 * HOUR_MS;
console.log(`window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)} (${WINDOW_DAYS}d, 1H bars)\n`);

console.log(`[1/3] universe + 1H bars (heavy fetch, throttled)...`);
const universe = await fetchTopUsdtPerps(CANDIDATES);
interface Sym {
  instId: string;
  closeByHour: Map<number, number>;
}
const syms: Sym[] = [];
for (const instId of universe) {
  const bars = await fetchBars(instId, "1H", FROM_MS, TO_MS);
  if (bars.length < MIN_HISTORY_HOURS) {
    console.log(`  ${instId}: ${bars.length}h — drop`);
    continue;
  }
  const closeByHour = new Map<number, number>();
  for (const b of bars) closeByHour.set(b.t * 1000, b.c);
  syms.push({ instId, closeByHour });
  console.log(`  ${instId}: ${bars.length}h ✓ (${syms.length})`);
}
const btc = syms.find((s) => s.instId === "BTC-USDT");
if (!btc) {
  console.error("BTC-USDT missing — abort");
  process.exit(1);
}
const alts = syms.filter((s) => s.instId !== "BTC-USDT");
console.log(`  ${alts.length} alts + BTC`);

const ret = (s: Sym, fromMs: number, toMs: number): number | undefined => {
  const a = s.closeByHour.get(fromMs);
  const b = s.closeByHour.get(toMs);
  return a !== undefined && b !== undefined ? Math.log(b / a) : undefined;
};

console.log(`\n[2/3] building per-timestamp observations...`);
const maxL = Math.max(...LOOKBACKS_H);
const maxH = Math.max(...HORIZONS_H);

// A: per-timestamp cross-sectional IC; B: per-timestamp scalar pair.
interface HourRow {
  tMs: number;
  a: Record<string, { ic: number; n: number; q1mq5: number }>; // key `L{l}h{h}`
  b: Record<string, { sig: number; tgt: number }>;
}
const rows: HourRow[] = [];

for (let tMs = FROM_MS + maxL * HOUR_MS; tMs + maxH * HOUR_MS < TO_MS; tMs += HOUR_MS) {
  const row: HourRow = { tMs, a: {}, b: {} };
  let any = false;
  for (const L of LOOKBACKS_H) {
    const btcL = ret(btc, tMs - L * HOUR_MS, tMs);
    if (btcL === undefined) continue;
    // Alt own-lookback returns reused across horizons.
    const altL = new Map<string, number>();
    for (const s of alts) {
      const r = ret(s, tMs - L * HOUR_MS, tMs);
      if (r !== undefined) altL.set(s.instId, r);
    }
    for (const h of HORIZONS_H) {
      const btcF = ret(btc, tMs, tMs + h * HOUR_MS);
      if (btcF === undefined) continue;
      const sig: number[] = [];
      const fwd: number[] = [];
      let idxL = 0;
      let idxF = 0;
      let nIdx = 0;
      for (const s of alts) {
        const rl = altL.get(s.instId);
        const rf = ret(s, tMs, tMs + h * HOUR_MS);
        if (rl === undefined || rf === undefined) continue;
        sig.push(-rl); // laggard score: low own return = high signal
        fwd.push(rf);
        idxL += rl;
        idxF += rf;
        nIdx++;
      }
      if (sig.length < MIN_XSEC) continue;
      const ic = spearman(sig, fwd);
      const order = sig.map((x, i) => [x, i] as const).sort((a2, b2) => a2[0] - b2[0]);
      const q = Math.floor(sig.length / 5);
      const lo = order.slice(0, q).reduce((acc, [, i]) => acc + fwd[i]!, 0) / q;
      const hi = order.slice(-q).reduce((acc, [, i]) => acc + fwd[i]!, 0) / q;
      const key = `L${L}h${h}`;
      row.a[key] = { ic, n: sig.length, q1mq5: hi - lo }; // hypothesis: high laggard-score outperforms → hi − lo
      row.b[key] = { sig: btcL - idxL / nIdx, tgt: idxF / nIdx - btcF };
      any = true;
    }
  }
  if (any) rows.push(row);
}
console.log(`  ${rows.length} hourly observations`);

const tag = new Date(TO_MS).toISOString().slice(0, 10);
const outPath = `logs/probe-leadlag-${tag}.json`;
await fs.mkdir("logs", { recursive: true });
await fs.writeFile(outPath, JSON.stringify({ fromMs: FROM_MS, toMs: TO_MS, universe: syms.map((s) => s.instId), rows }, null, 2));
console.log(`  raw rows persisted → ${outPath}`);

console.log(`\n[3/3] aggregation against pre-registered gates:`);
const THIRD = Math.floor((TO_MS - FROM_MS) / 3);
const HALF = Math.floor((TO_MS - FROM_MS) / 2);

function stability(xs: { tMs: number; v: number }[]): { thirds: number; halves: number } {
  const t3 = [0, 1, 2].map((k) => {
    const vs = xs.filter((x) => Math.min(2, Math.floor((x.tMs - FROM_MS) / THIRD)) === k).map((x) => x.v);
    return vs.length ? Math.sign(vs.reduce((a, b) => a + b, 0) / vs.length) : 0;
  });
  const t2 = [0, 1].map((k) => {
    const vs = xs.filter((x) => Math.min(1, Math.floor((x.tMs - FROM_MS) / HALF)) === k).map((x) => x.v);
    return vs.length ? Math.sign(vs.reduce((a, b) => a + b, 0) / vs.length) : 0;
  });
  return { thirds: t3.filter((s) => s > 0).length, halves: t2.filter((s) => s > 0).length };
}

let anyPass = false;
for (const design of ["A", "B"] as const) {
  console.log(`\n  design ${design} — ${design === "A" ? "cross-sectional relative reversal (laggards vs peers)" : "time-series alt-index catch-up to BTC"}:`);
  for (const L of LOOKBACKS_H) {
    for (const h of HORIZONS_H) {
      const key = `L${L}h${h}`;
      const cells = rows.filter((r) => (design === "A" ? r.a[key] : r.b[key]) !== undefined);
      const strided = cells.filter((_, i) => i % h === 0);
      if (strided.length < 100) continue;

      if (design === "A") {
        const ics = strided.map((r) => ({ tMs: r.tMs, v: r.a[key]!.ic }));
        const { mean, t, n } = meanT(ics.map((x) => x.v));
        const st = stability(ics);
        const spread = meanT(strided.map((r) => r.a[key]!.q1mq5));
        const pass = t >= 2.5 && st.thirds >= 2 && st.halves === 2;
        anyPass ||= pass;
        console.log(
          `    L=${L}h h=${h.toString().padStart(2)}h  IC=${mean.toFixed(3).padStart(7)}  t=${t.toFixed(2).padStart(6)}  n=${n}  thirds ${st.thirds}/3  halves ${st.halves}/2  L/S=${(spread.mean * 10_000).toFixed(1).padStart(6)}bps/${h}h  → ${pass ? "PASS" : "fail"}`,
        );
      } else {
        const sigs = strided.map((r) => r.b[key]!.sig);
        const tgts = strided.map((r) => r.b[key]!.tgt);
        const ic = spearman(sigs, tgts);
        const z = ic * Math.sqrt(strided.length - 1);
        const prods = strided.map((r) => ({ tMs: r.tMs, v: r.b[key]!.sig * r.b[key]!.tgt }));
        const st = stability(prods);
        const pass = z >= 2.5 && st.thirds >= 2 && st.halves === 2;
        anyPass ||= pass;
        console.log(
          `    L=${L}h h=${h.toString().padStart(2)}h  IC=${ic.toFixed(3).padStart(7)}  z=${z.toFixed(2).padStart(6)}  n=${strided.length}  thirds ${st.thirds}/3  halves ${st.halves}/2  → ${pass ? "PASS" : "fail"}`,
        );
      }
    }
  }
}

console.log(`\nGATE 1+2 VERDICT: ${anyPass ? "PASS — proceed to Gate 3 (cost-sim)" : "FAIL — H2 dead, next hypothesis (H3 low-vol)"}`);
