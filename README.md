# cryptotrader

Give it a token address (Ethereum or Solana). Get a `BUY` / `WAIT` / `AVOID` verdict.

```
$ cryptotrader 0x6982508145454Ce325dDbE47a25d4ec3d2311933

 WAIT   composite 68/100

Pepe (PEPE/WETH)
  ETHEREUM · uniswap · 0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f
  Price: $0.000003923 · Liq: $27.42M · 24h vol: $284.1k · Age: 1113.8d

Security ████████░░ 76/100
  ⚠ [goplus] Blacklist function present
  ⚠ [goplus] LP only 0% locked (V3/blue-chip — context applies)

Phase: unknown — age: 26731h · drawdown from ATH: 2.0%

Chart ██████░░░░ 51/100
  · HTF trend flat
  · RSI 55 momentum healthy
  · Bullish patterns: bullishEngulfing
```

## What it does

Takes a single token address and outputs a verdict by combining:

1. **Hard security disqualifiers** — honeypot detection, mint/freeze authority (Solana), hidden owner, sell tax > 15%, top wallet > 30%, LP not locked, etc. Any one fails → AVOID.
2. **Lifecycle phase classification** — for memecoins: stealth launch / initial pump / accumulation / parabolic / distribution / bleed-out / dead. The same chart shape means different things in different phases.
3. **Classical TA scoring** — trend (EMA), RSI, candle patterns (Bulkowski-weighted), divergence, volume confirmation.
4. **Composite verdict** — `BUY` only when security is high AND phase is buyable AND chart is healthy AND liquidity is real.

## Install

```bash
git clone <repo>
cd cryptotrader
npm install
npm run build       # compiles TS to dist/
```

## Usage

```bash
# Run via tsx (no build needed)
npm run dev -- <address>

# Or after build
node dist/cli.js <address>

# JSON output (for scripting)
npm run dev -- <address> --json
```

Examples:

```bash
npm run dev -- 0x6982508145454Ce325dDbE47a25d4ec3d2311933   # PEPE
npm run dev -- EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm # WIF
```

Exit codes: `0` for BUY/WAIT, `2` for AVOID, `1` on invocation error.

## API keys (optional)

The tool runs entirely on free, no-key APIs by default (DexScreener, GeckoTerminal, GoPlus, Honeypot.is, RugCheck). Optional keys raise rate limits and unlock additional Solana-specific data:

```bash
cp .env.example .env
# Edit .env to add any keys you have
```

| Variable | Service | Tier needed | Notes |
|---|---|---|---|
| `BIRDEYE_API_KEY` | Birdeye | Free 30k CU/mo | Better Solana token + OHLCV coverage |
| `HELIUS_API_KEY` | Helius | Free 1M credits/mo | Direct on-chain holder/metadata reads |
| `ETHERSCAN_API_KEY` | Etherscan | Free 100k req/day | Authoritative contract verification |
| `GOPLUS_ACCESS_TOKEN` | GoPlus | Free signup | Higher rate limit (vs ~30 req/min anonymous) |

## Architecture

```
src/
  cli.ts              # entry: parse arg, call analyze, format output
  analyze.ts          # orchestrator: fetch in parallel, compose verdict
  chain.ts            # detect ethereum vs solana from address
  config.ts           # env vars + base URLs
  http.ts             # fetch with timeout + retry
  schemas.ts          # Zod schemas for all API responses
  format.ts           # CLI verdict pretty-printer
  clients/            # one file per API
    dexscreener.ts    # pool discovery, liquidity, 24h stats
    geckoterminal.ts  # OHLCV (1m / 5m / 1h / 1d)
    goplus.ts         # token security (multi-chain)
    honeypot.ts       # sell simulation (EVM only)
    rugcheck.ts       # Solana risk score + holder graph
  analysis/           # pure functions, no I/O
    indicators.ts     # SMA, EMA, RSI, ATR, OBV, Bollinger, swings, divergence
    patterns.ts       # candle pattern detection
    security.ts       # disqualifier rules + security score
    lifecycle.ts      # memecoin phase classification
    chart.ts          # composite chart score
    verdict.ts        # final BUY/WAIT/AVOID composition
tests/                # vitest, 65 tests, 86%+ coverage on analysis modules
docs/
  classical-ta.md     # Bulkowski-cited TA reference
  crypto-ta.md        # memecoin lifecycle, rug/honeypot/wash patterns
  token-security.md   # ETH + SOL hard disqualifiers, locker addresses
  data-apis.md        # API endpoint reference
```

## How verdicts are decided

The composer applies these rules in order:

1. **Any fatal security finding** → AVOID, composite 0.
2. **Liquidity < $10k** → AVOID (untradeable, exit liquidity for snipers).
3. **Phase says avoid** (parabolic, distribution top, bleed-out, dead, stealth-launch) → AVOID.
4. Otherwise compute composite = `0.40 × security + 0.20 × phase + 0.25 × chart + 0.15 × liquidity`.
5. **BUY** if composite ≥ 70 AND phase is buyable AND security ≥ 70.
6. **WAIT** if composite ≥ 50.
7. Otherwise **AVOID**.

## Hard security disqualifiers

Any one triggers AVOID:

**Universal:**
- Honeypot detected (Honeypot.is or GoPlus)
- Sell tax > 15%
- `cannot_sell_all` flag set
- Top non-LP wallet > 30% of supply
- Liquidity < $10k
- LP not locked AND not burned (held by EOA — V2 only)

**Ethereum:**
- Unverified contract source > 24h after launch
- Hidden owner / can take back ownership
- Owner can rewrite balances
- `selfdestruct` enabled
- Mintable + owner not renounced
- Tax modifiable + current sell tax > 5%

**Solana:**
- Mint authority not null (unless allow-listed stablecoin)
- Freeze authority not null (same exception)
- Token-2022 with `permanentDelegate`, `transferHook`, or `defaultAccountState=Frozen`
- RugCheck flag at danger level
- Insider cluster > 40% of supply
- `rugged: true`

## Limitations & caveats

- **Memecoin-tuned.** Lifecycle phases are designed for low-cap launches. For mature blue-chips (USDC, ETH, established DeFi tokens), the phase classifier will return "unknown" — that's expected and fine.
- **Pair selection** — for tokens with many DEX listings, the picker chooses the highest-liquidity standard-AMM pool where the queried address is the base token. Edge cases (e.g., USDC searched on Solana) can pick a less-canonical pool.
- **Free-tier rate limits** — GeckoTerminal allows ~30 req/min unauthenticated. The tool sequences OHLCV calls to stay under the cap; back-to-back analyses of many tokens may need pacing.
- **Honeypot detection is EVM-only** — Solana doesn't have an equivalent sell-simulation API today. The tool relies on RugCheck heuristics and freeze-authority checks instead.
- **No live execution.** This is read-only analysis. It does not place trades.
- **Not financial advice.** It's a structured opinion based on rules. The market doesn't care about your rules.

## Development

```bash
npm test                 # run all tests
npm run test:coverage    # coverage report (target: 80% on analysis/*)
npm run typecheck        # tsc --noEmit
npm run dev -- <addr>    # run CLI without build
```

## References

The four research documents under `docs/` are the source of truth for the rules implemented in `src/analysis/`. They're built from:

- Bulkowski's *Encyclopedia of Chart Patterns* and *Encyclopedia of Candlestick Charts* — pattern reliability statistics
- Murphy, Edwards & Magee — classical TA
- GoPlus, Honeypot.is, RugCheck official API docs — security check semantics
- Solana SPL Token + Token-2022 program docs — mint/freeze/extension semantics
- Official Uniswap V2/V3, Raydium, Pump.fun docs — LP mechanics
