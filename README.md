# cryptotrader

Futures + token analyzer + paper-trader. Multi-timeframe scoring on MEXC perps with a Stage 2 trend filter, an interactive Telegram bot for live signals and position management, a paper-trading book, and DEX-side token risk checks.

```
$ cryptotrader futures ZEC --leverage 20 --account 10000

 LONG   high confidence  composite 85/100  █████████░

ZEC → ZEC_USDT
  Last: $598.11 · 24h +6.42% · OI 9.4M contracts
  Funding 0.0100% (10.9% APR) — normal long pressure

Multi-timeframe:
  5m   ▲ bull  ████░░  62/100  trend=up    rsi=58
  15m  ▲ bull  █████░  74/100  trend=up    rsi=61
  1h   ▲ bull  █████░  79/100  trend=up    rsi=63
  4h   ▲ bull  ██████  92/100  trend=up    rsi=58
  1d   ▲ bull  ████░░  66/100  trend=up    rsi=67
  HTF (4h+1d): bullish | LTF (15m+1h): bullish | ALIGNED ✓

Trade Card @ 20× leverage · $10000 account · 1% risk
────────────────────────────────────────────────────────────
  Entry:    $598.11   Stop: $579.72 (-3.07%, liq-cap)
  Liq:      $568.21   buffer 5.01%
  Targets:  TP1 → $634.89  R:R 2.0  close 50%
            TP2 → $643.82  R:R 2.4  close 30%  doubleBottom MM
  Position: 16.72 ZEC = $10,000 notional
```

## Three entry points

1. **Futures CLI** — multi-timeframe MEXC perps analysis with trade card
   ```
   cryptotrader futures <SYMBOL> --leverage 20 --account 10000
   ```
2. **DEX token CLI** — Ethereum/Solana address risk check
   ```
   cryptotrader <0x... or solana-address>
   ```
3. **Telegram bot** — your own bot via BotFather. `/start /positions /scan /top` plus plain ticker text. Inline keyboards. Single-message digests sorted by urgency.

## Futures engine

**Multi-timeframe composite scoring** across 5m / 15m / 1h / 4h / 1d:
- Weighted composite: 5m=5%, 15m=15%, 1h=25%, 4h=30%, 1d=25%
- HTF (4h+1d) majority direction governs; LTF (15m+1h) must agree for HIGH confidence
- Funding-rate adjustment: euphoria –15, crowded long –8, paid-to-long +8
- Intermarket regime (Murphy BTC.D): btc_dump ×0.3 composite, altseason ×1.2
- Pattern detection: Bulkowski-weighted candle patterns, Donchian breakouts, divergence
- **Stage 2 filter (Weinstein)** — gates LONG verdicts to FLAT when `close < 150d SMA`. Validated via Aronson backtest on 16mo of top-30 perps: +7.4R / +0.024R expectancy / p<0.0001.

**Trade plan generator** — leverage-aware stops within liquidation budget, ATR-based or pattern-measured targets, R:R calculated against initial risk.

## DEX token analyzer

Takes a single ETH or Solana address and outputs `BUY` / `WAIT` / `AVOID`:

1. **Hard security disqualifiers** — honeypot (Honeypot.is, GoPlus), mint/freeze authority (Solana), hidden owner, sell tax > 15%, top wallet > 30%, LP not locked. Any one → AVOID.
2. **Lifecycle phase** — stealth / pump / accumulation / parabolic / distribution / bleed-out / dead.
3. **Classical TA** — EMA trend, RSI, candle patterns, divergence, volume.
4. **Composite verdict** — `0.40 × security + 0.20 × phase + 0.25 × chart + 0.15 × liquidity`. BUY needs composite ≥ 70 AND security ≥ 70 AND phase buyable.

## Paper-trader

- `$1,000` book, `$50` notional per signal × 20× leverage
- Opens on every fired LONG signal (Stage 2 ✅)
- Scale-outs: TP1 50%, TP2 30%, TP3 20%
- Move stop to entry after TP1
- Daily morning digest 07:00 UTC, weekly pattern review on Sunday
- Three isolated tenants (Lukas / Roy / Claude) via `$CRYPTOTRADER_STATE_DIR` and `$CRYPTOTRADER_ENV`

## Production deployment

Runs 24/7 on any VPS (Linux + systemd):

| Service | Type | Cadence |
|---|---|---|
| `cryptotrader-bot.service` | systemd long-running | always-on |
| `cryptotrader-scanner.timer` | systemd timer | every 30m, top-30 perps |
| `cryptotrader-paper.timer` | systemd timer | every 5m, paper book updates |
| `cryptotrader-outcomes.timer` | systemd timer | hourly, signal-outcome tracking |
| `cryptotrader-position-watch.timer` | systemd timer | every 5m, live MEXC positions |

State per tenant in `~/.cryptotrader-<name>/`. Signal log is JSONL with full feature snapshot per signal for offline learning.

## Install

```bash
git clone https://github.com/lukasuntangle/cryptotrader.git
cd cryptotrader
npm install
cp .env.example .env       # add your keys
npm test                   # 158 tests
```

## Usage

```bash
# Futures multi-TF analysis
npm run dev:futures -- ZEC --leverage 20 --account 10000

# DEX token check
npm run dev -- 0x6982508145454Ce325dDbE47a25d4ec3d2311933   # PEPE

# Top-30 perps scanner (terminal)
npx tsx scripts/scan-futures.ts

# Live positions report → Telegram digest
npx tsx scripts/positions-report.ts

# MEXC account stats (live)
npx tsx scripts/mexc-history.ts             # closed positions: W/L/PF
npx tsx scripts/mexc-pattern.ts --pages 10  # tail-loss diagnostic

# Per-tenant signal stats
CRYPTOTRADER_STATE_DIR=~/.cryptotrader-roy npx tsx scripts/signal-stats.ts
```

## Environment

Free-tier APIs work out of the box. Optional keys raise limits and unlock features:

| Variable | Service | What it gives you |
|---|---|---|
| `MEXC_API_KEY` / `MEXC_API_SECRET` | MEXC futures | **Required** for live positions + account stats (read-only OK) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram | **Required** for bot + alerts |
| `COINGECKO_API_KEY` | CoinGecko | 30 rpm vs 5 rpm anonymous |
| `BIRDEYE_API_KEY` | Birdeye | Better Solana coverage |
| `HELIUS_API_KEY` | Helius | On-chain holder/metadata |
| `ETHERSCAN_API_KEY` | Etherscan | Authoritative ETH contract verification |
| `GOPLUS_ACCESS_TOKEN` | GoPlus | Higher security-check rate limit |
| `COINGLASS_API_KEY` | CoinGlass | Funding extremes + OI history (post-validation) |

Multi-tenant: set `CRYPTOTRADER_ENV=/path/to/.env.<tenant>` and `CRYPTOTRADER_STATE_DIR=/path/to/.cryptotrader-<tenant>` to isolate signal logs, paper books, and credentials per persona.

## Architecture

```
src/
  cli.ts                   # DEX/spot entry
  cli-futures.ts           # futures entry
  bot.ts                   # interactive Telegram bot
  analyze.ts               # DEX token pipeline
  analyze-futures.ts       # multi-TF futures pipeline
  paper-portfolio.ts       # paper-trader state machine
  signal-log.ts            # JSONL signal recorder
  clients/
    mexc-futures.ts        # public perp klines, funding, OI
    mexc-private.ts        # signed positions/balance/history (read-only)
    telegram.ts            # HTML-mode sendMessage
    coinglass.ts           # funding / OI / liq aggregates
    dexscreener.ts / geckoterminal.ts / goplus.ts / honeypot.ts / rugcheck.ts
  analysis/
    trade-plan.ts          # leverage-aware stops + targets
    breakout.ts            # Donchian 20d + volume confirmation
    intermarket.ts         # Murphy BTC.D regime classifier
    indicators.ts          # SMA/EMA/RSI/ATR/OBV/Bollinger/swings/divergence
    patterns.ts            # Bulkowski-weighted candle patterns
    security.ts            # disqualifier rules
    lifecycle.ts           # memecoin phase classifier
    chart.ts / verdict.ts  # composite scoring
scripts/
  scanner-alerts.ts        # top-30 scan → Telegram digest
  positions-report.ts      # MEXC positions → recommendations
  paper-trader.ts          # paper book tick
  paper-analyze.ts         # weekly pattern review
  track-outcomes.ts        # signal-outcome backfill
  signal-stats.ts          # tenant W/L/R-multiples
  mexc-history.ts          # closed positions stats
  mexc-pattern.ts          # tail-loss diagnostic
docs/
  SESSION_STATE.md         # single source of truth for current state
  BACKTEST_RESULTS.md      # Aronson run on Stage 2 filter
  classical-ta.md          # Bulkowski / Murphy / Pring / Edwards-Magee
  crypto-ta.md             # memecoin lifecycle + manipulation patterns
  token-security.md        # ETH + SOL hard disqualifiers
  data-apis.md             # API endpoint reference
```

## Development

```bash
npm test                   # vitest, 158 tests
npm run test:coverage      # 80%+ on analysis/*
npm run typecheck          # tsc --noEmit
```

## References

Built from the canon TA references in `docs/`:

- Bulkowski — *Encyclopedia of Chart Patterns*, *Encyclopedia of Candlestick Charts* (pattern reliability stats)
- Murphy — *Technical Analysis of the Financial Markets* (intermarket)
- Pring — *Technical Analysis Explained* (momentum)
- Weinstein — *Secrets for Profiting in Bull and Bear Markets* (Stage 2 filter)
- DeMark — *The New Science of Technical Analysis* (sequential setups)
- Aronson — *Evidence-Based Technical Analysis* (statistical validation)
- Edwards & Magee — *Technical Analysis of Stock Trends* (classical TA)
- GoPlus, Honeypot.is, RugCheck official docs (security semantics)
- Solana SPL Token + Token-2022, Uniswap V2/V3, Raydium, Pump.fun official docs

## Not financial advice

Structured rules-based analysis. The market doesn't care about your rules.
