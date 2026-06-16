/**
 * Sleeve A — multi-asset time-series trend (ticket CB-022, epic CB-020).
 *
 * This is the CERTIFIED beta harvester (`src/strategy/harvester.ts`)
 * GENERALIZED to an N-asset universe and re-expressed as the `Sleeve`
 * contract. It does NOT reimplement the harvester: every weight it emits comes
 * straight out of the harvester's frozen, certified `targetWeights` path
 * (inverse-vol weighting + MA regime filter + portfolio vol-target + gross
 * cap, long-only, de-risk only). The sleeve only RESHAPES that output into the
 * unified `TargetLeg[]` form and supplies the two risk/return estimates the
 * allocator needs.
 *
 * ── C5 GUARDRAIL (binding; see ADR-001 §"C5 Guardrail") ───────────────────────
 * Nothing here forecasts a single asset's forward return. Cert CB-017 already
 * proved single-asset TSMOM is repackaged beta, so this sleeve's value is
 * BREADTH + crisis-alpha + drawdown-control across the basket, never per-name
 * prediction. The `expectedReturn` field is a STRUCTURAL regime-conditioned
 * beta-premium estimate used solely for fractional-Kelly sizing — it is a
 * conservative constant scaled by how much of the book the regime filter has
 * deployed, NOT a fitted price prediction of any asset.
 *
 * ── NO-LOOK-AHEAD CONTRACT ────────────────────────────────────────────────────
 * The target at bar `i` uses ONLY market data through `i` (inclusive). Weights,
 * `estAnnualVol`, and `expectedReturn` are all functions of closes[..i], via
 * the harvester's trailing-window vol and MA-vs-price tests at `i`. Mutating
 * any bar `> i` cannot change the decision at `i`.
 *
 * PURE module. No I/O, no clocks, no randomness, no network. Does NOT import
 * from src/backtest/* (one-way dep rule). The only strategy dependency is the
 * harvester's exported pure functions + the shared sleeve contract types.
 */

import type { Candle } from "../../analysis/indicators.js";
import {
  type HarvesterConfig,
  DEFAULT_HARVESTER_CONFIG,
  realizedAnnVol,
  targetWeights,
} from "../harvester.js";
import type {
  AssetCandles,
  MarketData,
  Sleeve,
  SleeveTarget,
  TargetLeg,
} from "../sleeve.js";

/**
 * Sleeve-A configuration. The harvester half is the frozen, certified
 * `HarvesterConfig` (defaults from the Fase-0/1 cert). The structural-premium
 * fields govern ONLY the `expectedReturn` estimate fed to fractional-Kelly
 * sizing — they never touch the weights.
 */
export interface TrendSleeveConfig {
  /** Stable sleeve id (default "trend-basket"). */
  id: string;
  /** Frozen, certified harvester parameters used to compute the weights. */
  harvester: HarvesterConfig;
  /**
   * Conservative annualized STRUCTURAL beta premium assumed for a FULLY
   * deployed (gross = maxGross) in-regime basket. NOT a per-asset forecast: a
   * single regime-wide constant standing in for "the trend-overlay-on-a-risky-
   * asset premium" (Faber 2007; Moskowitz-Ooi-Pedersen 2012). The actual
   * `expectedReturn` returned at bar i is this constant scaled by realized
   * gross deployment, so a de-risked / cash book reports ~0. Kept deliberately
   * modest so fractional-Kelly under-bets estimation error.
   */
  structuralPremiumAnnual: number;
}

/** Default Sleeve-A config: certified harvester params + a conservative premium. */
export const DEFAULT_TREND_SLEEVE_CONFIG: TrendSleeveConfig = {
  id: "trend-basket",
  harvester: DEFAULT_HARVESTER_CONFIG,
  // ~12%/yr structural beta premium for a fully-deployed in-regime crypto
  // basket. Conservative on purpose; the allocator further fractionally-Kellys
  // it. This is a regime-premium constant, never a fitted per-asset return.
  structuralPremiumAnnual: 0.12,
};

/**
 * Project each asset's candle series onto the portfolio's authoritative shared
 * `grid` (unix-sec day stamps). Mirrors harvester.ts's internal `alignToGrid`
 * close-extraction, but keyed to the EXTERNALLY supplied `MarketData.grid`
 * (the contract's single source of bar index `i`) rather than rebuilding a
 * grid from the union of candle timestamps. Returns one close array per symbol,
 * `undefined` where a symbol has no (positive) close on a grid day.
 */
function alignClosesToGrid(
  grid: readonly number[],
  assets: readonly AssetCandles[],
): Map<string, (number | undefined)[]> {
  const pos = new Map<number, number>();
  grid.forEach((d, idx) => pos.set(d, idx));
  const closes = new Map<string, (number | undefined)[]>();
  for (const a of assets) {
    const arr = new Array<number | undefined>(grid.length).fill(undefined);
    for (const c of a.candles as readonly Candle[]) {
      const gi = pos.get(c.t);
      if (gi !== undefined && c.c > 0) arr[gi] = c.c;
    }
    closes.set(a.symbol, arr);
  }
  return closes;
}

/**
 * Sleeve A: the certified multi-asset trend (beta) harvester as a `Sleeve`.
 *
 * Composition, not reimplementation:
 *   - WEIGHTS  ← harvester `targetWeights` (frozen, certified) on closes
 *     aligned to `MarketData.grid`; each `Record<string,number>` entry becomes
 *     one long-only `TargetLeg` (`instrument: "perp"`, its own `legGroup`).
 *   - estAnnualVol ← the harvester's OWN book-vol proxy recomputed from the
 *     emitted weights: Σ wₛ·volₛ (the correlation≈1 stress assumption the
 *     harvester uses internally). Honest and look-ahead-free.
 *   - expectedReturn ← structural regime-premium constant × realized gross
 *     deployment. Structural, never per-asset (C5 guardrail).
 */
export class TrendSleeve implements Sleeve {
  readonly id: string;
  readonly kind = "trend" as const;
  private readonly cfg: TrendSleeveConfig;

  constructor(config: Partial<TrendSleeveConfig> = {}) {
    this.cfg = { ...DEFAULT_TREND_SLEEVE_CONFIG, ...config };
    this.id = this.cfg.id;
  }

  /**
   * The instruments this sleeve may hold — derived from config-independent
   * data. Sleeve A trades the universe it is fed; we expose it as a hint when
   * the sleeve is asked without market data. When called with no fed universe
   * (stateless contract), returns an empty list; the allocator may instead read
   * `targetAt(...).legs`. Kept conservative to avoid look-ahead on `i`.
   */
  universe(): readonly string[] {
    return this.declaredUniverse;
  }

  /** Optional pre-declared symbol list (lets the allocator pre-reserve). */
  private declaredUniverse: readonly string[] = [];

  /**
   * Declare the universe up-front (e.g. from the same config that builds the
   * MarketData) so `universe()` is populated before the first `targetAt`. Pure
   * setter; does not affect any weight computation. Returns `this` for chaining.
   */
  withUniverse(symbols: readonly string[]): this {
    this.declaredUniverse = [...symbols];
    return this;
  }

  targetAt(data: MarketData, i: number): SleeveTarget {
    const hc = this.cfg.harvester;

    // Guard out-of-range / empty: de-risk to cash.
    if (i < 0 || i >= data.grid.length || data.assets.length === 0) {
      return { barIndex: i, legs: [], estAnnualVol: 0, expectedReturn: 0 };
    }

    // Align asset closes onto the contract's authoritative grid, then run the
    // EXACT certified weight path. No look-ahead: targetWeights reads closes
    // only through index i (trailing vol window + MA-vs-price at i).
    const closes = alignClosesToGrid(data.grid, data.assets);
    const weights = targetWeights(closes, i, hc);

    // Reshape the certified Record<string,number> into long-only TargetLegs.
    // Each held asset is its own delta-neutral-trivial legGroup; perp leg.
    const legs: TargetLeg[] = [];
    let gross = 0;
    for (const [symbol, weight] of Object.entries(weights)) {
      if (weight === 0) continue;
      legs.push({
        symbol,
        instrument: "perp",
        weight,
        legGroup: `trend:${symbol}`,
      });
      gross += Math.abs(weight);
    }

    return {
      barIndex: i,
      legs,
      estAnnualVol: this.bookVol(weights, closes, i),
      expectedReturn: this.structuralExpectedReturn(gross),
    };
  }

  /**
   * Honest annualized vol estimate for the sleeve's OWN target book at i —
   * the harvester's internal proxy recomputed from the emitted weights:
   *   bookVol ≈ Σ |wₛ| · volₛ      (correlation ≈ 1 stress assumption)
   * This is conservative (it never under-states risk by assuming
   * diversification) and uses ONLY data through i (per-asset trailing vol).
   * A flat / de-risked book reports 0.
   */
  private bookVol(
    weights: Record<string, number>,
    closes: Map<string, (number | undefined)[]>,
    i: number,
  ): number {
    let v = 0;
    for (const [sym, w] of Object.entries(weights)) {
      if (w === 0) continue;
      const vol = realizedAnnVol(closes.get(sym)!, i, this.cfg.harvester.volLookbackDays);
      // vol is guaranteed defined for any symbol targetWeights kept; guard anyway.
      if (vol !== undefined) v += Math.abs(w) * vol;
    }
    return v;
  }

  /**
   * STRUCTURAL expected return for fractional-Kelly sizing — NOT a forecast.
   * The regime filter is what decides how much of the book is deployed; when
   * the basket is fully in-regime and deployed to `maxGross`, we attribute the
   * configured structural beta premium; when partially / not deployed we scale
   * it linearly by realized gross. So a cash (de-risked) book reports 0 and a
   * fully-on book reports the modest constant premium. No per-asset term enters.
   */
  private structuralExpectedReturn(gross: number): number {
    const maxGross = this.cfg.harvester.maxGross;
    if (maxGross <= 0) return 0;
    const deployment = Math.min(1, gross / maxGross);
    return this.cfg.structuralPremiumAnnual * deployment;
  }
}

/**
 * Factory: build a Sleeve-A trend sleeve. Optionally pre-declare the universe
 * so `sleeve.universe()` is populated for the allocator's symbol pre-reserve.
 */
export function createTrendSleeve(
  config: Partial<TrendSleeveConfig> = {},
  universe: readonly string[] = [],
): TrendSleeve {
  const s = new TrendSleeve(config);
  return universe.length ? s.withUniverse(universe) : s;
}
