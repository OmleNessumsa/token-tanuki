/**
 * C4b — CROSS-SECTIONAL funding probe (the last untested funding angle,
 * docs/PROBE_RESULTS_2026-06-12.md).
 *
 * Construction: at every 8h funding settlement over the past year, rank the
 * universe (top ~30 Blofin USDT perps by 24h quote volume) by the funding
 * rate just settled. LONG the lowest quintile, SHORT the highest quintile,
 * equal-weight, hold 8h/24h/72h. Market-neutral by construction — this
 * removes the β/regime confound that killed every prior result.
 *
 * PnL per spread-unit (1 long + 1 short leg):
 *   price  = mean fwd log-return of LONG basket − mean of SHORT basket
 *   carry  = funding accrued during the hold: longs PAY funding (−Σrate),
 *            shorts RECEIVE it (+Σrate), summed over settlements in (T, T+H]
 *   total  = price + carry
 *
 * Known bias, accepted for a kill-or-continue probe: the universe is ranked
 * by TODAY's volume → mild survivorship bias, which flatters the result. A
 * FAIL is therefore extra credible; a PASS must survive an as-of universe
 * before anyone trades it.
 *
 * Pre-registered PASS criteria @ h=24 (decided before running):
 *   1. non-overlapping total-spread t-stat ≥ 2.0, AND
 *   2. total spread positive in ≥3/4 quarters, AND
 *   3. gross mean ≥ 14 bps per rebalance (= survives 50%-turnover costs at
 *      the locked 14bps/leg round-trip cost model).
 * FAIL → C5.
 *
 * `--window-days N` (default 365) extends the window; the 3y run
 * (--window-days 1095) is the agreed higher-powered re-test of the SAME
 * construction and criteria. For long windows, symbols with partial history
 * (newer listings) participate only where they have data — membership is
 * resolved per settlement, which also reduces the survivorship bias of the
 * fixed-universe 1y run.
 */

import { promises as fs } from "node:fs";
import { getNativeCandles, getFundingRateHistory } from "../src/clients/blofin.js";
import type { Candle } from "../src/analysis/indicators.js";

const UNIVERSE_SIZE = 30;
const MIN_SYMBOLS_PER_SETTLEMENT = 20;
const windowArgIdx = process.argv.indexOf("--window-days");
const WINDOW_DAYS = windowArgIdx > -1 ? Number(process.argv[windowArgIdx + 1]) : 365;
if (!Number.isFinite(WINDOW_DAYS) || WINDOW_DAYS < 90) {
  console.error("--window-days must be a number ≥ 90");
  process.exit(1);
}
/** Symbols need at least this much history to ever enter a cross-section. */
const MIN_SYMBOL_BARS = 90 * 24;
const HORIZONS_H = [8, 24, 72];
const PAGE_LIMIT = 1440;
const COST_PER_LEG_RT = 0.0014; // 14 bps round-trip per leg (PRD §9.3+9.4)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetch1hCandles(instId: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = toMs;
  for (let page = 0; page < 30; page++) {
    // getNativeCandles returns [] on BOTH errors and end-of-history. An empty
    // batch inside our window is usually a rate-limit hit, not a listing
    // boundary — retry with backoff before accepting it as the end.
    let batch: Candle[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(1000 * 3 ** (attempt - 1));
      batch = await getNativeCandles(instId, "1H", { after: cursor, limit: PAGE_LIMIT });
      if (batch.length > 0) break;
    }
    if (batch.length === 0) break;
    all.push(...batch);
    const oldestMs = batch[0]!.t * 1000;
    if (oldestMs <= fromMs) break;
    cursor = oldestMs;
    await sleep(300);
  }
  const seen = new Set<number>();
  return all
    .filter((c) => c.t * 1000 >= fromMs && c.t * 1000 < toMs)
    .filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)))
    .sort((a, b) => a.t - b.t);
}

const NOW_MS = Date.now();
const TO_MS = Math.floor(NOW_MS / 3_600_000) * 3_600_000 - 3_600_000;
const FROM_MS = TO_MS - WINDOW_DAYS * 86_400_000;

console.log(`window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)} (${WINDOW_DAYS}d)\n`);

// ---- [1/4] Universe: top-N USDT perps by 24h quote volume (today) ----
console.log(`[1/4] selecting universe (top ${UNIVERSE_SIZE} USDT perps by 24h quote volume)...`);
interface TickerRow {
  instId: string;
  last: string;
  volCurrency24h?: string;
  volCurrencyQuote24h?: string;
}
// Plain fetch with retry — a rate-limit response here is an HTML page, not
// JSON, so parse defensively and back off (the limiter can persist a while
// after a heavy run).
let tickersJson: { code: string; data: TickerRow[] } | null = null;
for (let attempt = 0; attempt < 6 && tickersJson === null; attempt++) {
  if (attempt > 0) {
    const delay = 2000 * 3 ** (attempt - 1);
    console.log(`  tickers fetch retry in ${Math.round(delay / 1000)}s...`);
    await sleep(delay);
  }
  try {
    const res = await fetch("https://openapi.blofin.com/api/v1/market/tickers");
    const parsed = (await res.json()) as { code: string; data: TickerRow[] };
    if (parsed.code === "0") tickersJson = parsed;
  } catch {
    // HTML rate-limit page or network hiccup — retry
  }
}
if (!tickersJson) {
  console.error("tickers fetch failed after 6 attempts");
  process.exit(1);
}
const ranked = tickersJson.data
  .filter((t) => t.instId.endsWith("-USDT"))
  .map((t) => ({
    instId: t.instId,
    qv: t.volCurrencyQuote24h !== undefined
      ? Number(t.volCurrencyQuote24h)
      : Number(t.volCurrency24h ?? 0) * Number(t.last ?? 0),
  }))
  .filter((t) => Number.isFinite(t.qv) && t.qv > 0)
  .sort((a, b) => b.qv - a.qv)
  .slice(0, UNIVERSE_SIZE + 15); // overfetch; coverage filter trims below
console.log(`  ${ranked.length} candidates: ${ranked.slice(0, 10).map((r) => r.instId).join(", ")}, ...`);

// ---- [2/4] Fetch candles + funding per symbol ----
console.log(`\n[2/4] fetching ${WINDOW_DAYS}d of 1H candles + funding history per symbol...`);
interface SymData {
  instId: string;
  candles: Candle[];
  barTimesMs: number[];
  /** settlement tMs → rate */
  funding: Map<number, number>;
  /** sorted settlement times */
  settleTimes: number[];
  /** funding cycle length in ms (median settlement gap) — Blofin mixes 8h and 4h cycles */
  cycleMs: number;
}
const symbols: SymData[] = [];
for (const cand of ranked) {
  if (symbols.length >= UNIVERSE_SIZE) break;
  const candles = await fetch1hCandles(cand.instId, FROM_MS, TO_MS);
  if (candles.length < MIN_SYMBOL_BARS) {
    console.log(`  ${cand.instId}: only ${candles.length} bars (<90d) — drop`);
    continue;
  }
  let fundingRaw;
  try {
    fundingRaw = await getFundingRateHistory(cand.instId, FROM_MS - 8 * 3_600_000);
  } catch (err) {
    console.log(`  ${cand.instId}: funding fetch failed (${(err as Error).message}) — drop`);
    continue;
  }
  const funding = new Map<number, number>();
  for (const f of fundingRaw) {
    const tMs = Number(f.fundingTime);
    if (tMs < TO_MS) funding.set(tMs, Number(f.fundingRate));
  }
  if (funding.size < MIN_SYMBOL_BARS / 8) {
    console.log(`  ${cand.instId}: only ${funding.size} settlements — drop`);
    continue;
  }
  const settleTimes = [...funding.keys()].sort((a, b) => a - b);
  const gaps = settleTimes.slice(1).map((t, i) => t - settleTimes[i]!).sort((a, b) => a - b);
  const cycleMs = gaps[Math.floor(gaps.length / 2)]!;
  symbols.push({
    instId: cand.instId,
    candles,
    barTimesMs: candles.map((b) => b.t * 1000),
    funding,
    settleTimes,
    cycleMs,
  });
  console.log(`  ${cand.instId}: ${candles.length} bars, ${funding.size} settlements, ${cycleMs / 3_600_000}h cycle ✓ (${symbols.length}/${UNIVERSE_SIZE})`);
}
if (symbols.length < MIN_SYMBOLS_PER_SETTLEMENT) {
  console.error(`only ${symbols.length} symbols with full coverage — abort`);
  process.exit(1);
}

// ---- [3/4] Build per-settlement cross-sections ----
console.log(`\n[3/4] building cross-sections on the master settlement grid...`);
const btc = symbols.find((s) => s.instId === "BTC-USDT") ?? symbols[0]!;
const maxH = Math.max(...HORIZONS_H);

function firstBarAtOrAfter(s: SymData, ms: number): number {
  let lo = 0;
  let hi = s.barTimesMs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s.barTimesMs[mid]! < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Sum of funding rates at settlements in (tMs, tMs + h hours] — the funding
 * actually accrued during the hold. Expected settlement count follows the
 * symbol's own cycle length (8h for majors, 4h for some newer perps);
 * a mismatch means a data gap → null so the row is dropped, not skewed.
 */
function fundingSum(s: SymData, tMs: number, h: number): number | null {
  const endMs = tMs + h * 3_600_000;
  let sum = 0;
  let count = 0;
  for (const st of s.settleTimes) {
    if (st <= tMs) continue;
    if (st > endMs) break;
    sum += s.funding.get(st)!;
    count++;
  }
  const expected = Math.round((h * 3_600_000) / s.cycleMs);
  return count === expected ? sum : null;
}

interface SpreadRow {
  tMs: number;
  nSyms: number;
  longBasket: string[];
  shortBasket: string[];
  /** per horizon: price spread, carry, total (log-return units) */
  price: Record<number, number>;
  carry: Record<number, number>;
  total: Record<number, number>;
}

const rows: SpreadRow[] = [];
for (const tMs of btc.settleTimes) {
  if (tMs < FROM_MS || tMs >= TO_MS) continue;
  // Collect symbols with a rate at this settlement + full forward data.
  // Rank on funding PER HOUR — 4h-cycle and 8h-cycle rates aren't directly
  // comparable in raw per-cycle units.
  const entries: { sym: SymData; rate: number; entryIdx: number }[] = [];
  for (const s of symbols) {
    const rate = s.funding.get(tMs);
    if (rate === undefined) continue;
    const entryIdx = firstBarAtOrAfter(s, tMs);
    if (entryIdx + maxH >= s.candles.length) continue;
    // Entry bar must start within an hour of the settlement — a partial-history
    // symbol whose listing postdates tMs would otherwise map to its first bar.
    if (s.barTimesMs[entryIdx]! - tMs > 3_600_000) continue;
    if (s.candles[entryIdx + maxH]!.t - s.candles[entryIdx]!.t !== maxH * 3600) continue;
    entries.push({ sym: s, rate: rate / (s.cycleMs / 3_600_000), entryIdx });
  }
  if (entries.length < MIN_SYMBOLS_PER_SETTLEMENT) continue;

  entries.sort((a, b) => a.rate - b.rate);
  const q = Math.floor(entries.length / 5);
  const longB = entries.slice(0, q);
  const shortB = entries.slice(entries.length - q);

  const price: Record<number, number> = {};
  const carry: Record<number, number> = {};
  const total: Record<number, number> = {};
  let valid = true;
  for (const h of HORIZONS_H) {
    let longPx = 0;
    let shortPx = 0;
    let longCy = 0;
    let shortCy = 0;
    for (const e of longB) {
      const entry = e.sym.candles[e.entryIdx]!.o;
      longPx += Math.log(e.sym.candles[e.entryIdx + h]!.o / entry);
      const fs_ = fundingSum(e.sym, tMs, h);
      if (fs_ === null) { valid = false; break; }
      longCy += -fs_; // long pays funding
    }
    if (!valid) break;
    for (const e of shortB) {
      const entry = e.sym.candles[e.entryIdx]!.o;
      shortPx += Math.log(e.sym.candles[e.entryIdx + h]!.o / entry);
      const fs_ = fundingSum(e.sym, tMs, h);
      if (fs_ === null) { valid = false; break; }
      shortCy += fs_; // short receives funding
    }
    if (!valid) break;
    price[h] = longPx / longB.length - shortPx / shortB.length;
    carry[h] = longCy / longB.length + shortCy / shortB.length;
    total[h] = price[h]! + carry[h]!;
  }
  if (!valid) continue;
  rows.push({
    tMs,
    nSyms: entries.length,
    longBasket: longB.map((e) => e.sym.instId),
    shortBasket: shortB.map((e) => e.sym.instId),
    price,
    carry,
    total,
  });
}
console.log(`  ${rows.length} settlement cross-sections (universe of ${symbols.length} syms)`);

await fs.mkdir("logs", { recursive: true });
const tag = new Date(TO_MS).toISOString().slice(0, 10);
const outPath = `logs/probe-funding-xsec-${WINDOW_DAYS}d-${tag}.json`;
await fs.writeFile(
  outPath,
  JSON.stringify({ fromMs: FROM_MS, toMs: TO_MS, universe: symbols.map((s) => s.instId), horizons: HORIZONS_H, rows }, null, 2),
);
console.log(`  raw rows persisted → ${outPath}`);

// ---- [4/4] Analysis ----
console.log(`\n[4/4] analysis (spread per rebalance, bps; 1 unit long + 1 unit short):`);
const QUARTER_MS = Math.floor((TO_MS - FROM_MS) / 4);
const quarterOf = (ms: number): number => Math.min(3, Math.floor((ms - FROM_MS) / QUARTER_MS));

function meanT(xs: readonly number[]): { mean: number; t: number; n: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  return { mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, n };
}

let pass24 = false;
for (const h of HORIZONS_H) {
  const stride = Math.ceil(h / 8);
  const nonOverlap = rows.filter((_, i) => i % stride === 0);
  const totals = nonOverlap.map((r) => r.total[h]!);
  const prices = nonOverlap.map((r) => r.price[h]!);
  const carries = nonOverlap.map((r) => r.carry[h]!);
  const mtT = meanT(totals);
  const mtP = meanT(prices);
  const mtC = meanT(carries);

  const qMeans = [0, 1, 2, 3].map((q) => {
    const qx = nonOverlap.filter((r) => quarterOf(r.tMs) === q).map((r) => r.total[h]!);
    return qx.length ? qx.reduce((a, b) => a + b, 0) / qx.length : 0;
  });
  const posQuarters = qMeans.filter((m) => m > 0).length;

  // Cost tiers per rebalance: full turnover = both legs fully replaced
  // (2 × 14bps); half turnover = 14bps.
  const grossBps = mtT.mean * 10_000;
  const netHalf = grossBps - COST_PER_LEG_RT * 10_000;
  const netFull = grossBps - 2 * COST_PER_LEG_RT * 10_000;

  console.log(`\n  h=${h}h (non-overlapping, n=${mtT.n}):`);
  console.log(`    price  ${(mtP.mean * 10_000).toFixed(1).padStart(7)} bps  t=${mtP.t.toFixed(2)}`);
  console.log(`    carry  ${(mtC.mean * 10_000).toFixed(1).padStart(7)} bps  t=${mtC.t.toFixed(2)}`);
  console.log(`    total  ${grossBps.toFixed(1).padStart(7)} bps  t=${mtT.t.toFixed(2)}   net@50%turnover=${netHalf.toFixed(1)}  net@100%=${netFull.toFixed(1)}`);
  console.log(`    quarterly total means (bps): [${qMeans.map((m) => (m * 10_000).toFixed(1)).join(", ")}]  positive ${posQuarters}/4`);

  if (h === 24) {
    pass24 = mtT.t >= 2.0 && posQuarters >= 3 && grossBps >= 14;
    console.log(`\n  PASS CRITERIA @ h=24: t≥2.0 (got ${mtT.t.toFixed(2)}), quarters≥3/4 (got ${posQuarters}), gross≥14bps (got ${grossBps.toFixed(1)}) → ${pass24 ? "PASS" : "FAIL"}`);
  }
}
console.log(`\nVERDICT: ${pass24 ? "PASS — proceed to as-of-universe + trade-sim validation" : "FAIL — C4 funding angles exhausted; recommendation is C5"}`);
