# ADR-001 — Multi-Premium Risk-Premia Portfolio

**Status:** Accepted (CB-021, epic CB-020)
**Author:** Architect-Morty
**Supersedes:** nothing — this is the first portfolio-level ADR.
**Contract files:** `src/strategy/sleeve.ts` (normative types), `docs/INTEGRATION_CONTRACT_V2.md` (file ownership).

---

## Context

Token Tanuki today has **breadth = 1**: a single validated premium, the beta
harvester (`src/strategy/harvester.ts`), which captures crypto beta with
drawdown control (OOS 2018–2026: 9.23x vs 4.77x buy-hold BTC, maxDD 32% vs
81%). Two research docs and this project's own buried-hypothesis history
converge on one thesis: **profit comes from STRUCTURE — several small,
uncorrelated edges, tight cost control, sensible sizing — not one brilliant
signal** (Grinold's Fundamental Law: `IR ≈ IC × √breadth`). The way to raise
the information ratio without inventing new alpha is to raise breadth and size
correctly.

This epic adds a **second, low-correlated premium** and a **portfolio-level
sizing layer** above both. It does NOT add alpha.

## C5 Guardrail (binding on all downstream Morty's)

This project formally buried taker-alpha (verdict **C5**: nine hypothesis
families tested and rejected — price/volume/funding-as-signal/seasonality/
lead-lag/etc.). The new sleeves are **structural risk premia, not return
forecasts**:

- **Sleeve A (trend)** is the existing harvester generalized. Its value is
  **breadth, crisis-alpha and drawdown-control**, NOT per-asset return
  prediction. Cert CB-017 already proved single-asset TSMOM is repackaged
  beta — so Sleeve A must remain a *basket* overlay, never a per-name forecast.
- **Sleeve B (funding-carry)** is **delta-neutral**: long spot / short perp,
  harvesting funding as a **structural yield**. It is explicitly NOT the buried
  "funding-rate-as-a-predictive-signal" probe. It takes ~zero directional view;
  it earns the carry shorts collect from longs.

**Hard rule:** no Sleeve may emit a target derived from a forward per-asset
return forecast. The `expectedReturn` field in `SleeveTarget` exists ONLY for
fractional-Kelly sizing and must be a structural-premium estimate (trailing
carry, regime-conditioned beta premium), never a fitted price prediction. A PR
that reopens alpha violates this ADR and must be rejected at review.

## Decision

### 1. The `Sleeve` abstraction

A **Sleeve** is one uncorrelated risk-premium source, expressed as a PURE
function of market data. Given the aligned market snapshot through bar `i`, it
emits a **target book + risk/return estimates** (`SleeveTarget`). A sleeve owns
no capital and no portfolio sizing — it only says "this is the book I want, in
fractions of MY nav, and here's my own vol estimate." It is stateless across
calls and mirrors harvester.ts's purity (no I/O, clocks, or randomness).

```
interface Sleeve {
  readonly id: string;
  readonly kind: "trend" | "funding-carry";
  universe(): readonly string[];
  targetAt(data: MarketData, i: number): SleeveTarget;
}
```

### 2. How TWO very different sleeves conform to ONE interface

The unifying insight: **both a long-only directional basket and a
delta-neutral pairs book are just lists of signed legs in NAV-fraction units.**

- A **trend sleeve (A)** emits long-only legs — one `TargetLeg` per held asset,
  `weight > 0`, each in its own `legGroup`. This is exactly harvester.ts's
  `Record<string, number>` weights, re-expressed as legs.
- A **funding-carry sleeve (B)** emits **balanced leg pairs** that net to ~0
  directional exposure: a `+w` spot leg and a `−w` perp leg sharing one
  `legGroup`. Delta-neutrality is the property `Σ weight over a legGroup ≈ 0`.

The allocator therefore never inspects a sleeve's internal mechanism. It sees a
flat list of signed legs plus the sleeve's own `estAnnualVol` /
`expectedReturn`. Gross and net exposure are computable from the legs;
hedged units are recognised via `legGroup`; spot-vs-perp financing is carried
on each leg's `instrument` field. One type (`TargetLeg`) spans both worlds.

### 3. Data each sleeve needs (concrete)

| Sleeve | Inputs (from `MarketData`) | Derived at bar i |
|---|---|---|
| A — trend | `assets[]` (per-asset candles on shared grid) | realized vol, MA regime |
| B — funding-carry | `pairs[]` = `{spot candles, perp candles, settled funding[]}` | spot/perp **basis** (perp.c − spot.c), trailing realized carry |

The basis is **derived** inside Sleeve B from the two candle series at bar i —
it is never a separate input, so no look-ahead basis can leak in. Funding is a
settled history (`FundingPoint[]`, oldest-first); only settlements with
`tMs ≤ grid[i]` are visible at i.

### 4. The `PortfolioAllocator` (sizing layer above the sleeves)

The allocator sits ABOVE the sleeves and is the only place portfolio-level
sizing lives. At bar `i` it:

1. Calls each `sleeve.targetAt(data, i)`.
2. Estimates the **inter-sleeve correlation** from the sleeves' realized return
   streams through `i` (trailing `corrLookbackBars`; no-look-ahead).
3. Applies a **correlation-aware risk budget**: low-correlated sleeves get more
   combined exposure (diversification dividend); correlated sleeves are
   throttled so the portfolio vol estimate respects `targetAnnualVol`.
4. Applies **FRACTIONAL Kelly** per sleeve — `kellyFraction ∈ [0.10, 0.25]`,
   **never full Kelly** (full Kelly over-bets estimation error and is banned by
   `AllocatorConfig`). The fraction scales with the sleeve's
   structural-premium-to-vol ratio, clamped to the band.
5. Enforces `maxGross` (de-risk only, never levered — inherited from the
   harvester's long-only doctrine) and concatenates the scaled legs into one
   merged `book`.

```
interface PortfolioAllocator {
  readonly config: AllocatorConfig;   // targetAnnualVol, maxGross, kellyFractionMin/Max, corrLookbackBars
  readonly sleeves: readonly Sleeve[];
  allocateAt(data: MarketData, i: number): AllocationResult;
}
```

The allocator is PURE (no I/O, clocks, randomness). Paper-trading and live
execution consume `AllocationResult.book`; the existing
`paper-harvester.ts` rebalance machinery already operates on NAV-fraction
weights, so the merged book maps onto it with an adapter (CB-024), not a
rewrite.

### 5. No-look-ahead contract

Every target/allocation at bar `i` uses ONLY data through `i` (inclusive) and
earns the return realized over `(i, i+1]` — identical to harvester.ts's
structural enforcement. The allocator's correlation estimate uses only realized
streams through `i`. Tests (CB-025) must assert this for BOTH sleeves and the
allocator (mutating any bar `> i` must not change the decision at `i`).

### 6. One-way dependency rule

`src/strategy/*` (sleeves + allocator) MUST NOT import from `src/backtest/*`.
Data flows IN as the plain arrays defined in `sleeve.ts`. The backtest /
walk-forward harness imports the sleeves; never the reverse. This keeps the
certified strategy modules standalone, exactly as harvester.ts is today.

## Consequences

- **Positive:** breadth rises from 1 → 2 with a low-correlated premium; sizing
  becomes principled (correlation-aware, fractional-Kelly, vol-targeted);
  harvester.ts is reused untouched (wrapped, not rewritten); the contract lets
  CB-022/023/024/025 build in parallel with zero file overlap.
- **Negative / risks:** funding-carry adds two-legged execution complexity
  (spot + perp, basis risk, funding-cycle timing) that paper-trading must model
  honestly; correlation estimates are noisy on short crypto history — the
  fractional-Kelly band and `maxGross` are the guardrails against acting on
  that noise.
- **Gate (CB-025):** the combined portfolio must beat the **single-asset
  harvester baseline on Sharpe AND maxDD net-of-cost**, with a tail/skew check
  (no moonshot-tail or fat-left-tail artifact — the lesson from the buried
  H3 low-vol skew trap). Failing the gate means the second sleeve does not earn
  its complexity and is shelved.

## Open question for Elmo

Sleeve B requires a **spot** data + execution path (long-spot leg). The current
stack is perp-centric (Blofin perps, funding history). Confirm whether
paper/live Sleeve B should (a) use real Blofin spot markets, or (b) approximate
the spot leg with a second perp / index for the first cert, deferring true spot
execution to a later ticket. This affects CB-023's data-fetcher scope.
