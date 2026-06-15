# Paper trading runbook — beta harvester (Fase 3)

Live paper trading of the certified beta harvester on Blofin. No exchange
orders, no real capital — a forward test to confirm live behavior tracks
the backtest before any money is risked.

## What it is

- **Strategy:** `src/strategy/harvester.ts` (certified Fase 0-2). Daily
  rebalance, long-only, vol-targeted, MA-regime-filtered, de-risk to cash.
- **Universe:** BTC, ETH, SOL, BNB (USDT perps).
- **Engine:** `src/strategy/paper-harvester.ts` — weight-based paper book
  (cash + units), state at `$CRYPTOTRADER_STATE_DIR/harvester-paper.json`
  (default `~/.cryptotrader/`).
- **Signal:** the live runner calls the SAME `latestSignal()` the backtest
  certified — no reimplementation.
- **Paper capital:** $10,000 (configurable).

## Commands

```bash
# Run today's rebalance (idempotent — one rebalance per closed UTC day)
tsx scripts/paper-harvester-run.ts

# Report only, no trading
tsx scripts/paper-harvester-run.ts --status

# (Re)initialize the paper book
tsx scripts/paper-harvester-run.ts --reset --cash 10000
```

## How to run it daily

The harvester acts on the daily close, so run once per day shortly after
00:00 UTC (when the prior day's bar finalizes). It is idempotent: extra
runs the same day mark NAV but do not re-trade.

Options:
- **/schedule** (cloud cron) — preferred; survives laptop sleep.
- Local cron: `10 0 * * *  cd <repo> && npx tsx scripts/paper-harvester-run.ts >> logs/paper-harvester.log 2>&1`

## Current status (initialized 2026-06-15)

The signal is **flat / risk-off**: BTC and the basket are below their 100d
MA (the 2025-26 decline), so the book is 100% cash. This is the
drawdown-protection working as designed — it will NOT go long into a
downtrend. The book starts taking positions when an asset reclaims its
100d MA with a defined vol. Expect long stretches of cash in bear regimes;
that is the strategy, not a malfunction.

## What we're validating (exit criteria for paper → real)

Run for a meaningful window (ideally spanning a regime change — risk-off
→ risk-on) and confirm:
1. **Live tracks backtest:** realized NAV path matches a backtest over the
   same dates within tolerance (no execution/logic drift).
2. **Risk-off behavior:** book sits in cash while below MA; enters on
   reclaim. No look-ahead, no churn.
3. **Drawdown control:** if a downturn hits during the trial, realized
   maxDD stays well below buy-hold BTC.

Only after that: consider tiny real capital (Fase 5), with the same code
behind a real Blofin execution adapter and a kill-switch.

## Hard rules carried from the research (do not violate)

- Long-only, de-risk to cash. Never short the right tail (H3 lesson).
- Params FROZEN: vol-lookback 30, MA 100, target vol 40%, max gross 1.0,
  daily rebalance, 14bps/leg cost. No live re-tuning.
- The harvester trails buy-hold in sustained bulls by design; judge it on
  drawdown + full-cycle risk-adjusted return, not bull-window raw return.
