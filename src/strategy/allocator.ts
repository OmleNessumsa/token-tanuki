/**
 * PortfolioAllocator — the sizing layer above the sleeves (ticket CB-024,
 * epic CB-020, ADR-001). This is the "structure beats signal" core: it takes
 * several small, uncorrelated risk-premium sleeves and combines them into ONE
 * portfolio book, sized by a correlation-aware risk budget + fractional Kelly,
 * capped by a portfolio vol target and a hard gross cap.
 *
 * ── WHAT IT DOES (and what it does NOT) ───────────────────────────────────
 * The allocator never inspects a sleeve's internal mechanism. At bar `i` it:
 *   1. Pulls each sleeve's `SleeveTarget` (legs + estAnnualVol + expectedReturn).
 *   2. Reconstructs each sleeve's realized return stream through `i` (from its
 *      OWN past decisions; no look-ahead) and estimates the inter-sleeve
 *      correlation matrix over a trailing window.
 *   3. Sizes each sleeve by a CORRELATION-AWARE RISK BUDGET (inverse-vol risk
 *      parity refined by a diversification dividend: low-correlated sleeves get
 *      MORE combined exposure because the portfolio vol of the combination is
 *      sub-additive — Σ parts > whole — which is exactly the Sharpe lift this
 *      epic exists to capture).
 *   4. Applies FRACTIONAL Kelly per sleeve (`kellyFraction ∈ [min,max]`, hard-
 *      capped ≤ 0.25, NEVER full Kelly) from the sleeve's structural
 *      premium-to-variance ratio — for SIZING only.
 *   5. Enforces the portfolio vol target by scaling gross so the
 *      correlation-aware portfolio-vol estimate hits `targetAnnualVol`, then
 *      enforces `maxGross` — DE-RISK ONLY, never levered above the cap.
 *   6. Concatenates the scaled legs into one merged `book`, preserving each
 *      `legGroup` so delta-neutral pairs stay balanced (Σ weight per group ≈ 0).
 *
 * ── C5 GUARDRAIL (binding; see ADR-001 §"C5 Guardrail") ───────────────────
 * The allocator adds NO alpha and NO per-asset directional view. It only sizes
 * and merges what the sleeves already decided. `expectedReturn` is consumed as
 * a STRUCTURAL-premium estimate for the Kelly fraction; the allocator never
 * derives, fits, or amplifies a per-asset forward forecast. It is strictly
 * de-risk-biased (long-only doctrine inherited from the harvester: gross is
 * capped, never levered).
 *
 * ── NO-LOOK-AHEAD CONTRACT ────────────────────────────────────────────────
 * The decision at bar `i` uses ONLY data through `i` (inclusive). Sleeve
 * targets at `i` read data ≤ i (their own contract). The inter-sleeve
 * correlation is estimated from realized streams over (i−L, i] reconstructed
 * from each sleeve's decisions at past bars, each of which itself looked only
 * back. Mutating any bar `> i` cannot change `allocateAt(data, i)`.
 *
 * ── PURE MODULE ───────────────────────────────────────────────────────────
 * No I/O, no clocks, no randomness. Does NOT import from src/backtest/*
 * (one-way dep rule, ADR-001 §6). Stateless across calls: everything needed to
 * decide bar `i` is recomputed from `data` and the sleeves.
 */

import type {
  AllocationResult,
  AllocatorConfig,
  MarketData,
  PortfolioAllocator,
  Sleeve,
  SleeveAllocation,
  SleeveTarget,
  TargetLeg,
} from "./sleeve.js";

/** Floors to avoid divide-by-zero on degenerate (cash) sleeves. */
const MIN_VOL = 1e-6;
const MIN_VAR = MIN_VOL * MIN_VOL;

/**
 * Default allocator config. Vol target and gross cap inherit the harvester's
 * de-risk-only doctrine (`maxGross = 1.0`, no leverage). The Kelly band is the
 * ADR-mandated FRACTIONAL window [0.10, 0.25] — never full Kelly. The
 * correlation lookback is ~60 bars (≈2 months daily), long enough to estimate
 * a stable cross-sleeve correlation, short enough to track regime.
 */
export const DEFAULT_ALLOCATOR_CONFIG: AllocatorConfig = {
  targetAnnualVol: 0.3,
  maxGross: 1.0,
  kellyFractionMin: 0.1,
  kellyFractionMax: 0.25,
  corrLookbackBars: 60,
};

/**
 * Hard ceiling on the Kelly fraction. The ADR forbids full Kelly outright
 * (over-bets estimation error). Even if a misconfigured `AllocatorConfig` asks
 * for more, the allocator CLAMPS to this — the cap is enforced, not honored.
 */
const KELLY_HARD_CAP = 0.25;

/**
 * Sanitize a config into honest, enforceable bounds. A config asking for full
 * Kelly or leverage is CLAMPED, not honored (CB-024 guardrail):
 *   - kellyFractionMax  ≤ KELLY_HARD_CAP (0.25), and > 0.
 *   - kellyFractionMin  ∈ (0, kellyFractionMax].
 *   - maxGross          ≥ 0 (de-risk only; a finite positive cap).
 *   - targetAnnualVol   ≥ 0.
 *   - corrLookbackBars  ≥ 2 (need ≥2 points for a correlation).
 */
function sanitizeConfig(cfg: AllocatorConfig): AllocatorConfig {
  const kellyFractionMax = clamp(cfg.kellyFractionMax, 0, KELLY_HARD_CAP);
  const kellyFractionMin = clamp(cfg.kellyFractionMin, 0, kellyFractionMax);
  return {
    targetAnnualVol: Math.max(0, cfg.targetAnnualVol),
    maxGross: Math.max(0, cfg.maxGross),
    kellyFractionMin,
    kellyFractionMax,
    corrLookbackBars: Math.max(2, Math.floor(cfg.corrLookbackBars)),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** Per-sleeve intermediate state during one allocateAt pass. */
interface SleeveState {
  sleeve: Sleeve;
  target: SleeveTarget;
  /** estAnnualVol of the sleeve's own book at i, floored. */
  vol: number;
  /** kellyFraction chosen for this sleeve (∈ band). */
  kellyFraction: number;
  /** Risk-budget share (fraction of total inverse-vol×corr-adjusted weight). */
  riskBudgetShare: number;
  /** Capital weight before vol-target / gross scaling. */
  rawCapital: number;
}

/**
 * The concrete allocator. Construct via {@link createAllocator}.
 */
class PortfolioAllocatorImpl implements PortfolioAllocator {
  readonly config: AllocatorConfig;
  readonly sleeves: readonly Sleeve[];

  constructor(sleeves: readonly Sleeve[], config: AllocatorConfig) {
    this.config = sanitizeConfig(config);
    this.sleeves = sleeves;
  }

  allocateAt(data: MarketData, i: number): AllocationResult {
    const cfg = this.config;

    // Out-of-range / no sleeves → flat book.
    if (i < 0 || i >= data.grid.length || this.sleeves.length === 0) {
      return { barIndex: i, allocations: [], book: [], estPortfolioVol: 0 };
    }

    // 1. Pull each sleeve's target at i (each reads only data ≤ i).
    const states: SleeveState[] = this.sleeves.map((sleeve) => {
      const target = sleeve.targetAt(data, i);
      const vol = Math.max(MIN_VOL, target.estAnnualVol);
      return {
        sleeve,
        target,
        vol,
        kellyFraction: 0,
        riskBudgetShare: 0,
        rawCapital: 0,
      };
    });

    // Active = sleeves that actually want exposure at i (data-driven universe:
    // derived from targetAt(...).legs, NOT from universe(), per the resolved
    // design decision — universe() may be []).
    const active = states.filter((s) => hasExposure(s.target));
    if (active.length === 0) {
      return {
        barIndex: i,
        allocations: states.map(zeroAllocation),
        book: [],
        estPortfolioVol: 0,
      };
    }

    // 2. Inter-sleeve correlation from realized streams through i.
    const corr = this.estimateCorrelation(active, data, i);

    // 3. Fractional Kelly per sleeve (sizing-only premium/variance → band).
    for (const s of active) {
      s.kellyFraction = this.kellyFraction(s.target);
    }

    // 4. Correlation-aware risk budget → per-sleeve capital weights.
    this.riskBudget(active, corr);

    // 5. Estimate portfolio vol of the Kelly-scaled, risk-budgeted combination,
    //    then scale to hit the vol target — DE-RISK ONLY, then cap gross.
    const scaled = this.applyVolTargetAndGross(active, corr);

    // 6. Merge scaled legs (legGroup preserved → delta-neutral pairs stay paired).
    const book = this.mergeBook(active, scaled.sleeveScale);

    const allocations: SleeveAllocation[] = states.map((s) => {
      const idx = active.indexOf(s);
      if (idx === -1) return zeroAllocation(s);
      return {
        sleeveId: s.sleeve.id,
        scale: scaled.sleeveScale[idx]!,
        kellyFraction: s.kellyFraction,
        riskBudgetShare: s.riskBudgetShare,
      };
    });

    return {
      barIndex: i,
      allocations,
      book,
      estPortfolioVol: scaled.estPortfolioVol,
    };
  }

  // ── Fractional Kelly ──────────────────────────────────────────────────────

  /**
   * FRACTIONAL Kelly fraction for one sleeve, in `[kellyFractionMin,
   * kellyFractionMax]`, NEVER full Kelly.
   *
   * Full Kelly for a single bet is `f* = μ / σ²` (expected return over
   * variance). That is the WRONG thing to bet because it over-fits estimation
   * error — and on a structural-premium estimate it is meaningless to take
   * literally. So we do NOT scale exposure by `μ/σ²`. Instead we use the
   * sleeve's structural reward-to-risk ratio (a Sharpe-like quantity
   * `μ / σ`) only to choose WHERE in the fractional band to sit:
   *
   *   sharpeLike = expectedReturn / estAnnualVol         (≥ 0; 0 if no premium)
   *   t          = clamp(sharpeLike / KELLY_REF_SHARPE, 0, 1)
   *   f          = min + t · (max − min)                 ∈ [min, max] ⊆ [0,0.25]
   *
   * A richer (higher Sharpe-like) premium earns a fraction nearer the top of
   * the band; a thin one sits near the floor. The band itself — never above
   * 0.25 — is the hard guardrail against acting on noisy crypto estimates.
   * `KELLY_REF_SHARPE` is the reward-to-risk at which a sleeve earns the TOP of
   * the band; deliberately conservative so most sleeves sit mid-band.
   */
  private kellyFraction(target: SleeveTarget): number {
    const { kellyFractionMin: min, kellyFractionMax: max } = this.config;
    const vol = Math.max(MIN_VOL, target.estAnnualVol);
    const sharpeLike = Math.max(0, target.expectedReturn) / vol;
    const KELLY_REF_SHARPE = 1.0; // reward-to-risk that maps to the top of the band
    const t = clamp(sharpeLike / KELLY_REF_SHARPE, 0, 1);
    const f = min + t * (max - min);
    // Belt-and-braces: never exceed the hard cap regardless of config drift.
    return clamp(f, 0, KELLY_HARD_CAP);
  }

  // ── Correlation-aware risk budget ────────────────────────────────────────

  /**
   * Assign each active sleeve a capital weight via a correlation-aware risk
   * budget (the diversification-dividend core of the epic).
   *
   * Start from RISK PARITY: each sleeve's base budget is inverse to its own
   * vol scaled by its Kelly fraction — `base_s = kelly_s / vol_s` — so equal
   * marginal risk per sleeve, more capital to the lower-vol premium.
   *
   * Then apply a DIVERSIFICATION MULTIPLIER from the correlation matrix. A
   * sleeve that is LOW-correlated with the rest of the book contributes less
   * marginal portfolio risk per unit of its own vol, so it earns MORE budget;
   * a sleeve that moves WITH the book is throttled. Concretely, let
   * `avgCorr_s` be sleeve s's mean correlation to the OTHER active sleeves
   * (∈ [−1,1]); the multiplier is
   *
   *   divMult_s = 1 / (1 + Σ_{r≠s} max(0, corr_{s,r})) ?  →  we use the
   *   smoother, bounded form:  divMult_s = (1 − ρ̄_s) clipped to [floor, 1+]
   *
   * so that ρ̄_s = 0 (orthogonal, e.g. trend vs delta-neutral funding-carry)
   * leaves the budget untouched, ρ̄_s → 1 (redundant) shrinks it toward the
   * floor, and ρ̄_s < 0 (hedging) gives it a mild boost. This is what realizes
   * the low-correlation Sharpe benefit: the two structurally-orthogonal sleeves
   * (directional crypto-beta vs delta-neutral carry) keep full budget and the
   * combined portfolio vol comes out below the sum of the parts.
   *
   * Budgets are normalized to sum to 1 and stored as `riskBudgetShare`; the
   * pre-scaling capital weight is `rawCapital = base_s · divMult_s` (the
   * vol-target step rescales the whole vector next).
   */
  private riskBudget(
    active: SleeveState[],
    corr: number[][],
  ): void {
    const n = active.length;
    const DIV_FLOOR = 0.25; // a fully-redundant sleeve still keeps 25% budget
    const raw: number[] = new Array(n).fill(0);

    for (let s = 0; s < n; s++) {
      const base = active[s]!.kellyFraction / active[s]!.vol; // risk parity × kelly
      // Mean correlation of sleeve s to the OTHER active sleeves.
      let sum = 0;
      let cnt = 0;
      for (let r = 0; r < n; r++) {
        if (r === s) continue;
        sum += corr[s]![r]!;
        cnt++;
      }
      const avgCorr = cnt > 0 ? sum / cnt : 0;
      // 1 at ρ̄=0 (orthogonal), → floor at ρ̄=1 (redundant), mild >1 at ρ̄<0.
      const divMult = clamp(1 - avgCorr, DIV_FLOOR, 2);
      raw[s] = base * divMult;
    }

    const total = raw.reduce((a, x) => a + x, 0);
    for (let s = 0; s < n; s++) {
      active[s]!.rawCapital = raw[s]!;
      active[s]!.riskBudgetShare = total > 0 ? raw[s]! / total : 1 / n;
    }
  }

  // ── Portfolio vol target + de-risk-only gross cap ────────────────────────

  /**
   * Scale the risk-budgeted capital vector so the CORRELATION-AWARE portfolio
   * vol estimate hits `targetAnnualVol`, then enforce `maxGross`. Both steps
   * are DE-RISK ONLY:
   *
   *   - portfolio vol at unit scaling:
   *       σ_p = sqrt( Σ_s Σ_r  c_s c_r  vol_s vol_r  corr_{s,r} )
   *     where `c_s = rawCapital_s` is sleeve s's capital weight and `vol_s`
   *     its own book vol. Because corr enters here, two low-correlated sleeves
   *     produce σ_p strictly below Σ_s c_s·vol_s — the diversification dividend.
   *   - volScale = targetAnnualVol / σ_p   (how much to scale to HIT target).
   *   - grossScale = maxGross / grossAtUnit (cap on summed |leg weight|).
   *   - FINAL scale = min(volScale, grossScale)  — we take the MORE
   *     conservative of "scale up to vol target" vs "stay under gross cap", and
   *     additionally never exceed grossScale, so the book is never levered past
   *     `maxGross`. If σ_p already exceeds target, volScale < 1 de-risks; we do
   *     not lever beyond maxGross even when target vol would allow it.
   *
   * Returns the per-sleeve final scale (capital × global scale, applied to that
   * sleeve's emitted legs) and the resulting estimated portfolio vol.
   */
  private applyVolTargetAndGross(
    active: SleeveState[],
    corr: number[][],
  ): { sleeveScale: number[]; estPortfolioVol: number } {
    const n = active.length;
    const cfg = this.config;

    // Portfolio vol at the unscaled capital vector (corr-aware).
    let var0 = 0;
    for (let s = 0; s < n; s++) {
      for (let r = 0; r < n; r++) {
        var0 +=
          active[s]!.rawCapital *
          active[r]!.rawCapital *
          active[s]!.vol *
          active[r]!.vol *
          corr[s]![r]!;
      }
    }
    const sigma0 = Math.sqrt(Math.max(0, var0));

    // Gross (summed |leg weight| × capital) at the unscaled capital vector.
    let gross0 = 0;
    for (let s = 0; s < n; s++) {
      gross0 += active[s]!.rawCapital * sleeveGross(active[s]!.target.legs);
    }

    const volScale =
      sigma0 > MIN_VOL ? cfg.targetAnnualVol / sigma0 : 0;
    const grossScale =
      gross0 > 0 ? cfg.maxGross / gross0 : 0;

    // DE-RISK ONLY: take the tighter of the two, and never lever beyond
    // maxGross (grossScale is a hard ceiling on the global multiplier).
    const globalScale = Math.max(0, Math.min(volScale, grossScale));

    const sleeveScale = active.map((s) => s.rawCapital * globalScale);
    const estPortfolioVol = sigma0 * globalScale;
    return { sleeveScale, estPortfolioVol };
  }

  // ── Merge ─────────────────────────────────────────────────────────────────

  /**
   * Concatenate every active sleeve's legs, each multiplied by that sleeve's
   * final scale. The SAME scale multiplies BOTH legs of a delta-neutral group,
   * so `Σ weight per legGroup` is preserved (a balanced ±w pair stays ±(scale·w)
   * = nets ~0). Legs sharing a `(symbol, instrument, legGroup)` identity are
   * summed so the merged book has one entry per distinct leg; this lets two
   * sleeves that touch the same instrument net cleanly while never collapsing
   * two different `legGroup`s into one (delta-neutral pairing is by group, and
   * groups are namespaced per sleeve upstream, e.g. "fc:BTC" vs "trend:BTC").
   */
  private mergeBook(active: SleeveState[], sleeveScale: number[]): TargetLeg[] {
    const merged = new Map<string, TargetLeg>();
    for (let s = 0; s < active.length; s++) {
      const scale = sleeveScale[s]!;
      if (!(scale > 0)) continue;
      for (const leg of active[s]!.target.legs) {
        const key = `${leg.legGroup}|${leg.symbol}|${leg.instrument}`;
        const existing = merged.get(key);
        const w = leg.weight * scale;
        if (existing) {
          existing.weight += w;
        } else {
          merged.set(key, {
            symbol: leg.symbol,
            instrument: leg.instrument,
            weight: w,
            legGroup: leg.legGroup,
          });
        }
      }
    }
    // Drop legs that netted to ~0 (e.g. fully offsetting cross-sleeve overlap).
    return [...merged.values()].filter((l) => Math.abs(l.weight) > 1e-12);
  }

  // ── Inter-sleeve correlation (no look-ahead) ─────────────────────────────

  /**
   * Estimate the active sleeves' pairwise return correlation over the trailing
   * `corrLookbackBars` ending at i. Each sleeve's realized return on bar k is
   * reconstructed from the book IT WANTED at bar k−1 (its decision through k−1)
   * earning the (k−1, k] return — exactly the no-look-ahead convention. This is
   * O(L · sleeves · legs) per allocateAt; acceptable for the small sleeve count.
   *
   * Returns an n×n matrix with 1 on the diagonal. Pairs with too few overlapping
   * finite returns fall back to a CONSERVATIVE assumed correlation (so the risk
   * budget cannot over-credit diversification it can't yet measure).
   */
  private estimateCorrelation(
    active: SleeveState[],
    data: MarketData,
    i: number,
  ): number[][] {
    const n = active.length;
    const L = this.config.corrLookbackBars;
    const start = Math.max(1, i - L + 1);

    // Build each active sleeve's realized return stream over (start..i].
    const streams: number[][] = active.map((s) =>
      sleeveReturnStream(s.sleeve, data, start, i),
    );

    /** Conservative prior when we cannot measure: assume mild positive corr so
     *  the diversification dividend must be EARNED by data, not assumed. */
    const PRIOR_CORR = 0.3;

    const corr: number[][] = Array.from({ length: n }, (_, a) =>
      Array.from({ length: n }, (_, b) => (a === b ? 1 : PRIOR_CORR)),
    );

    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const c = pearson(streams[a]!, streams[b]!);
        const v = c === null ? PRIOR_CORR : c;
        corr[a]![b] = v;
        corr[b]![a] = v;
      }
    }
    return corr;
  }
}

// ── Module-level pure helpers ───────────────────────────────────────────────

/** Does a sleeve target actually want exposure (data-driven universe)? */
function hasExposure(target: SleeveTarget): boolean {
  return target.legs.some((l) => l.weight !== 0);
}

/** Gross exposure (Σ |weight|) of a sleeve's emitted legs (per-NAV fraction). */
function sleeveGross(legs: readonly TargetLeg[]): number {
  let g = 0;
  for (const l of legs) g += Math.abs(l.weight);
  return g;
}

/** A zero (de-risked) allocation record for a sleeve that wanted nothing at i. */
function zeroAllocation(s: SleeveState): SleeveAllocation {
  return {
    sleeveId: s.sleeve.id,
    scale: 0,
    kellyFraction: 0,
    riskBudgetShare: 0,
  };
}

/**
 * Reconstruct a sleeve's realized per-bar return stream over bars
 * `(start..end]` with NO look-ahead: the return on bar k is the book the sleeve
 * decided at k−1 (its `targetAt(data, k-1)`) earning each leg's (k−1, k]
 * simple return. Spot and perp legs both earn their instrument's price return;
 * funding cash flow is intentionally OMITTED here — it would require funding in
 * this stream and, being a near-constant positive drift, barely moves the
 * cross-sleeve CORRELATION (which is what we need), while keeping this helper a
 * pure function of the candle series already in MarketData. Bars with no
 * computable return contribute NaN (skipped pairwise by `pearson`).
 */
function sleeveReturnStream(
  sleeve: Sleeve,
  data: MarketData,
  start: number,
  end: number,
): number[] {
  // Price lookup: symbol → (grid timestamp → close). Built once across assets
  // and pair legs so both sleeve kinds resolve their legs' prices.
  const priceByDay = buildPriceIndex(data);
  const out: number[] = [];
  for (let k = start; k <= end; k++) {
    const decision = sleeve.targetAt(data, k - 1); // book through k-1
    let ret = 0;
    let any = false;
    for (const leg of decision.legs) {
      if (leg.weight === 0) continue;
      const r = legReturn(priceByDay, leg.symbol, data.grid, k);
      if (r === undefined) continue;
      ret += leg.weight * r;
      any = true;
    }
    out.push(any ? ret : Number.NaN);
  }
  return out;
}

/** symbol → (gridTimestamp → close) across all assets and both pair legs. */
function buildPriceIndex(data: MarketData): Map<string, Map<number, number>> {
  const idx = new Map<string, Map<number, number>>();
  const add = (symbol: string, candles: readonly { t: number; c: number }[]) => {
    let m = idx.get(symbol);
    if (!m) {
      m = new Map<number, number>();
      idx.set(symbol, m);
    }
    for (const c of candles) if (c.c > 0) m.set(c.t, c.c);
  };
  for (const a of data.assets) add(a.symbol, a.candles);
  for (const p of data.pairs) {
    add(p.spot.symbol, p.spot.candles);
    add(p.perp.symbol, p.perp.candles);
  }
  return idx;
}

/** Simple (k−1, k] price return for `symbol`; undefined if either close missing. */
function legReturn(
  priceByDay: Map<string, Map<number, number>>,
  symbol: string,
  grid: readonly number[],
  k: number,
): number | undefined {
  const m = priceByDay.get(symbol);
  if (!m) return undefined;
  const prev = m.get(grid[k - 1]!);
  const cur = m.get(grid[k]!);
  if (prev === undefined || cur === undefined || prev <= 0) return undefined;
  return cur / prev - 1;
}

/**
 * Pearson correlation of two equal-length series, pairwise-skipping any index
 * where either value is non-finite. Returns null if fewer than 2 overlapping
 * finite pairs or if either side has zero variance (undefined correlation).
 */
function pearson(a: number[], b: number[]): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= MIN_VAR || vy <= MIN_VAR) return null;
  const c = cov / Math.sqrt(vx * vy);
  return clamp(c, -1, 1);
}

/**
 * Factory: build a {@link PortfolioAllocator} over a set of sleeves. The config
 * is merged onto {@link DEFAULT_ALLOCATOR_CONFIG} and then SANITIZED — a config
 * asking for full Kelly or leverage beyond `maxGross` is clamped, not honored
 * (CB-024 guardrail). Mirrors the harvester/sleeve factory style.
 *
 * @param sleeves the uncorrelated risk-premium sleeves under management.
 * @param config  partial overrides; defaults fill the rest.
 */
export function createAllocator(
  sleeves: readonly Sleeve[],
  config: Partial<AllocatorConfig> = {},
): PortfolioAllocator {
  const merged: AllocatorConfig = { ...DEFAULT_ALLOCATOR_CONFIG, ...config };
  return new PortfolioAllocatorImpl(sleeves, merged);
}
