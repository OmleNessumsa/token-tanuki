<p align="center">
  <img src="assets/token-tanuki-logo.png" alt="Token Tanuki" width="520">
</p>

# Token Tanuki

A **research fork** of `lukasuntangle/cryptotrader`. The original is a
multi-timeframe technical-analysis bot (MEXC perps, composite scoring +
Weinstein Stage 2 filter, Telegram bot, DEX token analyzer, paper-trader).

This fork kept that tooling base but did one thing with it: **put the trading
thesis through a rigorous validation funnel — and rebuilt the strategy around
what actually survived out-of-sample.**

The short version: the original's core signal does not hold up under
walk-forward validation, and we have the receipts. What replaced it is a
risk-managed beta strategy that *does* survive out-of-sample. This README
explains both.

---

## TL;DR — what changed vs the original

| | Original (`lukasuntangle/cryptotrader`) | This fork (**Token Tanuki**) |
|---|---|---|
| Core thesis | Multi-TF `scoreChart` composite + Stage 2 filter has edge | **Tested it properly — it doesn't.** No robust forward edge on Blofin 5m or 1h, any side, any horizon |
| Validation | Single in-sample Aronson backtest | **Walk-forward CV + pre-registered cert gates + measured-cost sims + OOS replication** |
| Signal research | One composite | **9-hypothesis funnel, all killed by pre-registered gates** (momentum, reversal, lead-lag, low-vol, seasonality, funding ×2, cascade) |
| Shipped strategy | The (unvalidated) TA composite | **Risk-managed beta harvester, validated OOS 2018-2026** |
| Data layer | MEXC perps | Blofin perps + hardened bulk fetch (rate-limit handling, funding history, 3y cache) |
| Tests | 158 | **378** |
| Live | Paper-trades every fired TA signal | Paper-trades the certified harvester (daily, idempotent, launchd) |

---

## Why (the honest version)

The original assumes its multi-timeframe composite has predictive edge and
trades on it. We didn't assume — we built the harness to check, and the
answer was no. Across two full smokes and seven probes, the `scoreChart`
composite + trend/Stage-2 gates show **no robust forward-predictive value**
on 5m or 1h Blofin perps, in either direction, at any tested horizon. The
apparent SHORT-side "edge" is regime-tracking (β), not α — it sign-flips
every ~30-day slice.

That is an uncomfortable result, and it's the most valuable thing in this
fork. Rather than ship a likely-overfit signal, we kept hunting with
pre-registered kill criteria, buried nine hypothesis families, and then
found the one thing that genuinely works on this market — and built that.

Full write-ups: [`docs/PROBE_RESULTS_2026-06-12.md`](docs/PROBE_RESULTS_2026-06-12.md),
[`docs/STRATEGY_ROADMAP_2026-06-12.md`](docs/STRATEGY_ROADMAP_2026-06-12.md).

---

## The methodology (the real contribution)

Every hypothesis runs the same five-gate funnel before a line of production
code is written:

| Gate | Test | Kill criterion |
|---|---|---|
| 0 | Mechanism on paper | no credible counterparty/flow → skip |
| 1 | IC probe: 3y, multi-symbol, non-overlapping | pooled t < 2.5 or wrong sign |
| 2 | Stability across regimes (year/half splits) | sign flips, or effect shrinks with sample |
| 3 | Cost sim with **measured** turnover | net t < 2 or net < 5 bps/day |
| 4 | Walk-forward cert (existing harness) | fails the cert gates |

Principles, learned the hard way and enforced in code:
- **Mechanism before backtest** — no hypothesis enters without a counterparty story.
- **Signal-quality before trade-sim** — a kale IC probe before any grid sweep.
- **Pre-registered criteria** — kill thresholds committed *before* the run; no goalpost-moving.
- **Replication on disjoint data** — an effect must hold (or grow) with 3× the sample.
- **Overlap-corrected stats** — non-overlapping observations; naive t-stats overstate ~3×.
- **Measured costs** — locked 14 bps round-trip/leg (taker), charged on *measured* turnover.

### What the funnel buried

| Hypothesis | Verdict |
|---|---|
| scoreChart TA composite (5m, all variants + inversion) | dead — regime-tracking, not α |
| scoreChart on 1h | dead — same signature |
| Funding-rate percentile (time-series) | dead — sub-cost |
| Funding cross-sectional L/S (1y → 3y) | dead — effect shrank with sample |
| Daily cross-sectional momentum / reversal | dead — reversal direction *wrong* (perps trend) |
| BTC→alt lead-lag (1h) | **real** (IC 0.04, t=24.8) but **sub-cost** at taker fees |
| Low-vol anomaly | dead — skew trap (moonshots torch the short leg) |
| Seasonality / flow windows | dead — nothing past Bonferroni |
| Liquidation-cascade proxy | dead — pump side refutes the mechanism |

The lead-lag result is the honest highlight: a genuinely real microstructure
signal that the harness *also* proved untradeable at taker fees (2-8 bps gross
vs 21.6 bps cost at 77% turnover). Finding real-but-untradeable is exactly
what a correct validation pipeline should do.

---

## The strategy that survived: risk-managed beta harvester

Read the graveyard as a map and it points one way: this market is
**trending, right-skewed, and lottery-paying**. The strategy that fits is
not alpha — it's **risk-managed beta capture**: hold the trend with
drawdown control, and never be short the right tail.

- **Long-only**, never short the moonshot tail (low-vol probe's lesson).
- **MA regime filter** (100-day): hold only above the MA, de-risk to cash below.
- **Inverse-vol weights** + **portfolio vol target** (40%), gross capped at 1.0 (no leverage).
- **Daily rebalance**, low turnover — the cost wall that killed the lead-lag signal is non-binding here.

### Validation

Frozen parameters (MA 100, vol-target 40%, vol-lookback 30), tested on
Binance daily 2018-2026 — a full bull-bear cycle the parameters were never
tuned on:

| Metric (OOS 2018-2026) | Harvester | Buy-and-hold BTC |
|---|---|---|
| Cumulative | **9.23×** | 4.77× |
| CAGR | **30%** | 20% |
| Max drawdown | **32%** | 81% |
| Clean-OOS 2018-2022 Sharpe | **1.05** | 0.44 |

It side-stepped the 2018 (-16% vs -72%) and 2022 (-18% vs -64%) bears on
data it had never seen. In-sample Blofin cert (2023-2026): BTC Sharpe 1.09 /
maxDD 30%, 4-asset basket Sharpe 1.04 / maxDD 33% — both certified.

**Honest limitation (a product trait, not a bug):** the harvester *trails*
buy-hold in sustained bull markets — it cedes some upside for bear
protection. Its value is full-cycle compounding + drawdown control, not
bull-market maximization. Judge it on Sharpe + drawdown + full-cycle return,
never on raw return in a bull window.

Code: [`src/strategy/harvester.ts`](src/strategy/harvester.ts) (pure,
no-look-ahead, tested). Plan + results:
[`docs/CRYPTOTRADER_BUILD_PLAN.md`](docs/CRYPTOTRADER_BUILD_PLAN.md),
[`docs/HARVESTER_BACKTEST_RESULTS.md`](docs/HARVESTER_BACKTEST_RESULTS.md).

---

## Paper trading (live)

The harvester paper-trades on Blofin — daily, no real capital, a forward
test before any money is risked.

```bash
npx tsx scripts/paper-harvester-run.ts            # run today's rebalance (idempotent)
npx tsx scripts/paper-harvester-run.ts --status   # report only
npx tsx scripts/paper-harvester-run.ts --reset --cash 10000
```

Runs daily via launchd (`scripts/launchd/`) with post-sleep catch-up. State
in `~/.cryptotrader/harvester-paper.json`. Runbook:
[`docs/PAPER_TRADING_RUNBOOK.md`](docs/PAPER_TRADING_RUNBOOK.md).

Current signal is **flat / risk-off** — BTC and the basket are below their
100-day MA, so the book is in cash. That is the drawdown protection working,
not a malfunction.

---

## Inherited tooling (still present)

The original TA stack lives on and is still useful as *descriptive* tooling
(it just isn't forward-predictive, which is the whole point above):

- **Futures CLI** — multi-timeframe MEXC perps analysis + trade card
  (`npm run dev:futures -- ZEC --leverage 20 --account 10000`)
- **DEX token CLI** — ETH/Solana address risk check (honeypot, authorities, LP)
- **Telegram bot** — `/scan /top /positions` + ticker text
- The backtest harness v2 (`src/backtest/`) — walk-forward CV, cert gates,
  the infrastructure that did all the falsification above.

See the architecture map and TA references in [`docs/`](docs/).

---

## Install

```bash
git clone https://github.com/OmleNessumsa/token-tanuki.git
cd token-tanuki
npm install
cp .env.example .env        # optional keys raise rate limits
npm test                    # 378 tests
```

## Development

```bash
npm test                    # vitest
npm run typecheck           # tsc --noEmit
```

## Not financial advice

Structured, rules-based, and — unusually — *honest about its own negative
results*. The market still doesn't care about your rules.
