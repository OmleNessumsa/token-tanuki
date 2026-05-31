/**
 * Leverage-aware trade plan generator (Phase 4 of futures pipeline).
 *
 * For 20× futures, your liquidation buffer is ~5% (1/leverage minus fees + funding).
 * That means stops MUST fit inside the liquidation budget — a "swing low" stop
 * that's 8% away will get you blown out before your idea has a chance to play out.
 *
 * Algorithm:
 *   1. Determine direction from analyzeFutures()
 *   2. Find structure-based stop (most recent swing low/high on relevant TF)
 *   3. Find ATR-based fallback stop
 *   4. Pick the TIGHTER of the two as preferred stop
 *   5. Validate it fits inside liquidation buffer (1/leverage - fee buffer)
 *   6. If not, propose a smaller leverage that does fit
 *   7. Compute targets: chart pattern target (if any), prior swing high(s), measured move
 *   8. Compute position size via Tharp % risk model, capped by leverage and liq distance
 *   9. Output trade card
 */

import type { FuturesAnalysis, TfAnalysis } from "../analyze-futures.js";
import type { Candle } from "./indicators.js";
import { atr, swings } from "./indicators.js";
import { sizeByPctRisk } from "./sizing.js";

export type TradePlanMode = "futures" | "spot";

export interface TradePlan {
  mode: TradePlanMode;
  side: "LONG" | "SHORT";
  /** Entry zone — limit-order range, not market price */
  entry: { ideal: number; max: number };
  stop: { price: number; distancePct: number; method: "structure" | "atr" | "liq-cap" | "floor" };
  /** Spot plans set this to a sentinel ({ price: 0, bufferPct: 100, usable: true }). */
  liquidation: { price: number; bufferPct: number; usable: boolean };
  targets: Array<{ price: number; rr: number; rationale: string }>;
  positionSizing: {
    notionalUsd: number;       // total position notional (margin × leverage)
    marginUsd: number;          // your actual at-risk margin (= notional on spot)
    units: number;              // base asset units
    leverageUsed: number;       // 1 on spot
    accountRiskPct: number;     // % of account at 1R
    accountRiskUsd: number;
  };
  invalidation: string[];
  warnings: string[];
}

export interface TradePlanInput {
  analysis: FuturesAnalysis;
  /** User's account size in USD (or USDC for spot Coinbase). */
  accountUsd: number;
  /** Requested leverage (e.g. 20). Ignored when mode='spot' (forced to 1). */
  leverage: number;
  /** "futures" (default) honors leverage and liquidation. "spot" forces lev=1, no liq, position-cap capped at spotMaxPositionPctOfEquity. */
  mode?: TradePlanMode;
  /** Tharp % risk per trade. Default 1%. For 20× futures be conservative — 0.5% recommended. */
  riskPctPerTrade?: number;
  /** Fee buffer subtracted from theoretical liquidation. Futures-only. */
  liqFeeBufferPct?: number;
  /** Spot-mode cap on notional as % of equity. Default 25 (no all-in trades). */
  spotMaxPositionPctOfEquity?: number;
  /**
   * Minimum stop distance as % of entry. If structure/ATR pick a tighter stop,
   * it gets widened to this floor. Default 0 (no floor — preserves legacy
   * behavior). Set to 1.5 on noisy 5m-scanner flows where sub-1% stops get
   * whipsawed by routine spread/wick noise before the thesis plays out.
   */
  minStopDistancePct?: number;
  /**
   * Maximum stop distance as % of entry. If structure/ATR pick a wider stop
   * the plan is **refused** (returns null). Default 0 (no cap). Set to ~4 on
   * scanner flows to skip post-pump entries where ATR explodes — entering a
   * long on a +20% coin with a 9% stop creates a 2-3R loss-budget hit that
   * destroys expectancy even with risk-normalized sizing.
   */
  maxStopDistancePct?: number;
}

const DEFAULTS = {
  riskPctPerTrade: 1,
  liqFeeBufferPct: 0.5,
  spotMaxPositionPctOfEquity: 25,
};

/**
 * Compute liquidation distance (as a % of entry price) for a given leverage.
 *
 * For an isolated long: liq when price drops by ~(1/leverage - fees) × entry.
 * For an isolated short: liq when price rises by similar amount.
 * Cross-margin can give more buffer but we conservatively assume isolated.
 */
function liquidationBufferPct(leverage: number, feeBufferPct: number): number {
  return (100 / leverage) - feeBufferPct;
}

function lastSwingLow(candles: readonly Candle[], lookback = 3): number | null {
  const sw = swings(candles, lookback).filter((s) => s.kind === "low");
  if (sw.length === 0) return null;
  return sw[sw.length - 1]!.price;
}

function lastSwingHigh(candles: readonly Candle[], lookback = 3): number | null {
  const sw = swings(candles, lookback).filter((s) => s.kind === "high");
  if (sw.length === 0) return null;
  return sw[sw.length - 1]!.price;
}

function pctDistance(from: number, to: number): number {
  return Math.abs((from - to) / from) * 100;
}

export function generateTradePlan(input: TradePlanInput): TradePlan | null {
  const { analysis, accountUsd } = input;
  const mode: TradePlanMode = input.mode ?? "futures";
  const requestedLeverage = mode === "spot" ? 1 : input.leverage;
  const riskPct = input.riskPctPerTrade ?? DEFAULTS.riskPctPerTrade;
  const feeBuffer = input.liqFeeBufferPct ?? DEFAULTS.liqFeeBufferPct;
  const spotPosCapPct = input.spotMaxPositionPctOfEquity ?? DEFAULTS.spotMaxPositionPctOfEquity;
  const warnings: string[] = [];
  const invalidation: string[] = [];

  if (!analysis.ticker || !analysis.perpSymbol) return null;
  if (analysis.verdict.side === "FLAT") return null;
  if (mode === "spot" && analysis.verdict.side === "SHORT") return null;

  const side = analysis.verdict.side;
  const currentPrice = analysis.ticker.lastPrice;
  const isLong = side === "LONG";

  // Use 1h timeframe for structure (Connors/Raschke standard for swing entries)
  const ltfTf: TfAnalysis | undefined = analysis.timeframes.find((t) => t.timeframe === "1h");
  const htfTf: TfAnalysis | undefined = analysis.timeframes.find((t) => t.timeframe === "4h");
  if (!ltfTf || !htfTf) return null;

  // Stop placement — try structure stop first
  const structurePrice = isLong
    ? lastSwingLow(ltfTf.candles, 3)
    : lastSwingHigh(ltfTf.candles, 3);

  // Validate structure stop is on the correct side. lastSwingLow can return
  // a price ABOVE current if price has dropped through a prior swing without
  // forming a new lower-low — in that case the swing low is stale and unusable
  // as a long stop. Same in reverse for short. Discard if on the wrong side.
  const validStructure =
    structurePrice !== null &&
    (isLong ? structurePrice < currentPrice : structurePrice > currentPrice);

  // ATR stop fallback
  const atrSeries = atr(ltfTf.candles, 14);
  const lastAtr = atrSeries[atrSeries.length - 1] ?? 0;
  const atrStopPrice = isLong
    ? currentPrice - 2 * lastAtr
    : currentPrice + 2 * lastAtr;

  // Pick the tighter (closer to entry) of the two — but only if structure passes the side check.
  let stopPrice: number;
  let stopMethod: TradePlan["stop"]["method"];
  if (validStructure && pctDistance(currentPrice, structurePrice!) < pctDistance(currentPrice, atrStopPrice)) {
    stopPrice = structurePrice!;
    stopMethod = "structure";
  } else {
    stopPrice = atrStopPrice;
    stopMethod = "atr";
  }

  // Belt-and-braces: a degenerate ATR (≤0) or other math edge case could leave
  // stopPrice on the wrong side of entry. Refuse to produce a plan in that case.
  if (isLong && stopPrice >= currentPrice) return null;
  if (!isLong && stopPrice <= currentPrice) return null;

  let stopDistancePct = pctDistance(currentPrice, stopPrice);

  // Maximum stop gate — refuse plans whose ATR/structure stop is past the cap.
  // Triggers on post-pump entries (price extended → ATR explodes → stop sits
  // 6-9% away). Even with risk-normalized sizing, those trades destroy
  // expectancy because mean-reversion eats the stop fast. Refuse rather than
  // clamp: a coin too volatile for our risk-budget shouldn't be traded.
  const maxStopPct = input.maxStopDistancePct ?? 0;
  if (maxStopPct > 0 && stopDistancePct > maxStopPct) {
    return null;
  }

  // Minimum stop floor — widens noise-distance stops (sub-1% on volatile alts
  // gets eaten by routine wicks before the move resolves). Applied BEFORE the
  // liq-cap check so a too-wide floor still triggers leverage reduction.
  const minStopPct = input.minStopDistancePct ?? 0;
  if (minStopPct > 0 && stopDistancePct < minStopPct) {
    const flooredStopPrice = isLong
      ? currentPrice * (1 - minStopPct / 100)
      : currentPrice * (1 + minStopPct / 100);
    warnings.push(
      `${stopMethod} stop ${stopDistancePct.toFixed(2)}% < min ${minStopPct.toFixed(2)}% — widened to floor`,
    );
    stopPrice = flooredStopPrice;
    stopDistancePct = minStopPct;
    stopMethod = "floor";
  }

  // Liquidation budget check (futures-only — spot has no liquidation)
  let leverage = requestedLeverage;
  let liqBufferPct = liquidationBufferPct(leverage, feeBuffer);

  if (mode === "futures" && stopDistancePct >= liqBufferPct) {
    // Stop won't fit. Either use a tighter (liq-cap) stop, or reduce leverage.
    // Strategy: cap stop at 80% of liq buffer (so we don't ride to liquidation)
    const safeStopDistPct = liqBufferPct * 0.8;
    const safeStopPrice = isLong
      ? currentPrice * (1 - safeStopDistPct / 100)
      : currentPrice * (1 + safeStopDistPct / 100);

    // Check if we can keep leverage with a tighter stop
    if (safeStopDistPct >= 1.0) {
      // OK to use the tighter stop at requested leverage
      warnings.push(`Structure stop ${stopDistancePct.toFixed(2)}% > liq buffer ${liqBufferPct.toFixed(2)}% — capping stop to ${safeStopDistPct.toFixed(2)}% (within 80% of liq)`);
      stopPrice = safeStopPrice;
      stopDistancePct = safeStopDistPct;
      stopMethod = "liq-cap";
    } else {
      // Liq buffer too tight even for capped stop — propose lower leverage
      const requiredBuffer = stopDistancePct + feeBuffer + 1;
      const newLeverage = Math.floor(100 / requiredBuffer);
      warnings.push(`Stop ${stopDistancePct.toFixed(2)}% requires lower leverage. Reducing from ${requestedLeverage}× → ${newLeverage}× to fit.`);
      leverage = Math.max(1, newLeverage);
      liqBufferPct = liquidationBufferPct(leverage, feeBuffer);
    }
  }

  // Compute liquidation price at chosen leverage. Spot has no liquidation —
  // emit a sentinel so consumers can detect (and so the CLI can skip the row).
  const liqDistance = liqBufferPct;
  const liqPrice = mode === "spot"
    ? 0
    : isLong
      ? currentPrice * (1 - liqDistance / 100)
      : currentPrice * (1 + liqDistance / 100);

  // Position cap: futures uses leverage as multiplier; spot caps a single trade
  // at spotMaxPositionPctOfEquity (default 25% — no all-in trades) since 100%
  // would force minute-stop trades to under-risk silently.
  const maxPositionPctOfEquity = mode === "spot" ? spotPosCapPct : leverage * 100;

  const sizing = sizeByPctRisk({
    equityUsd: accountUsd,
    entryPrice: currentPrice,
    stopPrice,
    riskPctOfEquity: riskPct,
    maxPositionPctOfEquity,
  });
  const units = sizing.positionUnits;
  const notional = units * currentPrice;
  const marginRequired = mode === "spot" ? notional : notional / leverage;

  if (mode === "spot") {
    const cappedNotional = (spotPosCapPct / 100) * accountUsd;
    if (notional >= cappedNotional - 0.01 && notional > 0) {
      const wouldHaveRisked = (accountUsd * riskPct) / 100;
      const actuallyRisks = notional * (stopDistancePct / 100);
      if (actuallyRisks < wouldHaveRisked - 0.01) {
        warnings.push(
          `Position-cap (${spotPosCapPct}% of equity) bound — actual risk ` +
            `${actuallyRisks.toFixed(2)} < requested 1R risk ${wouldHaveRisked.toFixed(2)}. ` +
            `Stop is tighter than the cap permits full risk; raise spotMaxPositionPctOfEquity to allow full risk.`,
        );
      }
    }
  }

  // Targets: prior swing high(s) for longs / lows for shorts on 4h, plus measured move from chart pattern if any
  const targets: TradePlan["targets"] = [];
  const r = Math.abs(currentPrice - stopPrice);

  // Target 1: prior 4h swing extreme (most immediate)
  const t1Price = isLong ? lastSwingHigh(htfTf.candles, 5) : lastSwingLow(htfTf.candles, 5);
  if (t1Price !== null && ((isLong && t1Price > currentPrice) || (!isLong && t1Price < currentPrice))) {
    targets.push({
      price: t1Price,
      rr: Math.abs(t1Price - currentPrice) / r,
      rationale: "Prior 4h swing extreme",
    });
  }

  // Target 2: 4h chart pattern target — must be on the correct side AND R:R >= 1
  const patternHit = htfTf.chart.chartPatterns.find((p) => {
    if (!p.target) return false;
    if (isLong && (!p.bullish || p.target <= currentPrice)) return false;
    if (!isLong && (p.bullish || p.target >= currentPrice)) return false;
    const rr = Math.abs(p.target - currentPrice) / r;
    return rr >= 1; // pattern target must offer at least 1R
  });
  if (patternHit?.target) {
    targets.push({
      price: patternHit.target,
      rr: Math.abs(patternHit.target - currentPrice) / r,
      rationale: `${patternHit.pattern} measured move`,
    });
  }

  // Target 3: 2R (mechanical fallback)
  const t2R = isLong ? currentPrice + 2 * r : currentPrice - 2 * r;
  targets.push({ price: t2R, rr: 2, rationale: "Mechanical 2R" });

  // Validate any swing/pattern target offered R:R >= 1.5; otherwise discard low-quality targets
  const goodTargets = targets.filter((t) => t.rr >= 1.0);
  targets.length = 0;
  targets.push(...goodTargets);
  targets.sort((a, b) => a.rr - b.rr);

  // Validate at least one target ≥ 2R
  if (!targets.some((t) => t.rr >= 2)) {
    warnings.push("No target ≥ 2R available — setup R:R is unfavorable, consider skipping");
  }

  // Account-level risk computation
  const accountRiskUsd = (riskPct / 100) * accountUsd;

  // Invalidation rules
  invalidation.push(`Close below ${isLong ? "stop" : "stop"} $${stopPrice.toFixed(4)} (${stopDistancePct.toFixed(2)}% ${isLong ? "below" : "above"} entry)`);
  if (analysis.confluence.htfDirection !== (isLong ? "bullish" : "bearish")) {
    invalidation.push(`HTF flip to ${isLong ? "bearish" : "bullish"} on 4h close`);
  }
  if (analysis.intermarket.regime === "neutral" || analysis.intermarket.regime === "unknown") {
    invalidation.push("BTC drops >3% — close all alt longs regardless");
  }

  // Final entry zone — current price ± 0.5% for limit orders
  const entryIdeal = currentPrice;
  const entryMax = isLong ? currentPrice * 1.005 : currentPrice * 0.995;

  return {
    mode,
    side,
    entry: { ideal: entryIdeal, max: entryMax },
    stop: { price: stopPrice, distancePct: stopDistancePct, method: stopMethod },
    liquidation:
      mode === "spot"
        ? { price: 0, bufferPct: 100, usable: true }
        : { price: liqPrice, bufferPct: liqBufferPct, usable: stopDistancePct < liqBufferPct },
    targets,
    positionSizing: {
      notionalUsd: notional,
      marginUsd: marginRequired,
      units,
      leverageUsed: leverage,
      accountRiskPct: riskPct,
      accountRiskUsd,
    },
    invalidation,
    warnings,
  };
}
