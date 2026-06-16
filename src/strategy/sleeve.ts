/**
 * Sleeve & PortfolioAllocator contract — the multi-premium portfolio
 * abstraction (epic CB-020, ADR-001). PURE TYPES ONLY: this file is an
 * interface/contract surface. It contains NO logic, NO implementation, NO
 * I/O — only `type`/`interface` declarations and the doc comments that bind
 * downstream implementers (CB-022 trend, CB-023 funding-carry, CB-024
 * allocator). See docs/ADR-001-multi-premium-portfolio.md for the rationale.
 *
 * ── C5 GUARDRAIL (do not remove) ──────────────────────────────────────────
 * This project formally buried taker-alpha (verdict "C5"). NOTHING in a Sleeve
 * predicts a single asset's forward return. A Sleeve harvests a STRUCTURAL
 * RISK PREMIUM:
 *   - Sleeve A (trend) = the certified beta harvester generalized; its value
 *     is breadth, crisis-alpha and drawdown-control, NOT per-asset prediction.
 *   - Sleeve B (funding-carry) = delta-neutral long-spot/short-perp capturing
 *     funding as a yield. It is NOT the buried "funding-rate-as-signal" probe.
 * Any PR that reintroduces a forward-return forecast violates this contract.
 *
 * ── NO-LOOK-AHEAD CONTRACT ────────────────────────────────────────────────
 * A sleeve decides its target at bar index `i` using ONLY market data through
 * `i` (inclusive). That target is held over (i, i+1] and earns the return
 * realized in that interval. Implementations must mirror harvester.ts:
 * weights at the close of i, return over (i, i+1]. The allocator inherits the
 * same rule — it scales targets emitted at i, never peeks at i+1.
 *
 * ── ONE-WAY DEPENDENCY RULE ───────────────────────────────────────────────
 * Sleeves and the allocator are PURE strategy modules. They MUST NOT import
 * from src/backtest/*. Data flows IN as plain arrays (this file's input
 * types); the backtest/walk-forward harness imports sleeves, never vice versa.
 */

import type { Candle } from "../analysis/indicators.js";

// ───────────────────────────────────────────────────────────────────────────
// Market-data inputs (what each sleeve is fed; backtest harness assembles it)
// ───────────────────────────────────────────────────────────────────────────

/**
 * One asset's oldest-first candle series on the portfolio's bar grid. Mirrors
 * harvester.ts `AssetSeries`. Sleeve A needs only this.
 */
export interface AssetCandles {
  /** Perp/spot instrument id, e.g. "BTC-USDT". */
  symbol: string;
  candles: readonly Candle[];
}

/**
 * One settled funding observation: `rate` was paid at `tMs` for holding the
 * perp through that settlement (per-cycle, e.g. 0.000332 = 0.0332% / 8h).
 * Positive = longs pay shorts (a short-perp leg EARNS it).
 */
export interface FundingPoint {
  /** Settlement timestamp, unix ms. */
  tMs: number;
  /** Per-cycle funding rate as a fraction (signed). */
  rate: number;
}

/**
 * Everything Sleeve B (delta-neutral funding-carry) needs for ONE pair:
 * spot candles, perp candles, and the settled funding history. The basis
 * (perp − spot) is DERIVED from the two candle series at bar i — it is not a
 * separate input — so no look-ahead basis can leak in.
 */
export interface FundingPairData {
  /** Logical pair id, e.g. "BTC" (legs are BTC-USDT spot + BTC-USDT-PERP). */
  pair: string;
  spot: AssetCandles;
  perp: AssetCandles;
  /** Oldest-first settled funding history for the perp leg. */
  funding: readonly FundingPoint[];
}

/**
 * The full market snapshot handed to a sleeve. A sleeve reads ONLY the fields
 * its kind requires (trend → `assets`; funding-carry → `pairs`). All series
 * are pre-aligned to one shared `grid` of unix-second day stamps so every
 * sleeve and the allocator speak the same bar index `i`.
 */
export interface MarketData {
  /** Shared sorted grid of bar timestamps (unix sec), oldest-first. */
  grid: readonly number[];
  /** Directional-sleeve inputs (Sleeve A). */
  assets: readonly AssetCandles[];
  /** Delta-neutral-pair inputs (Sleeve B). */
  pairs: readonly FundingPairData[];
}

// ───────────────────────────────────────────────────────────────────────────
// Unified target type — how "asset weights" and "delta-neutral pairs" reconcile
// ───────────────────────────────────────────────────────────────────────────

/**
 * A single tradeable leg the sleeve wants on the book at bar i.
 *
 * UNIFICATION: both sleeve kinds express their target as a list of legs in
 * NAV-fraction units (signed). A trend sleeve emits long-only legs
 * (`weight > 0`, one per held asset). A funding-carry sleeve emits BALANCED
 * leg PAIRS that net to ~0 directional exposure: a +w spot leg and a −w perp
 * leg sharing one `legGroup`. The allocator therefore never needs to know a
 * sleeve's internal mechanism — it sees a flat list of signed legs plus the
 * sleeve's own risk estimate. Gross/net exposure is computable from the legs;
 * delta-neutrality is the property `Σ weight over a legGroup ≈ 0`.
 */
export interface TargetLeg {
  /** Instrument id of THIS leg, e.g. "BTC-USDT" or "BTC-USDT-PERP". */
  symbol: string;
  /** "spot" | "perp" — informs financing/funding accounting downstream. */
  instrument: LegInstrument;
  /** Signed target as a fraction of sleeve NAV at bar i (+long, −short). */
  weight: number;
  /**
   * Groups legs that form one delta-neutral unit (e.g. the spot+perp of a
   * funding pair). Directional (trend) legs each get their own unique group
   * or may share the implicit single-leg group. Used by the allocator to
   * recognise hedged exposure and by accounting to net the pair.
   */
  legGroup: string;
}

/** Whether a leg trades the spot or the perpetual instrument. */
export type LegInstrument = "spot" | "perp";

/**
 * A sleeve's complete decision at bar index `i`: the target book PLUS the
 * forward risk/return ESTIMATES the allocator needs for sizing. All estimates
 * are conditioned on information through `i` only (no-look-ahead).
 *
 * NOTE on `expectedReturn`: this is a STRUCTURAL-PREMIUM estimate used solely
 * for risk-budgeting / fractional-Kelly sizing (e.g. trailing funding carry,
 * or a regime-conditioned beta premium). It is NOT a per-asset alpha forecast
 * and MUST NOT be derived from one (C5 guardrail). Sleeves that cannot honestly
 * estimate it should return a conservative constant, not a fitted prediction.
 */
export interface SleeveTarget {
  /** Bar index into MarketData.grid this decision was made at. */
  barIndex: number;
  /** Target legs (NAV-fraction units, signed). Empty = de-risked to cash. */
  legs: readonly TargetLeg[];
  /**
   * Annualized volatility the sleeve estimates for its OWN target book at i,
   * from info through i. The allocator's risk budget consumes this.
   */
  estAnnualVol: number;
  /**
   * Annualized expected STRUCTURAL premium of the target book (fraction).
   * Used only for fractional-Kelly fraction sizing; see NOTE above.
   */
  expectedReturn: number;
}

// ───────────────────────────────────────────────────────────────────────────
// The Sleeve interface — one shape for every premium
// ───────────────────────────────────────────────────────────────────────────

/** Discriminator for the two premium families in this epic. */
export type SleeveKind = "trend" | "funding-carry";

/**
 * A Sleeve is one uncorrelated risk-premium source. It is a PURE function of
 * market data: given the snapshot through bar `i`, it emits a target book +
 * risk/return estimates. It owns NO capital and NO portfolio-level sizing —
 * the PortfolioAllocator scales it. Stateless across calls: everything needed
 * to decide bar i is in `data` up to `i`.
 */
export interface Sleeve {
  /** Stable id, e.g. "trend-basket" / "funding-carry". */
  readonly id: string;
  /** Premium family. */
  readonly kind: SleeveKind;

  /**
   * Which instruments this sleeve may hold, so the allocator and execution
   * layer can pre-reserve symbols and detect cross-sleeve overlap. Derived
   * from config, independent of `i`.
   */
  universe(): readonly string[];

  /**
   * Decide the target book at bar index `i` using ONLY data through `i`.
   * Returns a de-risked (empty-legs) target when nothing is eligible. Must be
   * deterministic and side-effect free.
   */
  targetAt(data: MarketData, i: number): SleeveTarget;
}

// ───────────────────────────────────────────────────────────────────────────
// PortfolioAllocator — the sizing layer above the sleeves
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per-sleeve allocation decided by the allocator at bar i: the multiplier
 * applied to that sleeve's emitted legs, and the diagnostics behind it.
 */
export interface SleeveAllocation {
  sleeveId: string;
  /** Scalar ≥ 0 applied to every leg weight the sleeve emitted at i. */
  scale: number;
  /** Fractional-Kelly fraction used (∈ [kellyFractionMin, kellyFractionMax]). */
  kellyFraction: number;
  /** Risk-budget share (annual-vol contribution) granted to this sleeve. */
  riskBudgetShare: number;
}

/**
 * The allocator's portfolio-level decision at bar i: per-sleeve scales plus
 * the final merged book (all sleeves' scaled legs concatenated). The merged
 * book is what execution/paper-trading consumes.
 */
export interface AllocationResult {
  barIndex: number;
  allocations: readonly SleeveAllocation[];
  /** Final scaled, merged legs across all sleeves (NAV-fraction units). */
  book: readonly TargetLeg[];
  /** Estimated annualized portfolio vol after correlation-aware budgeting. */
  estPortfolioVol: number;
}

/**
 * Configuration for the allocator's risk layer. FRACTIONAL Kelly only — full
 * Kelly is forbidden (over-bets estimation error). The correlation matrix is
 * estimated from the sleeves' realized return streams through i (no-look-ahead).
 */
export interface AllocatorConfig {
  /** Target annualized portfolio vol (e.g. 0.30). */
  targetAnnualVol: number;
  /** Hard gross-exposure cap across all sleeves (de-risk only, never levered). */
  maxGross: number;
  /** Lower bound on the Kelly fraction (e.g. 0.10 = 10% Kelly). */
  kellyFractionMin: number;
  /** Upper bound on the Kelly fraction (e.g. 0.25 = 25% Kelly). NEVER 1.0. */
  kellyFractionMax: number;
  /** Trailing window (bars) for the inter-sleeve correlation estimate. */
  corrLookbackBars: number;
}

/**
 * Sizes and merges sleeves into one portfolio book. Sits ABOVE the sleeves:
 * it calls each `sleeve.targetAt(data, i)`, estimates the inter-sleeve
 * correlation from realized streams through i, applies a correlation-aware
 * risk budget + fractional Kelly, enforces `targetAnnualVol` and `maxGross`,
 * then concatenates the scaled legs. PURE: no I/O, no clocks, no randomness,
 * no import from src/backtest/*.
 */
export interface PortfolioAllocator {
  readonly config: AllocatorConfig;
  /** The sleeves under management (breadth = sleeves.length). */
  readonly sleeves: readonly Sleeve[];

  /**
   * Allocate at bar index `i` using only data through `i`. Returns per-sleeve
   * scales and the final merged book.
   */
  allocateAt(data: MarketData, i: number): AllocationResult;
}
