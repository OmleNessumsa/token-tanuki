# Backtest Harness v2 — PRD

**Owner:** Rick (CTO) → backend-morty + tester-morty
**Status:** Draft, awaiting Elmo approval
**Created:** 2026-06-09
**Target completion:** 2026-06-12 (3 working days incl. data fetch + tuning)
**Ticket:** CB-10 (to be created)

---

## 1. Problem

Live paper-trader (`scripts/paper-trader.ts`, Blofin perp futures, 5m bars) ran for 15.4 days, closed 16 trades, win-rate 12.5%, realized PnL −$86.21 (−8.62% on $1k). Sample size is too small to know whether the strategy has an edge, and the per-trade pace (~1/day) means we'd need **6+ months of live paper** to reach N=200 — the minimum for statistically meaningful expectancy on a system this noisy.

We need a way to evaluate strategy parameters **on historical Blofin data** so iteration time drops from weeks to hours, while staying disciplined about out-of-sample validation to avoid overfitting.

## 2. Goals

1. **Speed**: reduce time-to-calibrated-strategy from 4–6 weeks to **1 week**.
2. **Statistical rigor**: every reported expectancy ships with an out-of-sample number; never report in-sample alone.
3. **Reuse**: leverage existing `src/analysis/backtest.ts` engine (`runStrategyOnSeries`, `summarize`, `permutationTest`) rather than rebuilding.
4. **Honesty**: a config that fails out-of-sample must be **rejected**, not tuned further. We report it.

## 3. Non-goals (cut to keep tight)

- **No live trading integration.** Output of this harness is a calibrated config + report; applying it to live paper-trader is a follow-up ticket, manual step.
- **No new signal logic.** We tune *existing* signal parameters (composite floor, stage2-strict, stop-ATR mult, cooldown, horizon, R-targets), not invent new indicators.
- **No multi-timeframe.** 5m only for v2. Add 15m/1h in v3 if v2 finds an edge.
- **No regime detection.** Fixed window walk-forward only. Regime-aware logic is v3+.
- **No frontend / dashboard.** CLI + Markdown report only.

## 4. Acceptance criteria

A reviewer (Rick) can run **one command** that:

1. Fetches **6 months of 5m OHLCV** for Blofin top-30 perp futures (~52,000 bars × 30 = ~1.5M candles), cached to `~/.cryptotrader-data/blofin-5m/`.
2. Runs a **hyperparameter grid sweep** (target: 90 combos) over the full history, both LONG and SHORT sides, in **≤ 4 hours** on Elmo's M-series Mac.
3. Performs **walk-forward cross-validation**: 4 train/test folds (3-month train + 1-month test, rolling).
4. Outputs `docs/BACKTEST_V2_RESULTS.md` with:
   - **Per-config table** sorted by out-of-sample expectancy
   - **In-sample vs out-of-sample delta** flagged red if > 50%
   - **Sharpe, max drawdown, profit factor, total R, trade count** per config
   - **Per-symbol breakdown** for top-3 configs
   - **Concentration check**: top-3 contributing symbols' share of total R (kill-switch if any single symbol > 50%)
5. Prints the **winning config** in a copy-pasteable JSON block for `paper-trader.ts` consumption.
6. **Unit tests** (`vitest`) covering: no look-ahead in replay, walk-forward fold boundaries correct, SHORT R-math symmetric to LONG, stop-honoring under gap conditions.

A config is **certified** only if:
- Out-of-sample expectancy > +0.10R/trade
- Out-of-sample Sharpe > 1.0
- Max drawdown < 20R (≈ 20% on $1k with $1/R risk)
- No single symbol contributes > 50% of total R

If no config meets all four → harness reports "no edge found" and we don't ship. Honesty over hope.

## 5. Architecture

### 5.1 New / changed files

| File | Status | Purpose |
|---|---|---|
| `scripts/backtest-v2.ts` | NEW | Orchestrator: data fetch → grid sweep → walk-forward → report |
| `src/backtest/data-fetcher.ts` | NEW | Blofin 5m OHLCV fetch + local cache (parquet-style flat files or JSONL.gz) |
| `src/backtest/grid.ts` | NEW | Generate config combinations from declarative grid spec |
| `src/backtest/walk-forward.ts` | NEW | Split history into rolling train/test folds, run engine per fold |
| `src/backtest/metrics.ts` | NEW | Sharpe, profit factor, max DD, R-distribution (extends `BacktestStats`) |
| `src/backtest/reporter.ts` | NEW | Markdown report generator |
| `src/analysis/backtest.ts` | EXTEND | Add SHORT-side support (`side: "SHORT"` in `BacktestTrade`), generalize `runStrategyOnSeries` to accept side |
| `src/analysis/backtest.ts` test | EXTEND | Add SHORT-side unit tests, no-look-ahead invariant test |
| `tests/backtest/*.test.ts` | NEW | Unit + integration tests for new modules |

### 5.2 Data flow

```
┌────────────────────┐
│ Blofin public API  │  GET /api/v1/market/candles  (5m, 6mo)
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ data-fetcher       │  paginated, rate-limited, cached
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ ~/.cryptotrader-   │  ~150 MB total, idempotent
│  data/blofin-5m/   │
└─────────┬──────────┘
          ▼
┌──────────────────────────────────────────────┐
│ grid.ts: generate 90 configs from grid spec  │
└─────────┬────────────────────────────────────┘
          ▼
┌──────────────────────────────────────────────┐
│ walk-forward.ts:                             │
│   for each config:                           │
│     for each fold (4):                       │
│       runStrategyOnSeries(train)  → IS stats │
│       runStrategyOnSeries(test)   → OOS stats│
└─────────┬────────────────────────────────────┘
          ▼
┌──────────────────────────────────────────────┐
│ reporter.ts: rank, flag overfits, write MD   │
└──────────────────────────────────────────────┘
```

### 5.3 Grid spec (defaults — tweakable in script)

```ts
const GRID = {
  thresholdComposite: [55, 60, 65, 70],          // 4
  requireStage2:      [true, false],              // 2
  stopAtrMult:        [1.5, 2.0, 2.5],            // 3
  horizonBars:        [12, 36, 144],              // 3  (1h, 3h, 12h on 5m)
  cooldownBars:       [12, 72],                   // 2  (1h, 6h)
  side:               ["LONG", "SHORT"],          // run separately, results merged
};
// 4 × 2 × 3 × 3 × 2 = 144 LONG configs + 144 SHORT = 288 runs
// Bounded by 4h budget → if too slow, reduce to 90 by trimming horizonBars to [36, 144]
```

### 5.4 Walk-forward folds (6mo window)

```
Months:  [Jan]  [Feb]  [Mar]  [Apr]  [May]  [Jun]
Fold 1:  TRAIN  TRAIN  TRAIN  TEST   —      —
Fold 2:  —      TRAIN  TRAIN  TRAIN  TEST   —
Fold 3:  —      —      TRAIN  TRAIN  TRAIN  TEST
Fold 4: rolling-window aggregate (sanity)
```

OOS metrics = unweighted mean of folds 1–3. Fold 4 = aggregate for sanity check vs concatenated approach.

### 5.5 SHORT-side extension

Current `BacktestTrade.side` is hardcoded `"LONG"`. Symmetric R-math:

```ts
// LONG
rMultiple = (exitPrice - entryPrice) / (entryPrice - stopPrice);
// SHORT (new)
rMultiple = (entryPrice - exitPrice) / (stopPrice - entryPrice);
```

Signal source for SHORT: same `scoreChart` composite, but on inverted trend direction (HTF + LTF both bearish, composite ≥ threshold). Reuse existing `naturalSide` field from `signals.jsonl` schema.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Overfitting** to in-sample window | Walk-forward CV with strict OOS gates (above). Reject any config with IS-OOS delta > 50%. |
| **Look-ahead leakage** in `scoreAtBar()` | Existing test asserts only `candles[0..i]` is passed; new SHORT-side test reasserts. CI gate. |
| **5m noise dominates** signal | If grid sweep finds zero positive configs, report "5m too noisy for current signal" — don't move to live paper, escalate to a v3 ticket exploring 15m/1h. |
| **Blofin rate-limits** during data fetch | 6mo × 30 symbols × 5m = bounded; throttle to 5 req/sec, with retries. Cache means re-runs are free. |
| **ZEC-style concentration** masking the result | Concentration check in acceptance criteria. Report flags any config where one symbol > 50% of R. |
| **Compute budget** (>4h) | If grid exceeds budget, reduce horizonBars dimension and run again; cache intermediate per-config results so partial reruns are cheap. |

## 7. Out-of-scope follow-ups (post-v2)

- v3: 15m + 1h timeframes
- v3: regime-aware tuning (separate configs for trending vs choppy)
- v3: live paper-trader takes config from JSON file rather than hardcoded
- v3: continuous shadow-mode logging of every signal, daily auto-replay against last 30d

## 8. Definition of done

- [ ] `scripts/backtest-v2.ts` runs end-to-end on Elmo's machine without manual intervention beyond `npx tsx`
- [ ] Cache hits on second run (no re-fetch)
- [ ] `docs/BACKTEST_V2_RESULTS.md` generated with all required tables
- [ ] All unit tests pass (`npm test`)
- [ ] No look-ahead test passes
- [ ] At least one config attempted in walk-forward CV (whether it certifies or not — finding "no edge" is a valid result)
- [ ] Rick reviews the report and either certifies a config OR declares no-edge

## 9. Locked decisions (Elmo, 2026-06-09)

1. **Data source**: Blofin public klines API, perp futures, 5m bars (reuse `src/clients/blofin.ts`).
2. **Sizing**: **Risk-normalized** — $10 fixed risk per trade, quantity derived from `risk / (entry − stop)`. Matches commit 249bc2b. R-multiples become directly comparable across configs.
3. **Fees**: 0.06% taker on Blofin perp (round-trip = 0.12% notional). Modeled per trade.
4. **Slippage**: **1 bp entry + 1 bp exit** (conservative). Applied to the fill price after fees.
5. **Universe**: **Dynamic per fold** — top-30 by 24h volume at the *start* of each fold, using only data available at that point in time (no look-ahead via future-volume).
   - ⚠️ **Caveat**: introduces forward-looking bias risk if implemented naively. Implementation must use the volume-rank snapshot at fold-start (or a frozen "as-of" volume series) — **never** the current/today volume-rank. The architect-morty must explicitly call out how this is handled in the design.
   - Per-symbol aggregation across folds will be skewed if a symbol enters/exits the top-30 between folds; report this in the per-symbol breakdown.
6. **Team**: Sequential — **architect-morty first** (design doc + module boundaries), then **backend-morty + tester-morty in parallel** with an integration-Morty gating the merge.

## 10. Architect resolutions (Elmo, 2026-06-09, after `BACKTEST_V2_ARCHITECTURE.md`)

- **Q1 — staged smoke:** Stage 1 smoke (4 configs × 5 symbols × 3 folds, <5 min) before Stage 2 real run. Catches integration bugs before burning 4h.
- **Q2 — score-cache:** **Add `src/backtest/score-cache.ts`** to the module map. Per-(symbol, bar) cache of `scoreChart` output, populated once per fold-window, shared across all configs. Without this the grid sweep can't finish in 4h. This is the single highest-leverage optimization in the entire harness.
- **Q3 — trade memory:** discard `BacktestTrade[]` arrays after `summarize` for all configs outside the top-10 by OOS expectancy. Top-10 retains full trade arrays for the per-symbol breakdown. Architect's recommendation accepted as default.
- **Q4 — symbol-tagging:** wrapper type `BacktestTrade & { symbol: string }` at the walk-forward layer. Core engine stays symbol-blind. Architect's recommendation accepted as default.
- **Q5 — cost model:** fees (0.06% taker) + slippage (1 bp entry + 1 bp exit) applied **post-trade in `metrics.ts`** as `applyCosts(trade, costModel)`. Core engine stays cost-blind.
- **Q6 — universe pool:** fetch the top-50 superset (~42 MB gzipped). Per-fold selection still picks top-30 dynamically from the as-of-fold-start volume rank, but the candidate pool is bounded.
