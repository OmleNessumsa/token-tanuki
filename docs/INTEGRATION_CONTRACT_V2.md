# Integration Contract V2 — multi-premium portfolio (epic CB-020)

**Companion to:** `docs/ADR-001-multi-premium-portfolio.md`
**Normative interface:** `src/strategy/sleeve.ts`
**Purpose:** zero-overlap parallel execution across CB-022 / CB-023 / CB-024 /
CB-025. If every Morty follows this contract, their PRs merge clean.

All paths are absolute under `/Users/elmo.asmussen/Projects/TokenTanuki`.

---

## Shared, normative, frozen (changes require Architect-Morty + all owners)

- `/Users/elmo.asmussen/Projects/TokenTanuki/src/strategy/sleeve.ts` — the
  `Sleeve`, `PortfolioAllocator`, `MarketData`, `TargetLeg`, `SleeveTarget`,
  `AllocationResult`, `AllocatorConfig` contract. **Read-only to all four
  tickets.** A signature change here forces every PR to rebase — raise it as an
  ADR-001 open question, do not edit silently.
- `/Users/elmo.asmussen/Projects/TokenTanuki/docs/ADR-001-multi-premium-portfolio.md`
- `/Users/elmo.asmussen/Projects/TokenTanuki/docs/INTEGRATION_CONTRACT_V2.md` — this file.

## Off-limits to everyone (additive-only where noted, else read-only)

- `src/strategy/harvester.ts` — **READ-ONLY. Do NOT rewrite or edit.** CB-022
  wraps/reuses its exported pure functions (`alignToGrid` is internal; use
  `targetWeights`, `realizedAnnVol`, `aboveRegime`, `simulateHarvester`,
  `latestSignal`, the `Candle`/`AssetSeries` types). If a needed symbol is not
  exported, CB-022 raises it to Architect-Morty for an **additive export only**;
  no behavior change.
- `src/strategy/paper-harvester.ts` — read-only; CB-024 adapts its
  weight-based rebalance machinery via a NEW adapter file, not by editing it.
- `src/analysis/indicators.ts` — read-only (`Candle`, `sma`).
- `src/clients/blofin.ts` — additive-only, and ONLY CB-023 may extend it
  (funding/spot helpers). Default-compatible signatures.

---

## File ownership (no overlap)

### CB-022 backend-morty — Sleeve A (multi-asset trend)

Wraps/reuses `harvester.ts`; must NOT rewrite it. New files only:

- `src/strategy/sleeves/trend-sleeve.ts` — NEW. Implements `Sleeve` (`kind:
  "trend"`). Internally delegates to harvester.ts's certified `targetWeights`,
  re-expressing the `Record<string,number>` weights as long-only `TargetLeg[]`
  (each its own `legGroup`, `instrument: "perp"`). Provides `estAnnualVol`
  (book-vol proxy already in harvester) and a conservative structural
  `expectedReturn` (regime-conditioned beta premium — NO per-asset forecast).

### CB-023 backend-morty — Sleeve B (delta-neutral funding-carry)

All new files:

- `src/strategy/sleeves/funding-carry-sleeve.ts` — NEW. Implements `Sleeve`
  (`kind: "funding-carry"`). Emits balanced `+spot / −perp` leg pairs sharing a
  `legGroup`; sizes by trailing realized carry net of basis drift. Delta-neutral
  by construction; NOT a funding-as-signal predictor.
- `src/strategy/sleeves/funding-carry-data.ts` — NEW. Pure assembly of
  `FundingPairData` (align spot+perp+funding to the shared grid). No I/O.
- `src/backtest/funding-carry-fetcher.ts` — NEW. The ONLY new I/O module for
  Sleeve B; fetches spot candles + funding history via blofin client.
- `src/clients/blofin.ts` — **additive-only** extension if a spot-candle or
  funding helper is missing (default-compatible). Coordinate the exact
  signature with Architect-Morty before adding.

### CB-024 backend-morty — PortfolioAllocator

All new files:

- `src/strategy/allocator.ts` — NEW. Implements `PortfolioAllocator`:
  per-sleeve `targetAt`, inter-sleeve correlation from realized streams,
  correlation-aware risk budget, fractional Kelly (band `[0.10, 0.25]`,
  never full), `targetAnnualVol` + `maxGross` enforcement, merged `book`. PURE.
- `src/strategy/paper-allocator.ts` — NEW. Adapter from `AllocationResult.book`
  onto the existing weight-based rebalance machinery in `paper-harvester.ts`
  (imports it, does not edit it).

### CB-025 tester-morty — OOS / walk-forward gate

Owns ALL tests:

- `tests/strategy/` — ALL files in this folder (NEW). No-look-ahead tests for
  Sleeve A, Sleeve B, and the allocator; delta-neutrality invariant
  (`Σ weight per legGroup ≈ 0`) for Sleeve B; the OOS/walk-forward gate.
- `tests/strategy/fixtures/` — synth + small real spot/perp/funding fixtures.
- `tests/strategy/_helpers.ts` — fixture loaders + deterministic synth
  generators (seeded), private to tests.

**The gate (normative):** the combined two-sleeve portfolio MUST beat the
**single-asset harvester baseline on BOTH Sharpe AND maxDD, net-of-cost**, on
walk-forward OOS, PLUS a **tail/skew check** (quintile-spread mean and skew —
no moonshot-tail / fat-left-tail artifact, per the buried H3 low-vol lesson).
Failing any leg of the gate ⇒ second sleeve shelved.

---

## Merge order

1. **CB-022 PR** (Sleeve A) — smallest, reuses certified code; lands first.
2. **CB-023 PR** (Sleeve B + fetcher + additive blofin helpers).
3. **CB-024 PR** (allocator + paper adapter) — depends on A & B existing.
4. **CB-025 PRs** — lag by one cycle each so the types they import already exist.

## Integration checklist (before final merge)

- [ ] `npm run typecheck` clean; `npm test` green.
- [ ] No `src/strategy/*` file imports from `src/backtest/*` (one-way dep rule).
- [ ] `harvester.ts` and `paper-harvester.ts` show **zero** behavioral diffs
      (additive exports only, if any).
- [ ] No-look-ahead test passes for Sleeve A, Sleeve B, and the allocator.
- [ ] Sleeve B delta-neutrality invariant test passes (`Σ weight per legGroup ≈ 0`).
- [ ] Allocator uses fractional Kelly only — assert `kellyFraction ∈ [0.10, 0.25]`,
      never 1.0; `maxGross` never exceeded (no leverage).
- [ ] OOS gate: portfolio Sharpe AND maxDD beat single-asset harvester baseline
      net-of-cost; tail/skew check passes.
- [ ] No `expectedReturn` derived from a per-asset forward forecast (C5 grep:
      review each sleeve's estimate for a fitted price prediction — must be
      structural).
- [ ] `funding-carry-fetcher.ts` is the only Sleeve-B module touching `src/clients/`.

## Communication protocol mid-flight

- Signature questions on `sleeve.ts` → ADR-001 open-questions; Architect-Morty
  resolves. No silent reinterpretation.
- Need a new export from `harvester.ts` → request an additive export; never
  edit its behavior.
- Cross-PR refactors → forbidden during the parallel window; land post-merge as
  separate cleanup tickets.
