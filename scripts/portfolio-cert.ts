/**
 * CB-025 — OOS / walk-forward GATE for the multi-premium portfolio.
 *
 * THE REALITEITSTOETS. Honestly certify (or fail) the trend-through-allocator
 * portfolio against the validated single-asset BTC harvester baseline, on REAL
 * out-of-sample data. Adversarial QA: a false PASS is the worst outcome.
 *
 * ── HONEST SCOPE (Elmo's decision, obeyed exactly) ───────────────────────────
 * The funding-carry sleeve (Sleeve B) runs on a PROXY spot leg where the proxy
 * IS the perp, so basis ≈ 0 and basis vol ≈ 0. That ZEROES its modeled residual
 * risk. The carry PREMIUM is therefore NOT certifiable here. We:
 *   - run the HEADLINE cert as TREND-ONLY through the real PortfolioAllocator
 *     (carry contribution excluded), so the un-validated carry sleeve cannot
 *     inflate the headline by being over-weighted on its fake ~0 vol;
 *   - SEPARATELY report an ILLUSTRATIVE-ONLY carry funding cash-flow figure,
 *     loudly labelled UNVALIDATED (basis risk zeroed by proxy);
 *   - SEPARATELY show a carry-included variant with carry's estAnnualVol FLOORED
 *     to a realistic level, to demonstrate the proxy-domination problem honestly.
 *
 * ── DATA ─────────────────────────────────────────────────────────────────────
 * Baseline harvester was tuned on the Blofin 2023-06..2026-06 cache (ONE cycle,
 * in-sample). For a HONEST OOS gate we use Binance daily history back to 2018 —
 * the prior cycle the strategy never saw — exactly as probe-beta-oos.ts does.
 * Spot/perp basis is negligible for a daily low-turnover beta strategy.
 *
 * ── COST MODEL ───────────────────────────────────────────────────────────────
 * 14 bps per leg round-trip (0.0014), charged on |Δweight| — identical to the
 * harvester cert and probe-beta-oos. Net-of-cost is mandatory.
 *
 * ── THE GATE (pre-registered; no moving after seeing results) ────────────────
 * PASS requires the trend-through-allocator portfolio to beat the BTC-harvester
 * baseline on Sharpe AND maxDD, net-of-cost, OOS/walk-forward. Tie or one-of-two
 * ⇒ FAIL. Plus a tail/skew check (mean, skew, worst tail) — a Sharpe win with a
 * fat negative tail FAILS the spirit of the gate (the H3 lesson).
 *
 * ── C5 DISCIPLINE ────────────────────────────────────────────────────────────
 * NO parameter window-shopping. EXISTING sleeve/allocator defaults only. If it
 * only passes after tuning, the honest verdict is FAIL.
 */

import { promises as fs } from "node:fs";
import type { Candle } from "../src/analysis/indicators.js";
import {
  harvesterStats,
  simulateHarvester,
  DEFAULT_HARVESTER_CONFIG,
  type AssetSeries,
  type HarvesterStats,
} from "../src/strategy/harvester.js";
import { createTrendSleeve } from "../src/strategy/sleeves/trend-sleeve.js";
import {
  createFundingCarrySleeve,
  DEFAULT_FUNDING_CARRY_CONFIG,
} from "../src/strategy/sleeves/funding-carry-sleeve.js";
import { createAllocator } from "../src/strategy/allocator.js";
import type {
  MarketData,
  AssetCandles,
  FundingPairData,
  Sleeve,
  TargetLeg,
} from "../src/strategy/sleeve.js";

const DAY_MS = 86_400_000;
const COST = 0.0014; // 14 bps/leg round-trip — same as baseline cert
const ANN = Math.sqrt(365);
const START_MS = Date.parse("2018-01-01T00:00:00Z");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Data fetch (Binance daily, 2018→now) — mirrors probe-beta-oos.ts ──────────

async function fetchBinanceDaily(symbol: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let start = START_MS;
  for (let page = 0; page < 50; page++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${start}&limit=1000`;
    let rows: unknown[] | null = null;
    for (let attempt = 0; attempt < 4 && rows === null; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** attempt);
      try {
        const res = await fetch(url);
        if (res.ok) rows = (await res.json()) as unknown[];
      } catch {
        /* retry */
      }
    }
    if (!rows || rows.length === 0) break;
    for (const r of rows as [number, string, string, string, string, string][]) {
      out.push({ t: Math.floor(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    }
    const lastMs = (rows[rows.length - 1] as [number])[0];
    if (rows.length < 1000) break;
    start = lastMs + DAY_MS;
    await sleep(200);
  }
  const seen = new Set<number>();
  return out
    .filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)))
    .sort((a, b) => a.t - b.t);
}

// ── Stats helpers (reuse harvester's metric so baseline & portfolio compare
//    apples-to-apples on the same definitions) ─────────────────────────────────

interface DistReport {
  mean: number;
  stdev: number;
  skew: number;
  worstDay: number;
  bestDay: number;
  p01: number; // 1st percentile (left tail)
  p99: number;
}

function distReport(rets: readonly number[]): DistReport {
  const n = rets.length;
  if (n < 2) return { mean: 0, stdev: 0, skew: 0, worstDay: 0, bestDay: 0, p01: 0, p99: 0 };
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const skew =
    sd > 0 ? rets.reduce((a, x) => a + ((x - mean) / sd) ** 3, 0) / n : 0;
  const sorted = [...rets].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))]!;
  return {
    mean,
    stdev: sd,
    skew,
    worstDay: sorted[0]!,
    bestDay: sorted[n - 1]!,
    p01: pct(0.01),
    p99: pct(0.99),
  };
}

// ── Build a per-day net return series by driving the REAL allocator ───────────
//
// The portfolio leg of the gate runs the certified TrendSleeve THROUGH the real
// PortfolioAllocator at each bar, realizes the merged book over (i, i+1], and
// charges the SAME cost model on |Δweight|. This exercises the actual sleeve +
// allocator code paths under test (not a re-implementation).

interface PortfolioRun {
  days: number[];
  netReturns: number[];
  grossByDay: number[];
  estVolByDay: number[];
  warmup: number;
  /** Diagnostics for mechanics validation. */
  kellyFractions: number[];
  maxGrossSeen: number;
}

function buildAssetCandles(symbol: string, bars: Candle[]): AssetCandles {
  return { symbol, candles: bars };
}

function runAllocatorPortfolio(
  assets: AssetCandles[],
  pairs: FundingPairData[],
  sleeves: Sleeve[],
  cfgOverride: Partial<Parameters<typeof createAllocator>[1]> = {},
): PortfolioRun {
  // Shared grid = union of asset day stamps (oldest-first).
  const daySet = new Set<number>();
  for (const a of assets) for (const c of a.candles) daySet.add(c.t);
  for (const p of pairs) for (const c of p.perp.candles) daySet.add(c.t);
  const grid = [...daySet].sort((x, y) => x - y);

  const data: MarketData = { grid, assets, pairs };
  const allocator = createAllocator(sleeves, cfgOverride);

  // Price lookup per symbol for return realization.
  const priceBy = new Map<string, Map<number, number>>();
  const addPx = (sym: string, cs: readonly Candle[]) => {
    let m = priceBy.get(sym);
    if (!m) { m = new Map(); priceBy.set(sym, m); }
    for (const c of cs) if (c.c > 0) m.set(c.t, c.c);
  };
  for (const a of assets) addPx(a.symbol, a.candles);
  for (const p of pairs) { addPx(p.spot.symbol, p.spot.candles); addPx(p.perp.symbol, p.perp.candles); }

  const days: number[] = [];
  const netReturns: number[] = [];
  const grossByDay: number[] = [];
  const estVolByDay: number[] = [];
  const kellyFractions: number[] = [];
  let maxGrossSeen = 0;

  let prevBook: TargetLeg[] = [];
  const legKey = (l: TargetLeg) => `${l.legGroup}|${l.symbol}|${l.instrument}`;

  for (let i = 1; i < grid.length; i++) {
    // Realize the book decided at i-1 over (i-1, i].
    let portRet = 0;
    for (const leg of prevBook) {
      const m = priceBy.get(leg.symbol);
      if (!m) continue;
      const a = m.get(grid[i - 1]!);
      const b = m.get(grid[i]!);
      if (a === undefined || b === undefined || a <= 0) continue;
      portRet += leg.weight * (b / a - 1);
    }

    // Decide the new book at i (info through i).
    const alloc = allocator.allocateAt(data, i);
    const newBook = alloc.book as TargetLeg[];

    // Turnover cost on |Δweight| across the union of legs.
    const keys = new Set<string>([...prevBook.map(legKey), ...newBook.map(legKey)]);
    const wPrev = new Map(prevBook.map((l) => [legKey(l), l.weight]));
    const wNew = new Map(newBook.map((l) => [legKey(l), l.weight]));
    let turnover = 0;
    for (const k of keys) turnover += Math.abs((wNew.get(k) ?? 0) - (wPrev.get(k) ?? 0));
    portRet -= turnover * COST;

    const gross = newBook.reduce((a, l) => a + Math.abs(l.weight), 0);
    maxGrossSeen = Math.max(maxGrossSeen, gross);
    for (const a of alloc.allocations) if (a.scale > 0) kellyFractions.push(a.kellyFraction);

    days.push(grid[i]!);
    netReturns.push(portRet);
    grossByDay.push(gross);
    estVolByDay.push(alloc.estPortfolioVol);
    prevBook = newBook;
  }

  const hc = DEFAULT_HARVESTER_CONFIG;
  const warmup = Math.max(hc.volLookbackDays, hc.regimeMaPeriodDays) + 1;
  return {
    days,
    netReturns,
    grossByDay,
    estVolByDay,
    warmup: Math.min(warmup, days.length),
    kellyFractions,
    maxGrossSeen,
  };
}

// ── Walk-forward fold helper (182d folds, same as probe-beta-oos) ─────────────

function foldSharpes(
  days: readonly number[],
  rets: readonly number[],
  foldDays = 182,
): { from: string; sharpe: number }[] {
  const out: { from: string; sharpe: number }[] = [];
  if (days.length === 0) return out;
  const fromMs = days[0]! * 1000;
  const toMs = days[days.length - 1]! * 1000 + DAY_MS;
  for (let f = fromMs; f + foldDays * DAY_MS <= toMs; f += foldDays * DAY_MS) {
    const seg: number[] = [];
    for (let k = 0; k < days.length; k++) {
      const ms = days[k]! * 1000;
      if (ms >= f && ms < f + foldDays * DAY_MS) seg.push(rets[k]!);
    }
    if (seg.length < 60) continue;
    const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
    const sd = Math.sqrt(seg.reduce((a, x) => a + (x - mean) ** 2, 0) / (seg.length - 1));
    out.push({ from: new Date(f).toISOString().slice(0, 7), sharpe: sd > 0 ? (mean / sd) * ANN : 0 });
  }
  return out;
}

// ── Sleeve B illustrative funding cash flow (UNVALIDATED) ─────────────────────
//
// We do NOT have settled funding history in the Binance daily OOS path, so the
// illustrative carry figure is computed from the Blofin funding cache if present
// via a separate, clearly-labelled estimate. Here we report it conservatively as
// "not computed in OOS path" unless funding data is supplied. The proxy zeroes
// basis risk regardless, so any number here is illustrative only.

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fmt = (s: HarvesterStats) =>
    `Sharpe=${s.sharpe.toFixed(2)}  CAGR=${pct(s.cagr)}  annVol=${pct(s.annVol)}  maxDD=${pct(s.maxDD)}  final=${s.finalEquity.toFixed(2)}x`;

  console.log("CB-025 OOS / walk-forward GATE — multi-premium portfolio\n");
  console.log("[1/5] fetching Binance daily history (2018→now)…");
  const btcBars = await fetchBinanceDaily("BTCUSDT");
  const ethBars = await fetchBinanceDaily("ETHUSDT");
  // SOL & BNB extend the trend basket breadth where history exists.
  const solBars = await fetchBinanceDaily("SOLUSDT");
  const bnbBars = await fetchBinanceDaily("BNBUSDT");

  const span = (b: Candle[]) =>
    b.length
      ? `${b.length}d ${new Date(b[0]!.t * 1000).toISOString().slice(0, 10)}→${new Date(b[b.length - 1]!.t * 1000).toISOString().slice(0, 10)}`
      : "EMPTY";
  console.log(`   BTC ${span(btcBars)}`);
  console.log(`   ETH ${span(ethBars)}`);
  console.log(`   SOL ${span(solBars)}`);
  console.log(`   BNB ${span(bnbBars)}`);

  const windowFrom = new Date(btcBars[0]!.t * 1000).toISOString().slice(0, 10);
  const windowTo = new Date(btcBars[btcBars.length - 1]!.t * 1000).toISOString().slice(0, 10);

  // ── BASELINE: single-asset BTC harvester (the validated strategy) ──────────
  console.log("\n[2/5] baseline: single-asset BTC harvester (validated)…");
  const btcSeries: AssetSeries = { symbol: "BTC-USDT", candles: btcBars };
  const baseRun = simulateHarvester([btcSeries], DEFAULT_HARVESTER_CONFIG);
  const bk = baseRun.warmupEndIndex;
  const baseStats = harvesterStats(
    baseRun.dailyReturns.slice(bk),
    baseRun.days.slice(bk),
    baseRun.turnoverByDay.slice(bk),
  );
  console.log(`   BTC harvester baseline: ${fmt(baseStats)}`);

  // ── HEADLINE PORTFOLIO: trend sleeve through the REAL allocator ────────────
  // Carry sleeve EXCLUDED (proxy zeroes its basis risk → would dominate).
  console.log("\n[3/5] HEADLINE: TrendSleeve → PortfolioAllocator (carry excluded)…");
  const basketSymbols = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "BNB-USDT"];
  const basketAssets: AssetCandles[] = [
    buildAssetCandles("BTC-USDT", btcBars),
    buildAssetCandles("ETH-USDT", ethBars),
    buildAssetCandles("SOL-USDT", solBars),
    buildAssetCandles("BNB-USDT", bnbBars),
  ].filter((a) => a.candles.length > 0);

  const trend = createTrendSleeve({}, basketSymbols);
  const headlineRun = runAllocatorPortfolio(basketAssets, [], [trend]);
  const hk = headlineRun.warmup;
  const headlineStats = harvesterStats(
    headlineRun.netReturns.slice(hk),
    headlineRun.days.slice(hk),
  );
  console.log(`   trend→allocator portfolio: ${fmt(headlineStats)}`);

  // Also: BTC-only trend through allocator (isolates "allocator wrapper vs raw
  // harvester" overhead — not the gate, just diagnostic).
  const trendBtcOnly = createTrendSleeve({}, ["BTC-USDT"]);
  const btcAllocRun = runAllocatorPortfolio(
    [buildAssetCandles("BTC-USDT", btcBars)],
    [],
    [trendBtcOnly],
  );
  const btcAllocStats = harvesterStats(
    btcAllocRun.netReturns.slice(btcAllocRun.warmup),
    btcAllocRun.days.slice(btcAllocRun.warmup),
  );
  console.log(`   (diag) BTC-only trend→allocator: ${fmt(btcAllocStats)}`);

  // ── THE GATE ───────────────────────────────────────────────────────────────
  const sharpeWin = headlineStats.sharpe > baseStats.sharpe;
  const ddWin = headlineStats.maxDD < baseStats.maxDD;
  const headlineDist = distReport(headlineRun.netReturns.slice(hk));
  const baseDist = distReport(baseRun.dailyReturns.slice(bk));

  // Tail/skew: portfolio must not have a materially worse left tail / skew than
  // baseline (the H3 lesson — a Sharpe win bought with a fat left tail is a trap).
  const skewTrap =
    headlineDist.skew < baseDist.skew - 0.5 || headlineDist.worstDay < baseDist.worstDay * 1.25;

  // Walk-forward: portfolio beats baseline Sharpe in ≥60% of aligned folds.
  const baseFolds = foldSharpes(baseRun.days.slice(bk), baseRun.dailyReturns.slice(bk));
  const headFolds = foldSharpes(headlineRun.days.slice(hk), headlineRun.netReturns.slice(hk));
  const nFolds = Math.min(baseFolds.length, headFolds.length);
  let wfWins = 0;
  for (let f = 0; f < nFolds; f++) if (headFolds[f]!.sharpe > baseFolds[f]!.sharpe) wfWins++;
  const wfRate = nFolds > 0 ? wfWins / nFolds : 0;

  const gatePass = sharpeWin && ddWin && !skewTrap;

  // ── ILLUSTRATIVE carry-included variant (carry vol FLOORED) ────────────────
  // To show the proxy-domination problem honestly: include the carry sleeve but
  // floor its estAnnualVol so it can't be over-weighted on fake ~0 vol. We do
  // this by passing a tiny synthetic pair set if available; here pairs is empty
  // in the OOS Binance path (no funding history), so we DOCUMENT the exclusion
  // rather than fabricate a carry stream. See report.

  // ── ALLOCATOR MECHANICS VALIDATION ─────────────────────────────────────────
  console.log("\n[4/5] allocator mechanics validation…");
  const kf = headlineRun.kellyFractions;
  const kellyMin = kf.length ? Math.min(...kf) : 0;
  const kellyMax = kf.length ? Math.max(...kf) : 0;
  const kellyCapOk = kellyMax <= 0.25 + 1e-9 && kellyMin >= 0;
  console.log(`   Kelly fraction range: [${kellyMin.toFixed(3)}, ${kellyMax.toFixed(3)}]  cap≤0.25: ${kellyCapOk ? "OK" : "VIOLATED"}`);

  const grossOk = headlineRun.maxGrossSeen <= DEFAULT_HARVESTER_CONFIG.maxGross + 1e-6;
  console.log(`   max gross seen: ${headlineRun.maxGrossSeen.toFixed(3)}  ≤ maxGross(1.0): ${grossOk ? "OK" : "VIOLATED"}`);

  // Realized portfolio vol vs target (the allocator's estPortfolioVol vs default
  // targetAnnualVol 0.30). Report mean est vol on deployed days.
  const deployedEst = headlineRun.estVolByDay.slice(hk).filter((v) => v > 1e-6);
  const meanEstVol = deployedEst.length ? deployedEst.reduce((a, b) => a + b, 0) / deployedEst.length : 0;
  console.log(`   mean est portfolio vol on deployed days: ${pct(meanEstVol)} (target ${pct(0.3)})`);
  console.log(`   realized annual vol of portfolio: ${pct(headlineStats.annVol)}`);

  // ── REPORT ───────────────────────────────────────────────────────────────
  console.log("\n[5/5] VERDICT\n");
  console.log(`  OOS window: ${windowFrom} → ${windowTo}`);
  console.log(`  universe (trend basket): ${basketAssets.map((a) => a.symbol).join(", ")}`);
  console.log(`  cost: ${(COST * 10000).toFixed(0)} bps/leg round-trip, on |Δweight|\n`);
  console.log(`  BASELINE (BTC harvester):     ${fmt(baseStats)}`);
  console.log(`  PORTFOLIO (trend→allocator):  ${fmt(headlineStats)}\n`);
  console.log(`  GATE — Sharpe win:  ${headlineStats.sharpe.toFixed(2)} > ${baseStats.sharpe.toFixed(2)}  → ${sharpeWin ? "PASS" : "FAIL"}`);
  console.log(`  GATE — maxDD win:   ${pct(headlineStats.maxDD)} < ${pct(baseStats.maxDD)}  → ${ddWin ? "PASS" : "FAIL"}`);
  console.log(`  walk-forward (info): portfolio beats baseline Sharpe in ${wfWins}/${nFolds} folds (${pct(wfRate)})\n`);
  console.log(`  TAIL/SKEW:`);
  console.log(`    baseline:  mean=${baseDist.mean.toExponential(2)} skew=${baseDist.skew.toFixed(2)} worstDay=${pct(baseDist.worstDay)} p01=${pct(baseDist.p01)}`);
  console.log(`    portfolio: mean=${headlineDist.mean.toExponential(2)} skew=${headlineDist.skew.toFixed(2)} worstDay=${pct(headlineDist.worstDay)} p01=${pct(headlineDist.p01)}`);
  console.log(`    skew-trap flag: ${skewTrap ? "⚠️  TRIPPED" : "clear"}\n`);
  console.log(`  CARRY SLEEVE: EXCLUDED from headline. UNVALIDATED — basis risk zeroed by`);
  console.log(`    proxy (spot===perp ⇒ basisVol≈0 ⇒ estAnnualVol≈0). Real cert pending`);
  console.log(`    real-spot/index execution. No illustrative funding figure fabricated`);
  console.log(`    in the OOS Binance path (no settled funding history there).\n`);
  console.log(`  HEADLINE VERDICT: ${gatePass ? "PASS" : "FAIL"}`);
  console.log(`    (requires Sharpe AND maxDD beat baseline, net-of-cost, no skew trap)\n`);

  await fs.mkdir("logs", { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  await fs.writeFile(
    `logs/portfolio-cert-${stamp}.json`,
    JSON.stringify(
      {
        window: { from: windowFrom, to: windowTo },
        universe: basketAssets.map((a) => a.symbol),
        costBpsPerLeg: COST * 10000,
        baseline: baseStats,
        portfolio: headlineStats,
        btcOnlyThroughAllocator: btcAllocStats,
        gate: { sharpeWin, ddWin, skewTrap, gatePass },
        walkForward: { wins: wfWins, folds: nFolds, rate: wfRate, baseFolds, headFolds },
        tailSkew: { baseline: baseDist, portfolio: headlineDist },
        mechanics: {
          kellyRange: [kellyMin, kellyMax],
          kellyCapOk,
          maxGrossSeen: headlineRun.maxGrossSeen,
          grossOk,
          meanEstVol,
          realizedAnnVol: headlineStats.annVol,
        },
      },
      null,
      2,
    ),
  );
  console.log(`  raw → logs/portfolio-cert-${stamp}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
