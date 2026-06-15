/**
 * Risk-managed beta harvester — the strategy validated in Fase 0+1
 * (docs/CRYPTOTRADER_BUILD_PLAN.md §13-16).
 *
 * NOT alpha. This captures crypto beta (the trend / right skew that IS the
 * return of this market) with drawdown control, via:
 *   - a moving-average regime filter (hold only when price > MA),
 *   - inverse-volatility weighting across held assets,
 *   - a portfolio volatility target with a gross cap (long-only, de-risk
 *     only — never levered).
 *
 * Validated out-of-sample on 2018-2026 (9.23x vs 4.77x buy-hold BTC, maxDD
 * 32% vs 81%). The mechanism is the trend-overlay-on-a-risky-asset effect
 * (Faber 2007; Moskowitz-Ooi-Pedersen 2012), the most documented result in
 * tactical asset allocation — not a crypto data-mine.
 *
 * PURE module. No I/O, no clocks, no randomness. The ONLY dependency is the
 * `Candle` type + `sma` from analysis/indicators. It does NOT import from
 * src/backtest/* (one-way dep rule), and the stats below are inlined rather
 * than reusing backtest/metrics to keep this module standalone.
 *
 * NO-LOOK-AHEAD CONTRACT: weights are decided at the close of grid position
 * i using only information through position i (vol over the trailing window,
 * price vs MA at i), and they earn the return realized over (i, i+1]. This
 * is enforced structurally in `simulateHarvester` and covered by tests.
 */

import type { Candle } from "../analysis/indicators.js";

const ANNUALIZATION = Math.sqrt(365); // daily bars → annualized

export interface HarvesterConfig {
  /** Realized-vol window in bars (e.g. 30). */
  volLookbackDays: number;
  /** MA regime filter period in bars (e.g. 100). 0 disables the filter. */
  regimeMaPeriodDays: number;
  /** Target annualized portfolio vol (e.g. 0.40 = 40%). */
  targetAnnualVol: number;
  /** Max gross exposure (e.g. 1.0 = no leverage, de-risk only). */
  maxGross: number;
  /** Rebalance cadence in bars (e.g. 1 = daily, 7 = weekly). */
  rebalanceEveryDays: number;
  /** Round-trip cost per leg as a fraction (e.g. 0.0014 = 14bps). */
  costPerLegRoundTrip: number;
}

/** Parameters frozen after the Fase-0/1 cert. Doctrine: MA 50-150, tvol 0.30-0.40. */
export const DEFAULT_HARVESTER_CONFIG: HarvesterConfig = {
  volLookbackDays: 30,
  regimeMaPeriodDays: 100,
  targetAnnualVol: 0.4,
  maxGross: 1.0,
  rebalanceEveryDays: 1,
  costPerLegRoundTrip: 0.0014,
};

/** One asset's daily, oldest-first candle series. */
export interface AssetSeries {
  symbol: string;
  candles: readonly Candle[];
}

export interface HarvesterResult {
  /** Unix-second timestamp per portfolio return day (= grid[1..]). */
  days: number[];
  /** Net-of-cost portfolio return for each day in `days`. */
  dailyReturns: number[];
  /** Target weights in force during each day (set at the prior close). */
  weightsByDay: Array<Record<string, number>>;
  /** Fraction of book turned over at each day's rebalance (0 if none). */
  turnoverByDay: number[];
  /** First index in `days` that is past warmup (stats should start here). */
  warmupEndIndex: number;
}

/** Build a master sorted grid of unique day-timestamps (unix sec) + per-symbol
 *  close aligned to that grid (undefined where a symbol has no bar). */
function alignToGrid(series: readonly AssetSeries[]): {
  grid: number[];
  closes: Map<string, (number | undefined)[]>;
} {
  const daySet = new Set<number>();
  for (const a of series) for (const c of a.candles) daySet.add(c.t);
  const grid = [...daySet].sort((x, y) => x - y);
  const pos = new Map<number, number>();
  grid.forEach((d, i) => pos.set(d, i));
  const closes = new Map<string, (number | undefined)[]>();
  for (const a of series) {
    const arr = new Array<number | undefined>(grid.length).fill(undefined);
    for (const c of a.candles) {
      if (c.c > 0) arr[pos.get(c.t)!] = c.c;
    }
    closes.set(a.symbol, arr);
  }
  return { grid, closes };
}

/** Log return for a symbol over (grid[i-1], grid[i]]; undefined if either close missing. */
function logRet(close: (number | undefined)[], i: number): number | undefined {
  const a = close[i - 1];
  const b = close[i];
  return a !== undefined && b !== undefined ? Math.log(b / a) : undefined;
}

/** Annualized realized vol from the `lookback` daily log returns ending at i
 *  (inclusive). Undefined if any return in the window is missing. */
export function realizedAnnVol(close: (number | undefined)[], i: number, lookback: number): number | undefined {
  if (i - lookback < 0) return undefined;
  const r: number[] = [];
  for (let k = i - lookback + 1; k <= i; k++) {
    const v = logRet(close, k);
    if (v === undefined) return undefined;
    r.push(v);
  }
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? sd * ANNUALIZATION : undefined;
}

/** True if close[i] > SMA(period) ending at i. Undefined if window incomplete. */
export function aboveRegime(close: (number | undefined)[], i: number, period: number): boolean | undefined {
  if (period <= 0) return true; // filter disabled
  const c = close[i];
  if (c === undefined || i - period + 1 < 0) return undefined;
  let sum = 0;
  let n = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const v = close[k];
    if (v === undefined) return undefined;
    sum += v;
    n++;
  }
  return c > sum / n;
}

/**
 * Target weights at grid position i, using only info through i. Inverse-vol
 * across assets that are (a) in-regime and (b) have a defined vol, scaled so
 * the (correlation≈1 stress) book-vol estimate hits the target, capped at
 * maxGross. Returns {} when nothing is eligible (→ flat / de-risked to cash).
 */
export function targetWeights(
  closes: Map<string, (number | undefined)[]>,
  i: number,
  config: HarvesterConfig,
): Record<string, number> {
  const elig: { sym: string; vol: number }[] = [];
  for (const [sym, close] of closes) {
    const vol = realizedAnnVol(close, i, config.volLookbackDays);
    if (vol === undefined) continue;
    const up = aboveRegime(close, i, config.regimeMaPeriodDays);
    if (up !== true) continue;
    elig.push({ sym, vol });
  }
  const out: Record<string, number> = {};
  if (elig.length === 0) return out;
  const sumInv = elig.reduce((a, e) => a + 1 / e.vol, 0);
  // Conservative book-vol proxy: weighted-average single-name vol (assumes
  // correlation ~1 in stress). De-risks the book, never over-levers.
  const bookVol = elig.reduce((a, e) => a + (1 / e.vol / sumInv) * e.vol, 0);
  const scale = Math.min(config.maxGross, config.targetAnnualVol / bookVol);
  for (const e of elig) out[e.sym] = (1 / e.vol / sumInv) * scale;
  return out;
}

/**
 * Simulate the harvester over the aligned series. Pure. Weights set at the
 * close of position i (info through i) earn the return over (i, i+1]; cost is
 * charged on |Δweight| at each rebalance.
 */
export function simulateHarvester(
  series: readonly AssetSeries[],
  config: HarvesterConfig = DEFAULT_HARVESTER_CONFIG,
): HarvesterResult {
  const { grid, closes } = alignToGrid(series);
  const days: number[] = [];
  const dailyReturns: number[] = [];
  const weightsByDay: Array<Record<string, number>> = [];
  const turnoverByDay: number[] = [];

  let weights: Record<string, number> = {};
  for (let i = 1; i < grid.length; i++) {
    // Realize the weights set at i-1 against the return over (i-1, i].
    let portRet = 0;
    for (const [sym, w] of Object.entries(weights)) {
      const r = logRet(closes.get(sym)!, i);
      if (r !== undefined) portRet += w * (Math.exp(r) - 1);
    }

    // Decide new weights at position i (info through i) for the next step.
    let turnover = 0;
    if ((i - 1) % config.rebalanceEveryDays === 0) {
      const newW = targetWeights(closes, i, config);
      const syms = new Set([...Object.keys(weights), ...Object.keys(newW)]);
      for (const s of syms) turnover += Math.abs((newW[s] ?? 0) - (weights[s] ?? 0));
      portRet -= turnover * config.costPerLegRoundTrip;
      weights = newW;
    }

    days.push(grid[i]!);
    dailyReturns.push(portRet);
    weightsByDay.push(weights);
    turnoverByDay.push(turnover);
  }

  // Warmup = first position at which weights could be non-zero.
  const warmup = Math.max(config.volLookbackDays, config.regimeMaPeriodDays) + 1;
  return { days, dailyReturns, weightsByDay, turnoverByDay, warmupEndIndex: Math.min(warmup, days.length) };
}

/** Today's target weights + the closing prices they were computed at. */
export interface LiveSignal {
  /** Signal bar timestamp (unix ms) — the latest aligned grid day. */
  dayMs: number;
  weights: Record<string, number>;
  prices: Record<string, number>;
}

/**
 * Compute the target weights for the MOST RECENT aligned bar. The caller is
 * responsible for passing only CLOSED bars (drop the still-forming day) so
 * the signal has no look-ahead. Reuses the exact certified path
 * (alignToGrid + targetWeights) — live trading runs the same code the
 * backtest certified. Returns null if there are no bars.
 */
export function latestSignal(series: readonly AssetSeries[], config: HarvesterConfig = DEFAULT_HARVESTER_CONFIG): LiveSignal | null {
  const { grid, closes } = alignToGrid(series);
  if (grid.length === 0) return null;
  const i = grid.length - 1;
  const weights = targetWeights(closes, i, config);
  const prices: Record<string, number> = {};
  for (const [sym, arr] of closes) {
    const p = arr[i];
    if (p !== undefined) prices[sym] = p;
  }
  return { dayMs: grid[i]! * 1000, weights, prices };
}

export interface YearStat {
  year: number;
  ret: number;
}

export interface HarvesterStats {
  nDays: number;
  sharpe: number;
  cagr: number;
  annVol: number;
  maxDD: number;
  finalEquity: number;
  meanTurnover: number;
  byYear: YearStat[];
}

/** Cert statistics over a net daily-return series. `days` are unix-sec stamps. */
export function harvesterStats(
  dailyReturns: readonly number[],
  days: readonly number[],
  turnover: readonly number[] = [],
): HarvesterStats {
  const n = dailyReturns.length;
  if (n < 2) {
    return { nDays: n, sharpe: 0, cagr: 0, annVol: 0, maxDD: 0, finalEquity: 1, meanTurnover: 0, byYear: [] };
  }
  const eq: number[] = [1];
  for (const r of dailyReturns) eq.push(eq[eq.length - 1]! * (1 + r));
  let peak = eq[0]!;
  let maxDD = 0;
  for (const e of eq) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(dailyReturns.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const sharpe = sd > 0 ? (mean / sd) * ANNUALIZATION : 0;
  const finalEquity = eq[eq.length - 1]!;
  const years = n / 365;
  const cagr = years > 0 ? finalEquity ** (1 / years) - 1 : 0;
  const yearMap = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const y = new Date(days[i]! * 1000).getUTCFullYear();
    yearMap.set(y, (yearMap.get(y) ?? 0) + Math.log(1 + dailyReturns[i]!));
  }
  const byYear = [...yearMap.entries()].map(([year, lr]) => ({ year, ret: Math.exp(lr) - 1 })).sort((a, b) => a.year - b.year);
  return {
    nDays: n,
    sharpe,
    cagr,
    annVol: sd * ANNUALIZATION,
    maxDD,
    finalEquity,
    meanTurnover: turnover.length ? turnover.reduce((a, b) => a + b, 0) / turnover.length : 0,
    byYear,
  };
}

export interface CertGates {
  minSharpe: number;
  maxMaxDD: number;
  /** No single calendar year worse than this (e.g. -0.25). */
  worstYearFloor: number;
}

export const DEFAULT_CERT_GATES: CertGates = {
  minSharpe: 1.0,
  maxMaxDD: 0.35,
  worstYearFloor: -0.25,
};

export interface CertCheck {
  name: string;
  pass: boolean;
  detail: string;
  /** Required checks gate the verdict; informational ones are context only. */
  required: boolean;
}

export interface CertVerdict {
  pass: boolean;
  checks: CertCheck[];
}

/**
 * Apply cert gates to harvester stats vs a benchmark (e.g. buy-hold BTC).
 *
 * The verdict gates on RISK-ADJUSTED criteria only (Sharpe, absolute maxDD,
 * maxDD vs benchmark, worst-year floor). Raw "CAGR ≥ benchmark" is reported
 * as INFORMATIONAL, not gating — a risk-managed overlay trails raw buy-hold
 * in bull-heavy windows by design (it cedes upside for bear protection) and
 * wins over full cycles via drawdown avoidance. Gating on raw return over a
 * sub-cycle window would penalize the strategy for exactly its purpose; see
 * the documented Gate-B lesson (CRYPTOTRADER_BUILD_PLAN.md §15). The
 * full-cycle OOS run (§15: 9.23x vs 4.77x) is where raw return is judged.
 */
export function certify(stats: HarvesterStats, benchmark: HarvesterStats, gates: CertGates = DEFAULT_CERT_GATES): CertVerdict {
  const worstYear = stats.byYear.reduce((m, y) => Math.min(m, y.ret), Infinity);
  const checks: CertCheck[] = [
    { name: "Sharpe", pass: stats.sharpe >= gates.minSharpe, detail: `${stats.sharpe.toFixed(2)} ≥ ${gates.minSharpe}`, required: true },
    { name: "maxDD", pass: stats.maxDD < gates.maxMaxDD, detail: `${(stats.maxDD * 100).toFixed(0)}% < ${(gates.maxMaxDD * 100).toFixed(0)}%`, required: true },
    { name: "maxDD<bench", pass: stats.maxDD < benchmark.maxDD, detail: `${(stats.maxDD * 100).toFixed(0)}% < ${(benchmark.maxDD * 100).toFixed(0)}%`, required: true },
    { name: "worst year", pass: worstYear >= gates.worstYearFloor, detail: `${(worstYear * 100).toFixed(0)}% ≥ ${(gates.worstYearFloor * 100).toFixed(0)}%`, required: true },
    { name: "CAGR vs bench (info)", pass: stats.cagr >= benchmark.cagr, detail: `${(stats.cagr * 100).toFixed(0)}% vs ${(benchmark.cagr * 100).toFixed(0)}% — expected to trail in bull windows`, required: false },
  ];
  return { pass: checks.filter((c) => c.required).every((c) => c.pass), checks };
}
