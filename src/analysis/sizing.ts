/**
 * Position sizing & expectancy.
 * Source: Van K. Tharp, "Trade Your Way to Financial Freedom" (2nd ed., McGraw-Hill 2007)
 *   - Position sizing as the most important variable after exit strategy
 *   - R-multiples and expectancy formula
 *   - Four sizing models: fixed-amount, equal units, % risk, % volatility
 */

import { atr } from "./indicators.js";
import type { Candle } from "./indicators.js";

export interface TradeOutcome {
  /** R = profit_or_loss / initial_risk_dollars */
  rMultiple: number;
}

export interface ExpectancyStats {
  trades: number;
  winRate: number;       // 0..1
  lossRate: number;
  avgWinR: number;
  avgLossR: number;      // always negative
  expectancy: number;    // R per trade — must be > 0 to have edge after fees
  payoffRatio: number;   // |avg_win_R / avg_loss_R|
  rOfWorstLoss: number;
  rOfBestWin: number;
}

/** E = (win% × avg_win_R) − (loss% × avg_loss_R). Positive expectancy = real edge. */
export function expectancy(trades: readonly TradeOutcome[]): ExpectancyStats {
  if (trades.length === 0) {
    return { trades: 0, winRate: 0, lossRate: 0, avgWinR: 0, avgLossR: 0, expectancy: 0, payoffRatio: 0, rOfWorstLoss: 0, rOfBestWin: 0 };
  }
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple <= 0);
  const winRate = wins.length / trades.length;
  const lossRate = losses.length / trades.length;
  const avgWinR = wins.length === 0 ? 0 : wins.reduce((a, t) => a + t.rMultiple, 0) / wins.length;
  const avgLossR = losses.length === 0 ? 0 : losses.reduce((a, t) => a + t.rMultiple, 0) / losses.length;
  const expectancyR = winRate * avgWinR + lossRate * avgLossR; // avgLossR already ≤ 0
  return {
    trades: trades.length,
    winRate,
    lossRate,
    avgWinR,
    avgLossR,
    expectancy: expectancyR,
    payoffRatio: avgLossR === 0 ? Infinity : Math.abs(avgWinR / avgLossR),
    rOfWorstLoss: Math.min(...trades.map((t) => t.rMultiple)),
    rOfBestWin: Math.max(...trades.map((t) => t.rMultiple)),
  };
}

export interface SizingInput {
  equityUsd: number;
  entryPrice: number;
  stopPrice: number;
  /** Default 1% per Tharp; for crypto small-caps use 0.25-0.5%. */
  riskPctOfEquity?: number;
  /** Optional cap to prevent ridiculous sizes on tiny stops. */
  maxPositionPctOfEquity?: number;
}

export interface SizingOutput {
  positionUsd: number;
  positionUnits: number;
  riskUsd: number;          // initial 1R in dollars
  rPriceDistance: number;   // |entry - stop|
  warnings: string[];
}

/**
 * Tharp Model 3: % Risk position sizing.
 * positionUnits = (equity × risk%) / |entry - stop|
 */
export function sizeByPctRisk(input: SizingInput): SizingOutput {
  const warnings: string[] = [];
  const riskPct = (input.riskPctOfEquity ?? 1) / 100;
  const distance = Math.abs(input.entryPrice - input.stopPrice);
  if (distance === 0) {
    return { positionUsd: 0, positionUnits: 0, riskUsd: 0, rPriceDistance: 0, warnings: ["entry == stop, cannot size"] };
  }
  if (input.entryPrice <= 0 || input.equityUsd <= 0) {
    return { positionUsd: 0, positionUnits: 0, riskUsd: 0, rPriceDistance: distance, warnings: ["non-positive equity or price"] };
  }
  const riskUsd = input.equityUsd * riskPct;
  const units = riskUsd / distance;
  let positionUsd = units * input.entryPrice;
  const cap = (input.maxPositionPctOfEquity ?? 100) / 100 * input.equityUsd;
  if (positionUsd > cap) {
    warnings.push(`position $${positionUsd.toFixed(0)} exceeds cap $${cap.toFixed(0)} (risk distance very tight) — clamped`);
    positionUsd = cap;
  }
  if (riskPct > 0.02) warnings.push(`risk % ${(riskPct * 100).toFixed(2)}% above Tharp's 2% maximum`);
  return { positionUsd, positionUnits: positionUsd / input.entryPrice, riskUsd, rPriceDistance: distance, warnings };
}

export interface VolSizingInput {
  equityUsd: number;
  entryPrice: number;
  /** Volatility risk %. Tharp's example: 2%. For crypto small-caps: 0.5-1%. */
  volPctOfEquity?: number;
  candles: readonly Candle[];
  atrPeriod?: number;
}

/**
 * Tharp Model 4: % Volatility position sizing.
 * positionUnits = (equity × vol%) / ATR(N)
 */
export function sizeByVolatility(input: VolSizingInput): SizingOutput & { atr: number } {
  const period = input.atrPeriod ?? 14;
  const atrSeries = atr(input.candles, period);
  const lastAtr = atrSeries[atrSeries.length - 1] ?? 0;
  if (lastAtr <= 0 || input.equityUsd <= 0 || input.entryPrice <= 0) {
    return { positionUsd: 0, positionUnits: 0, riskUsd: 0, rPriceDistance: 0, warnings: ["insufficient candles or invalid equity/price"], atr: lastAtr };
  }
  const volPct = (input.volPctOfEquity ?? 1) / 100;
  const riskUsd = input.equityUsd * volPct;
  const units = riskUsd / lastAtr;
  return {
    positionUsd: units * input.entryPrice,
    positionUnits: units,
    riskUsd,
    rPriceDistance: lastAtr,
    warnings: [],
    atr: lastAtr,
  };
}

/**
 * Stop placement helpers.
 *
 * structureStop:
 *   For longs: most recent swing low − k × ATR buffer
 *   For shorts: most recent swing high + k × ATR buffer
 *
 * atrStop:
 *   For longs: entry − k × ATR. k=1.5..3 typical.
 */
export function atrStop(entryPrice: number, atrValue: number, k = 2, side: "long" | "short" = "long"): number {
  return side === "long" ? entryPrice - k * atrValue : entryPrice + k * atrValue;
}

export function structureStop(swingLevel: number, atrValue: number, side: "long" | "short" = "long", bufferAtr = 0.5): number {
  return side === "long" ? swingLevel - bufferAtr * atrValue : swingLevel + bufferAtr * atrValue;
}

export interface SuggestedTrade {
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskRewardRatio: number;
  positionSize: SizingOutput;
}

/**
 * Compose a full trade plan: entry, stop, target, R:R, sizing.
 * Reject (return null) if R:R < minimumRR (Tharp: ≥2:1).
 */
export function planTrade(args: {
  equityUsd: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskPctOfEquity?: number;
  minimumRR?: number;
}): SuggestedTrade | null {
  const minRR = args.minimumRR ?? 2;
  const risk = Math.abs(args.entryPrice - args.stopPrice);
  const reward = Math.abs(args.targetPrice - args.entryPrice);
  if (risk === 0) return null;
  const rr = reward / risk;
  if (rr < minRR) return null;
  return {
    entryPrice: args.entryPrice,
    stopPrice: args.stopPrice,
    targetPrice: args.targetPrice,
    riskRewardRatio: rr,
    positionSize: sizeByPctRisk({
      equityUsd: args.equityUsd,
      entryPrice: args.entryPrice,
      stopPrice: args.stopPrice,
      riskPctOfEquity: args.riskPctOfEquity,
    }),
  };
}
