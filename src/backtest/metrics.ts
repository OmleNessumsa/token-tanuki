/**
 * Pure metrics layer for the backtest harness v2.
 *
 * No I/O, no clocks, no randomness. Inputs in → numbers out. The core engine
 * stays cost-blind and symbol-blind; this module bolts both back on top.
 *
 * Companion docs:
 * - docs/BACKTEST_HARNESS_V2_PRD.md §9.3-§9.4 (fees, slippage), §10 Q5 (applyCosts)
 * - docs/BACKTEST_V2_ARCHITECTURE.md §metrics.ts
 */

import type { BacktestStats, BacktestTrade } from "../analysis/backtest.js";

/** 5-minute bars: 288/day × 365 = 105,120 bars/year. */
const DEFAULT_BARS_PER_YEAR = 105_120;

export interface ExtendedStats extends BacktestStats {
  /** Annualized Sharpe of the per-trade R distribution. */
  sharpe: number;
  /** sum(wins) / |sum(losses)|; Infinity when no losses. */
  profitFactor: number;
  /** Echo of BacktestStats.maxDrawdownR for symmetry with downstream consumers. */
  maxDrawdownR: number;
  /** Largest single-symbol share of total signed R. 0..1. */
  topSymbolShare: number;
  /** Per-symbol breakdown for reporter consumption. */
  contributorBreakdown: Array<{ symbol: string; trades: number; totalR: number; share: number }>;
}

export interface ConcentrationReport {
  totalR: number;
  bySymbol: Array<{ symbol: string; totalR: number; share: number }>;
  /** True iff any |share| strictly greater than 0.50 (PRD kill-switch). */
  killSwitchTripped: boolean;
}

/**
 * Cost model for `applyCosts`. All values are fractions of notional per side:
 *   - feeRatePerSide 0.0006  = 6 bp = 0.06% taker (Blofin)
 *   - slippageRatePerSide 0.0001 = 1 bp entry, 1 bp exit
 */
export interface CostModel {
  feeRatePerSide: number;
  slippageRatePerSide: number;
}

/** Default cost model per PRD §9.3 + §9.4. Round-trip = 2*(0.06% + 0.01%) = 0.14% notional. */
export const DEFAULT_COST_MODEL: CostModel = {
  feeRatePerSide: 0.0006,
  slippageRatePerSide: 0.0001,
};

/**
 * Annualized Sharpe ratio of an R-multiple distribution.
 *
 * Treats each R observation as one "bar" of return (per-trade Sharpe is what
 * the reporter actually wants — we annualize using bars-per-year so the
 * number is directly comparable to a buy-and-hold Sharpe).
 *
 * Edge cases:
 *   - Empty input → 0 (not NaN).
 *   - All-zero or zero-variance input → 0 (not NaN, not Infinity).
 */
export function sharpe(rDistribution: readonly number[], barsPerYear: number = DEFAULT_BARS_PER_YEAR): number {
  if (rDistribution.length === 0) return 0;
  let sum = 0;
  for (const r of rDistribution) sum += r;
  const mean = sum / rDistribution.length;
  if (rDistribution.length < 2) return 0;
  let variance = 0;
  for (const r of rDistribution) {
    const diff = r - mean;
    variance += diff * diff;
  }
  // Sample stdev (n-1) for an unbiased estimator.
  variance /= rDistribution.length - 1;
  const stdev = Math.sqrt(variance);
  if (stdev === 0 || !Number.isFinite(stdev)) return 0;
  return (mean / stdev) * Math.sqrt(barsPerYear);
}

/**
 * Profit factor = sum(wins) / |sum(losses)|.
 *
 * Conventions:
 *   - rMultiple > 0  counts as win.
 *   - rMultiple <= 0 counts as loss.
 *   - All-wins → Infinity (architect-mandated; do NOT use a sentinel).
 *   - All-losses → 0.
 *   - Empty input → 0.
 */
export function profitFactor(trades: readonly BacktestTrade[]): number {
  if (trades.length === 0) return 0;
  let wins = 0;
  let losses = 0;
  for (const t of trades) {
    if (t.rMultiple > 0) wins += t.rMultiple;
    else losses += t.rMultiple; // accumulates as negative
  }
  const absLosses = Math.abs(losses);
  if (absLosses === 0) {
    return wins > 0 ? Infinity : 0;
  }
  return wins / absLosses;
}

/**
 * Per-symbol concentration breakdown.
 *
 * `share` is signed R / totalR — a symbol can have negative R and negative
 * share. The kill-switch trips on the absolute value: any single symbol
 * STRICTLY greater than 0.50 absolute share fails the gate.
 *
 * Edge cases:
 *   - Empty trades → totalR=0, bySymbol=[], killSwitchTripped=false.
 *   - Zero totalR with non-zero per-symbol R (wins offset losses) → share=0
 *     for every symbol; killSwitch stays false.
 */
export function symbolConcentration(
  trades: readonly (BacktestTrade & { symbol: string })[],
): ConcentrationReport {
  if (trades.length === 0) {
    return { totalR: 0, bySymbol: [], killSwitchTripped: false };
  }
  const sumBySymbol = new Map<string, number>();
  let totalR = 0;
  for (const t of trades) {
    sumBySymbol.set(t.symbol, (sumBySymbol.get(t.symbol) ?? 0) + t.rMultiple);
    totalR += t.rMultiple;
  }
  // Deterministic order — by symbol ascending — matches universe.ts tie-break convention.
  const sortedSymbols = Array.from(sumBySymbol.keys()).sort();
  const bySymbol = sortedSymbols.map((symbol) => {
    const symR = sumBySymbol.get(symbol)!;
    const share = totalR === 0 ? 0 : symR / totalR;
    return { symbol, totalR: symR, share };
  });
  // Kill-switch strictly > 0.50, NOT >= 0.50.
  const killSwitchTripped = bySymbol.some((b) => Math.abs(b.share) > 0.5);
  return { totalR, bySymbol, killSwitchTripped };
}

/**
 * Relative delta between in-sample and out-of-sample metrics.
 *
 *   |is - oos| / max(|is|, |oos|, 1e-9)
 *
 * Edge case: both inputs exactly 0 → returns 0 (not NaN). The 1e-9 floor
 * dominates only when both inputs are near-zero, in which case the absolute
 * difference is also near-zero, so the result rounds to 0.
 *
 * A value > 0.5 is the architect's red-flag threshold for overfitting.
 */
export function isOosDelta(is: number, oos: number): number {
  if (is === 0 && oos === 0) return 0;
  const denom = Math.max(Math.abs(is), Math.abs(oos), 1e-9);
  return Math.abs(is - oos) / denom;
}

/**
 * Bolt symbol-aware breakdown + Sharpe + profitFactor onto an existing
 * `BacktestStats` shape. Pure: derives every field from the inputs.
 */
export function extendStats(
  stats: BacktestStats,
  trades: readonly (BacktestTrade & { symbol: string })[],
): ExtendedStats {
  const conc = symbolConcentration(trades);
  // Largest absolute symbol share — the metric the kill-switch is gated on.
  let topAbs = 0;
  for (const b of conc.bySymbol) {
    const abs = Math.abs(b.share);
    if (abs > topAbs) topAbs = abs;
  }
  // Aggregate trades per symbol — same data as conc.bySymbol but with trade counts.
  const tradesPerSymbol = new Map<string, number>();
  for (const t of trades) {
    tradesPerSymbol.set(t.symbol, (tradesPerSymbol.get(t.symbol) ?? 0) + 1);
  }
  const contributorBreakdown = conc.bySymbol.map((b) => ({
    symbol: b.symbol,
    trades: tradesPerSymbol.get(b.symbol) ?? 0,
    totalR: b.totalR,
    share: b.share,
  }));

  return {
    ...stats,
    sharpe: sharpe(stats.rDistribution),
    profitFactor: profitFactor(trades),
    maxDrawdownR: stats.maxDrawdownR,
    topSymbolShare: topAbs,
    contributorBreakdown,
  };
}

/**
 * Post-trade cost adjustment per PRD §10 Q5.
 *
 * The core engine produces costless R-multiples. This transform deducts
 * round-trip fees + slippage as a fraction of the initial-risk price distance,
 * so the output `rMultiple` is what the strategy actually realizes net of
 * trading costs.
 *
 *   notionalEntry = entryPrice  (per 1 unit of base asset)
 *   notionalExit  = exitPrice
 *   roundTripCost = (entryPrice + exitPrice) * (feeRate + slippageRate)
 *   initialRisk   = |entryPrice - stopPrice|
 *   rDeduction    = roundTripCost / initialRisk
 *   netR          = rMultiple - rDeduction
 *
 * Direction-agnostic: the deduction is always a *cost* (positive subtracted),
 * regardless of LONG/SHORT. Initial risk in price units is symmetric on both
 * sides (the gap between entry and stop).
 *
 * Returns a NEW trade object — does not mutate the input.
 *
 * Edge case: zero initial risk (entry === stop) — degenerate trade, would
 * never have been emitted by the engine. We pass through unchanged rather
 * than dividing by zero.
 */
export function applyCosts(
  trade: BacktestTrade,
  costModel: CostModel = DEFAULT_COST_MODEL,
): BacktestTrade {
  const initialRisk = Math.abs(trade.entryPrice - trade.stopPrice);
  if (initialRisk === 0) return { ...trade };
  const perSideRate = costModel.feeRatePerSide + costModel.slippageRatePerSide;
  const roundTripCost = (trade.entryPrice + trade.exitPrice) * perSideRate;
  const rDeduction = roundTripCost / initialRisk;
  return {
    ...trade,
    rMultiple: trade.rMultiple - rDeduction,
  };
}
