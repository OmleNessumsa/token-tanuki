/**
 * Sleeve B — delta-neutral funding-carry. CB-023, ADR-001.
 *
 * ── WHAT THIS HARVESTS (and what it is NOT) ──────────────────────────────
 * This sleeve harvests funding as a STRUCTURAL CASH-FLOW YIELD, delta-neutrally.
 * For each held asset it puts on a balanced pair: LONG the spot (proxy) leg and
 * SHORT the perp leg, sharing one `legGroup`, with `Σ weight ≈ 0` so the unit
 * carries ~zero directional price exposure. When funding is positive (longs pay
 * shorts) the short-perp leg COLLECTS the funding each settlement; the long-spot
 * leg neutralises the price move. The premium earned is the funding cash flow,
 * not a price forecast.
 *
 * ⚠️ C5 GUARDRAIL: This is explicitly NOT the buried "funding-rate-as-a-
 * predictive-price-signal" probe (verdict C5 — dead). Nothing here predicts an
 * asset's forward return from funding. `expectedReturn` below is the trailing
 * realized carry net of expected costs and basis drift — a structural-yield
 * estimate for fractional-Kelly sizing only, NOT a fitted price prediction.
 * Entry/exit are funding-sign + cost-buffer rules, never directional calls.
 *
 * ── SPOT-LEG PROXY (Elmo's decision, CB-023) ─────────────────────────────
 * The long-spot leg is, for this first OOS cert, a PROXY: a second perp/index
 * series standing in for a real Blofin spot market (deferred to a later ticket).
 * The proxy is selected upstream in `funding-carry-fetcher.ts` and assembled in
 * `funding-carry-data.ts`. This sleeve is agnostic: it reads `pair.spot` /
 * `pair.perp` close series. Each emitted spot leg is tagged `instrument: "spot"`
 * so a later real-spot swap needs no change here — only the fetcher's source.
 * (NB: while the proxy is itself a perp, the leg is still TAGGED "spot" so the
 * accounting/execution layer treats it as the non-funding-bearing hedge leg.)
 *
 * ── PURE MODULE ──────────────────────────────────────────────────────────
 * No I/O, no clocks, no randomness. Consumes `MarketData` passed in; does NOT
 * import from `src/backtest/*` (one-way dep rule, ADR-001 §6). Stateless across
 * `targetAt` calls — every decision at bar i is a pure function of data ≤ i.
 *
 * ── NO-LOOK-AHEAD ────────────────────────────────────────────────────────
 * The decision at bar i uses ONLY: candles with `t ≤ grid[i]` and funding
 * settlements with `tMs ≤ grid[i]*1000`. Basis is derived at i from the two
 * close series. The target is held over (i, i+1] and earns the funding settled
 * in that interval. No field is read from any bar > i.
 */

import type {
  AssetCandles,
  FundingPairData,
  FundingPoint,
  MarketData,
  Sleeve,
  SleeveTarget,
  TargetLeg,
} from "../sleeve.js";

/** 8h Blofin funding cycle → 3 settlements/day → 1095 cycles/year. */
const CYCLES_PER_YEAR = 365 * 3;
/** Daily-bar annualization for the basis-drift vol estimate. */
const ANN_SQRT_DAYS = Math.sqrt(365);

export interface FundingCarryConfig {
  /**
   * Round-trip cost per LEG as a fraction (e.g. 0.0014 = 14bps). A pair has two
   * legs (spot + perp), so entering+holding+exiting a pair costs ~2× this on
   * the round trip. Used to build the entry buffer.
   */
  costPerLegRoundTrip: number;
  /**
   * Extra "flip buffer" as a fraction of per-cycle funding, on TOP of cost. The
   * realized per-cycle carry must clear `cost + flipBuffer` to enter, so a rate
   * hovering near zero (likely to flip and force a costly exit) is skipped.
   */
  flipBufferPerCycle: number;
  /**
   * Trailing window (in funding settlements) used to estimate the realized
   * carry and its persistence. e.g. 9 settlements ≈ 3 days on an 8h cycle.
   */
  fundingLookbackCycles: number;
  /**
   * Trailing window (in bars/days) for the basis-drift vol estimate that feeds
   * `estAnnualVol`. The pair is delta-neutral, so its residual risk is basis
   * vol, not price vol.
   */
  basisVolLookbackDays: number;
  /**
   * Per-pair gross cap: the absolute spot-leg weight for a single pair, as a
   * fraction of sleeve NAV. Caps concentration in any one counterparty/asset.
   */
  maxWeightPerPair: number;
  /**
   * Target gross exposure for the sleeve (sum of |spot-leg weights|). De-risk
   * only, never levered: total spot-leg gross is capped at this.
   */
  maxGrossLong: number;
  /**
   * Liquidation-buffer guard: minimum fraction of NAV kept as margin headroom
   * behind the SHORT-perp leg. The short leg can be liquidated if the perp
   * rallies hard; we size each pair so its notional respects this buffer. A
   * larger buffer ⇒ smaller per-pair weight. Expressed as the assumed adverse
   * perp move the short must survive (e.g. 0.5 = survive a +50% perp spike).
   */
  shortLiqBufferMove: number;
}

/** Conservative defaults. Tunable by the OOS cert (CB-025), not fitted here. */
export const DEFAULT_FUNDING_CARRY_CONFIG: FundingCarryConfig = {
  costPerLegRoundTrip: 0.0014,
  flipBufferPerCycle: 0.00005, // 0.5bp/cycle headroom over cost
  fundingLookbackCycles: 9, // ~3 days on 8h cycles
  basisVolLookbackDays: 30,
  maxWeightPerPair: 0.25,
  maxGrossLong: 1.0,
  shortLiqBufferMove: 0.5,
};

/**
 * Factory for the delta-neutral funding-carry sleeve. The returned object is a
 * pure `Sleeve` (`kind: "funding-carry"`). `universe()` lists both legs of every
 * configured pair so the allocator can pre-reserve symbols.
 */
export function createFundingCarrySleeve(
  config: FundingCarryConfig = DEFAULT_FUNDING_CARRY_CONFIG,
  id = "funding-carry",
): Sleeve {
  return new FundingCarrySleeve(config, id);
}

class FundingCarrySleeve implements Sleeve {
  readonly kind = "funding-carry" as const;

  constructor(
    private readonly config: FundingCarryConfig,
    readonly id: string,
  ) {}

  universe(): readonly string[] {
    // Universe is data-driven (one entry per configured pair leg); since the
    // sleeve is stateless and pairs arrive via MarketData, we cannot know the
    // symbols without data. The allocator calls universe() for symbol
    // reservation; we return [] when unconfigured and rely on targetAt's legs.
    // Callers that need the static universe pass it via the data path. This is
    // intentionally empty — the contract permits a data-derived universe.
    return [];
  }

  /**
   * Decide the delta-neutral book at bar `i`. For each pair, evaluate the
   * funding edge through `i`; enter (long spot / short perp) only when the
   * trailing per-cycle carry clears the cost+flip buffer; exit (skip) on a
   * funding flip or insufficient edge. Sizes by edge / per-pair cap / liq
   * buffer, then scales down to respect the sleeve gross cap.
   */
  targetAt(data: MarketData, i: number): SleeveTarget {
    const gridTs = data.grid[i];
    if (gridTs === undefined) {
      return { barIndex: i, legs: [], estAnnualVol: 0, expectedReturn: 0 };
    }
    const nowMs = gridTs * 1000;

    const candidates: PairEval[] = [];
    for (const pair of data.pairs) {
      const ev = evaluatePair(pair, gridTs, nowMs, this.config);
      if (ev !== null) candidates.push(ev);
    }

    if (candidates.length === 0) {
      return { barIndex: i, legs: [], estAnnualVol: 0, expectedReturn: 0 };
    }

    // Per-pair weight ∝ edge (carry net of cost), capped by per-pair cap and the
    // short-leg liquidation buffer. Then scale the whole book down if the gross
    // (sum of |spot weights|) exceeds the sleeve cap — de-risk only, never up.
    const rawWeights = candidates.map((c) =>
      perPairWeight(c, this.config),
    );
    let gross = rawWeights.reduce((a, w) => a + w, 0);
    const scale =
      gross > this.config.maxGrossLong ? this.config.maxGrossLong / gross : 1;

    const legs: TargetLeg[] = [];
    let weightedCarry = 0; // Σ wSpot · annualizedNetCarry  (NAV-weighted)
    let weightedBasisVar = 0; // Σ (wSpot · basisVol)²  (independent-pair proxy)
    gross = 0;
    for (let k = 0; k < candidates.length; k++) {
      const c = candidates[k]!;
      const w = rawWeights[k]! * scale;
      if (!(w > 0)) continue;
      const legGroup = `fc:${c.pair}`;
      // Delta-neutral pair: +w spot, −w perp. Σ weight over legGroup = 0.
      legs.push({ symbol: c.spotSymbol, instrument: "spot", weight: +w, legGroup });
      legs.push({ symbol: c.perpSymbol, instrument: "perp", weight: -w, legGroup });
      gross += w;
      weightedCarry += w * c.annualizedNetCarry;
      weightedBasisVar += (w * c.basisAnnVol) ** 2;
    }

    if (legs.length === 0) {
      return { barIndex: i, legs: [], estAnnualVol: 0, expectedReturn: 0 };
    }

    // STRUCTURAL expectedReturn: NAV-weighted annualized net carry of the book.
    // This is realized trailing funding cash flow minus expected cost — NOT a
    // forward price forecast (C5 guardrail). When no pair has positive net carry
    // the book is empty and this is 0.
    const expectedReturn = weightedCarry; // already in NAV-fraction units

    // estAnnualVol: residual risk of a delta-neutral book is BASIS vol, not
    // price vol. Treat pairs as ~independent (conservative; understates nothing
    // it shouldn't — adding correlation only raises it, and the allocator's own
    // gross/vol caps backstop). sqrt of summed variance.
    const estAnnualVol = Math.sqrt(weightedBasisVar);

    return { barIndex: i, legs, estAnnualVol, expectedReturn };
  }
}

/** One pair's evaluated edge at bar i (only populated when eligible to enter). */
interface PairEval {
  pair: string;
  spotSymbol: string;
  perpSymbol: string;
  /** Annualized net carry (per-cycle realized carry − cost amortized), fraction. */
  annualizedNetCarry: number;
  /** Annualized basis (perp−spot) drift vol — the pair's residual risk. */
  basisAnnVol: number;
  /** Raw edge used for sizing: per-cycle net carry above the buffer. */
  edgePerCycle: number;
}

/**
 * Index of the last grid-aligned candle at-or-before `tSec` in an oldest-first
 * AssetCandles. Returns -1 if none. (Candles are re-stamped to the day grid by
 * funding-carry-data, so `t` values are day stamps ≤ grid[i].)
 */
function lastCandleAtOrBefore(ac: AssetCandles, tSec: number): number {
  let idx = -1;
  for (let k = 0; k < ac.candles.length; k++) {
    if (ac.candles[k]!.t <= tSec) idx = k;
    else break;
  }
  return idx;
}

/** Funding settlements with `tMs ≤ nowMs`, newest-last (input is oldest-first). */
function visibleFunding(funding: readonly FundingPoint[], nowMs: number): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (const f of funding) {
    if (f.tMs <= nowMs) out.push(f);
    else break;
  }
  return out;
}

/**
 * Evaluate one pair at bar i. Returns null (→ no position) when ineligible:
 * missing data, funding flipped/near-zero, or net carry below the cost+flip
 * buffer. The decision uses only data through i.
 *
 * Entry rule (the threshold formula):
 *   trailingCarry  = mean(last L visible funding rates)         [per cycle]
 *   costPerCycle   = (2 · costPerLegRoundTrip) / holdCycles?    → we charge the
 *                    round-trip per-leg cost amortized over the lookback as a
 *                    conservative per-cycle hurdle: costAmort = 2·cost / L
 *   buffer         = costAmort + flipBufferPerCycle
 *   ENTER iff      trailingCarry > buffer  AND  latestRate > 0  (no flip)
 *   edgePerCycle   = trailingCarry − buffer    (>0 by construction on entry)
 */
function evaluatePair(
  pair: FundingPairData,
  tSec: number,
  nowMs: number,
  config: FundingCarryConfig,
): PairEval | null {
  const visible = visibleFunding(pair.funding, nowMs);
  if (visible.length < config.fundingLookbackCycles) return null;

  // FUNDING-FLIP GUARD: the most recent settled rate must be positive (longs
  // pay shorts) — a flipped/negative latest rate means the short-perp leg would
  // now PAY funding, so we exit / skip.
  const latest = visible[visible.length - 1]!;
  if (!(latest.rate > 0)) return null;

  const window = visible.slice(visible.length - config.fundingLookbackCycles);
  const trailingCarry =
    window.reduce((a, f) => a + f.rate, 0) / window.length; // per cycle

  // Cost hurdle: two legs, round-trip cost each, amortized across the lookback
  // horizon as a conservative per-cycle hurdle.
  const costAmortPerCycle =
    (2 * config.costPerLegRoundTrip) / config.fundingLookbackCycles;
  const buffer = costAmortPerCycle + config.flipBufferPerCycle;

  // ENTRY THRESHOLD: net per-cycle carry must clear the buffer.
  const edgePerCycle = trailingCarry - buffer;
  if (!(edgePerCycle > 0)) return null;

  // Need aligned spot & perp closes at/through i to confirm both legs exist and
  // to estimate basis vol. Basis is DERIVED here, never an input.
  const basisAnnVol = basisDriftVol(
    pair.spot,
    pair.perp,
    tSec,
    config.basisVolLookbackDays,
  );
  if (basisAnnVol === null) return null;

  // Annualized NET carry = (trailingCarry − costAmort) per cycle × cycles/year.
  // (flip buffer is a sizing hurdle, not a cost — it isn't subtracted from the
  // realized-yield estimate, only the real cost is.)
  const annualizedNetCarry =
    (trailingCarry - costAmortPerCycle) * CYCLES_PER_YEAR;

  return {
    pair: pair.pair,
    spotSymbol: pair.spot.symbol,
    perpSymbol: pair.perp.symbol,
    annualizedNetCarry,
    basisAnnVol,
    edgePerCycle,
  };
}

/**
 * Annualized vol of daily basis-return where basis = (perp.c − spot.c)/spot.c.
 * This is the residual risk of the delta-neutral pair (the legs cancel price
 * level; what's left is basis drift). Uses only candles with `t ≤ tSec`.
 * Returns null if the trailing window is incomplete.
 */
function basisDriftVol(
  spot: AssetCandles,
  perp: AssetCandles,
  tSec: number,
  lookbackDays: number,
): number | null {
  // Build a quick day → close map for spot to pair against perp by timestamp.
  const spotByDay = new Map<number, number>();
  for (const c of spot.candles) if (c.t <= tSec && c.c > 0) spotByDay.set(c.t, c.c);

  // Basis series at the perp's aligned days ≤ tSec.
  const basis: number[] = [];
  for (const pc of perp.candles) {
    if (pc.t > tSec) break;
    if (!(pc.c > 0)) continue;
    const sc = spotByDay.get(pc.t);
    if (sc === undefined || !(sc > 0)) continue;
    basis.push((pc.c - sc) / sc);
  }
  if (basis.length < lookbackDays + 1) return null;

  // Daily basis CHANGES over the trailing window (drift of the hedge residual).
  const window = basis.slice(basis.length - (lookbackDays + 1));
  const diffs: number[] = [];
  for (let k = 1; k < window.length; k++) diffs.push(window[k]! - window[k - 1]!);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance =
    diffs.reduce((a, x) => a + (x - mean) ** 2, 0) / (diffs.length - 1);
  const sd = Math.sqrt(variance);
  return sd * ANN_SQRT_DAYS;
}

/**
 * Per-pair spot-leg weight (NAV fraction, positive). Proportional to the carry
 * edge, then clamped by:
 *   (a) the per-pair/counterparty cap (`maxWeightPerPair`), and
 *   (b) the SHORT-LEG LIQUIDATION buffer: the short-perp notional must survive
 *       an adverse perp move of `shortLiqBufferMove` without liquidation, so the
 *       per-pair weight is capped at `1 / (1 + shortLiqBufferMove)` of the cap —
 *       a smaller buffer requirement permits a larger position.
 */
function perPairWeight(c: PairEval, config: FundingCarryConfig): number {
  // Edge-proportional base size. Scale edge (per-cycle, tiny) up to a sensible
  // NAV fraction: edge of ~10bp/cycle → near the per-pair cap. The constant is a
  // sizing gain, NOT a fitted price coefficient.
  const EDGE_TO_WEIGHT = 250; // 0.0010 edge → 0.25 weight (= default cap)
  const edgeSize = c.edgePerCycle * EDGE_TO_WEIGHT;

  // Liquidation-buffer cap: keep short notional small enough to survive the
  // assumed adverse move. Larger buffer ⇒ tighter cap.
  const liqCap = config.maxWeightPerPair / (1 + config.shortLiqBufferMove);

  return Math.max(0, Math.min(edgeSize, config.maxWeightPerPair, liqCap));
}
