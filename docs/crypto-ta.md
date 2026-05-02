# Crypto-Native Chart Reading

Reference for low-cap / memecoin DEX analysis. Built for an automated scoring system: every pattern is described in candle shapes, volume ratios, time windows, liquidity thresholds, and trade-tape anomalies a coding agent can implement.

---

## 1. Memecoin lifecycle on DEX charts

Memecoins follow a remarkably consistent six-to-seven phase arc. **Recognizing the current phase is the most important classification problem** — the same chart shape (e.g., a 30% pullback) means "buy" in Phase 2 and "exit" in Phase 5.

| Phase | Duration | 1m / 5m signature | Volume | Buy/sell |
|---|---|---|---|---|
| **1. Stealth / sniped launch** | First 1–3 blocks | Single massive green candle, often >500% in one bar; near-zero wick on top | Volume column dwarfs everything for the first minute | 95%+ buys, 3–10 wallets |
| **2. Initial pump** | 5–60 min | Stairstep of green 1m candles, each 5–30%, with shallow red bodies between | Elevated, roughly constant per bar; not declining | 60–75% buys |
| **3. First dip / accumulation** | 15 min – 4 hr | Pullback 30–60% from local high, then sideways; lower wicks longer than upper; bodies shrink | Drops 60–80% from pump phase; occasional spikes on green bars | ~50/50, slight buy lean |
| **4. Parabolic / "god candle"** | 5–45 min | Near-vertical; 5m candles fully green with no upper wick; 1m candles often gap | Goes vertical — single 1m bars exceeding 5–20× recent average | 80%+ buys, FOMO |
| **5. Distribution top** | 10 min – 2 hr | Long upper wicks on 1m and 5m; price churns in 10–20% range at high; failed breakout retests | Stays high but buy/sell flips to 50/50 or sell-leaning despite price holding | Sells exceed buys in $-terms |
| **6. Bleed-out** | Hours to days | Lower highs, lower lows on 5m and 15m; red bodies dominant; small green pumps fail; declining range | Declines monotonically; brief spikes on capitulation | 55–70% sells |
| **7. Dead chart** | Indefinite | Flat-line with sporadic single-tick wicks (one trade per 10+ min); >90% drawdown from ATH | Near-zero | Random; sample too small |

### Phase identification rules

- **Phase = f(time since launch, drawdown from ATH, volume trend, body/wick ratio).**
- `bars_since_launch < 5` AND `last_candle_body_pct > 100%` → **Phase 1**.
- `volume_ma(5) > 3 * volume_ma(60)` AND `consecutive_green_bars >= 4` → Phase 2 or 4. Distinguish by `price_pct_from_launch`: <300% = Phase 2, >500% = Phase 4.
- `current_price < 0.7 * ath_price` AND `volume_ma(20) < 0.4 * volume_ma_at_ath` AND `range_compression < 0.5` → **Phase 3** (accumulation, potentially buyable).
- `upper_wick_avg(last 6 bars) > 2 * body_avg(last 6 bars)` at or near ATH → **Phase 5** (distribution).
- `price < 0.5 * ath_price` AND `lower_high_count >= 3` on 5m → **Phase 6**.

---

## 2. Pump-and-dump signatures

### Coordinated vs organic

| Feature | Organic | Coordinated (pump bot / call group) |
|---|---|---|
| Candle shape | Stairstep: green-red-green-red, each green slightly bigger | Single vertical 1m candle, 50–300% on one bar |
| Wick on pump candle | Small upper wick; closes near high | Long upper wick; closes mid-candle (dumpers selling into FOMO) |
| Trade tape | Mixed wallet sizes, varied amounts (0.13 SOL, 1.7 SOL, 0.05 SOL) | Round amounts (1.0, 5.0, 10.0 SOL), in clusters of 5–30 within 2s |
| Time-of-day | Any | Often aligned to a public Telegram/Discord call timestamp |
| Follow-through | Pulls back 20–40%, holds, pushes again | Drops 50–80% within 5–15 minutes; never recovers |

### Real-time detection rules
- `1m_candle_body_pct > 50%` AND `wallet_concentration_top5 > 70% of buy volume in that bar` → likely coordinated pump in progress; do not chase.
- After a >100% pump, if next 1m candle has `upper_wick > 2 * body` AND any negative body, treat as exhaustion.
- Trade-tape "round number" detector: >40% of buy txns in a 60s window with notional in {1.0, 2.0, 5.0, 10.0} (±1%) → coordinated.

---

## 3. Rug pull patterns

### Fast rug (LP pull)
- Single 1m candle dropping 95–99.9%.
- Bar before the rug often shows abnormally low volume — dev waited for organic interest to pause.
- Trade tape goes silent for minutes after; chart resumes as flat line.

### Slow rug
- 6–48 hours of monotonic decline of 2–10% per hour with no meaningful green candles.
- Volume above zero (the dev is selling) but buy volume collapses.
- 5m chart shows red bodies with **small upper wicks and minimal lower wicks** — seller absorbs every bid.

### Honeypot
- **Trade tape shows only buys, zero sells, ever.** Most reliable visual signature.
- Chart goes straight up because there is no sell pressure.
- Volume exclusively green.
- Rule: `sell_count_since_launch == 0` AND `buy_count > 20` → honeypot, 99% confidence.

### LP removal visual
- The candle showing the rug has body crashing to a price floor that is *exactly* the residual liquidity ratio (99% LP removed → price drops to ~1% of prior).
- Volume bar of that candle is moderate, not huge — only one or two wallets transacted.

---

## 4. Wash trading & bot detection

### Sniper / MEV bot signatures at launch
- **Block-0 buys, block-1 sells**: same wallet (or related) buys at launch tx and dumps within 1–3 blocks. First 1m candle has both high upper AND lower wick with body near open.
- On Solana (sub-second blocks): 5–15 buy txns followed within 1–3 seconds by 5–15 sell txns from related wallets, producing a doji-near first candle despite huge volume bar.

### Sandwich attacks
- 1m candle has sharp wick that immediately reverts within the same bar.
- Visual: "phantom wicks" on otherwise quiet bars. If wick:body ratio on a low-volume bar is >5:1, suspect MEV.

### Volume spoofing / wash
- Matched buys and sells from same wallet (or pair) within seconds, identical sizes.
- High volume bars with **no net price movement** — closes equal opens, body zero, repeated for many bars.
- "Checkered tape": alternating buy/sell of same size.
- Rule: `unique_wallets_per_bar(60s) / trade_count_per_bar(60s) < 0.2` AND `body_pct < 1%` → likely wash.

### Bots vs humans
- Sub-second consistency in trade timing (every 0.1–0.5s).
- Identical notional amounts repeatedly.
- Wallets created within last 24h doing all trading.
- No "dust" trades — humans buy odd amounts (0.137 SOL); bots buy round amounts.

---

## 5. Whale activity

### Accumulation (bullish)
- Multiple large green-bar trades **inside** a tight consolidation range, not at breakout points.
- Lower wicks on 5m bars get progressively longer over hours → whales bidding dips.
- Volume profile shows fat node at a specific price (becomes future support).

### Distribution (bearish)
- Large sells appear at or near local highs, often in a single bar with long upper wick.
- Trade tape: many small buys + 1–3 huge sells = textbook distribution.

### "Shake out" wick
- Before a real upward move, whale (or team) often triggers a 20–40% wick down on 1m to liquidate weak hands.
- Signature: long lower wick on 1m, immediate full recovery within 1–3 bars, then clean breakout.
- Distinguish from real dump: recovery happens within minutes on increasing volume; real dump bleeds.

---

## 6. Liquidity & market depth as chart context

A $10 trade on a $5k liquidity pool can produce a 2% candle. The chart is mostly noise.

**Always compute volume in USD**, never token-denominated.

| Liquidity | What a 50% pump means |
|---|---|
| <$20k | One person bought $5k. Noise. |
| $50–200k | Small group pushing. 20–50 buyers. Worth checking. |
| $200k–1M | Real interest, multiple wallets, organic possible. |
| >$1M | Significant event. Real narrative or large coordinated push. |

**Rule: do not trust any chart pattern unless `pool_liquidity_usd > $30k`.** Below that, all signals are low confidence.

Require minimum trade count per bar (>20 trades per 5m) before treating any pattern as signal.

---

## 7. DEX-specific quirks

### Uniswap V2 vs V3
- **V2**: constant-product (x*y=k). Slippage smooth and predictable. Charts "honest" but every trade moves price.
- **V3**: concentrated liquidity. Price moves violently when it exits a liquidity range — produces "step" candles where price gaps. Long wicks common when LP ranges sparse.
- On V3, a wick that doesn't return is often just price crossing into a thinner range, not rejection.

### Raydium vs Pump.fun bonding curve
- **Pump.fun pre-graduation**: bonding curve, deterministic. Each buy raises price along fixed curve. Chart shape monotonically related to net token supply purchased; pullbacks shallower than free-market AMMs.
- **"To Raydium" graduation**: at ~$69k market cap (Pump.fun threshold), liquidity migrates to Raydium/PumpSwap. Migration is a chart event — brief pause, then price gap.
- **Raydium**: standard AMM (V2-like) and CLMM (V3-like).

### Phantom wicks
- Multi-pool routing produces wicks on aggregator charts that didn't happen on the dominant pool.
- Always sanity-check the pool address; a wick on Dexscreener that doesn't match the largest pool's actual trades is a routing artifact.

---

## 8. Pump.fun specifically

### Bonding curve mechanics
- Constant-product-like curve where each buy distributes tokens at algorithmic price.
- ~800M tokens sold via curve before graduation; remaining ~200M form LP at migration.
- Price during bonding rises smoothly; chart looks logarithmic with steady demand.

### Pre-migration
- Smooth, less wicky than free-market AMMs (deterministic per-trade math).
- Bimodal volume profile: lots of small buys at low prices early, fewer larger buys near graduation.
- Flat-line pre-graduation = dead launch; almost certainly will not graduate.

### Post-migration
- Sudden volatility jump — wicks appear, slippage shows up.
- First 5–30 min post-migration extremely whippy as snipers/bots hit new pool.
- Many tokens dump 30–70% in first hour as early bonding-curve buyers take profit.

### "King of the Hill"
- Pump.fun surfaces highest-momentum token on homepage. Once "king," gets large secondary inflow purely from visibility.
- Chart signature: sudden inflection upward in slope after period of moderate growth, no obvious news catalyst.
- Losing king status often correlates with first major dump.

---

## 9. Time-of-day patterns

| UTC window | Pattern |
|---|---|
| 00:00–08:00 | Asian session — alt-pumps on lower-cap memes more common; thinner USD-stable liquidity |
| 13:00–21:00 | US session — highest overall liquidity; biggest organic moves; most KOL tweets |
| 21:00–23:00 Sun | "Sunday-night dump" — risk-off into the week's open |
| 19:00–22:00 Fri | "Friday afternoon" exit — closing positions before weekend illiquidity |
| Saturday all day | Lowest liquidity of week → wicks both directions exaggerated |

Discount the meaningfulness of a 30% wick on Saturday by ~50% vs same wick during US session.

---

## 10. Sentiment as leading indicator

- A mention spike that *precedes* a price move by 5–15 min is the bullish setup.
- A mention spike that *coincides with or trails* a price move is the top.
- KOL call signature: vertical green 1m candle within 2 min of a known KOL tweet; high upper wick within 10 min; usually shortable, not buyable, after the initial 1-min spike.
- Capital rotates between narratives in cycles of days to weeks. A token whose narrative rotated *out* in last 48h shows declining volume despite holders waiting.

---

## 11. Red flags from chart alone

Trigger any → do not buy:

- Trade tape: zero sells after 20+ buys → **honeypot**
- First 1m candle body > 500% with all volume from <5 wallets → sniper-controlled launch
- Volume bar 5–20× recent average AND price already 5×+ from launch → parabolic top, do not chase
- Long upper wicks (>2× body) on 3+ consecutive 5m bars at ATH → distribution underway
- Single red 1m candle of −40%+ with no preceding accumulation → dev/whale dumped
- Liquidity < $30k → ignore all chart patterns
- Wash signature: high volume bars with body near zero, repeated, same wallets
- Price has bled −50%+ from ATH on declining buy:sell ratio over 6+ hours → slow rug or organic death
- Pool age < 5 min AND price already 50×+ from launch → bot-driven
- Chart shape "vertical green → vertical red → flat" within 30 min → P&D completed
- Pump.fun token at <30% bonding curve for >4 hours → stalled, will not graduate
- Phantom wick that doesn't appear on main pool's trade tape → routing artifact, ignore
- Trade timing at sub-second intervals with identical notional sizes → bots
- Friday 19:00–22:00 UTC pump on low-cap with no narrative → likely weekend exit trap
- Mention spike on social *trailing* a price spike → top is in or near

---

## 12. Green flags from chart alone

The boring chart is the buyable chart.

- **Stairstep up**: 1m and 5m alternating green/red with green bodies slightly larger; pullbacks of 20–40% bought back within 15–60 min.
- **Shallow pullbacks on declining volume**: corrective volume shrinks while bullish volume holds steady.
- **Multi-day base**: held above 50% of ATH for >24h after initial pump, consolidating range, no panic capitulation.
- **Higher lows on 15m and 1h**: cleanly trending up.
- **Volume profile**: fat node forming at new higher level (re-anchoring of holder cost basis above prior support).
- **Whale accumulation tape**: 3+ visibly large buys ($5k+) inside the consolidation range, not at breakouts.
- **Long lower wicks on 5m that recover within 1–3 bars**: shake-outs, then continuation.
- **Buy:sell ratio 55–65%** sustained over hours (not 90%+ of fake pump, not 50/50 of distribution).
- **Liquidity > $100k AND growing**.
- **Mentions leading price** by 10–20 min consistently across multiple recent moves.
- **Holder count growing faster than volume**: broadening base.
- **Re-tests of prior breakout levels hold**.
- **Time-of-day alignment**: breakout starting in US session (14:00–18:00 UTC) on a Tuesday–Thursday.

### Composite "healthy low-cap" profile
- Age: 12–72 hours.
- Liquidity: $100k–$1M, growing.
- Drawdown from ATH: 30–50%, recovered to within 20% of ATH.
- Volume: declining during pullbacks, rising during pushes.
- Trade tape: diverse wallet sizes, dust trades present (humans), 100+ unique wallets per hour.
- Buy/sell: 55–65% buy.
- Phase: Phase 3 (accumulation) transitioning to Phase 2-like behavior (renewed organic pump).

---

## Operationalization notes

- Compute most metrics on rolling windows: 1m, 5m, 15m, 1h.
- Normalize all volume metrics in USD, never in token units.
- Use trade-tape unique-wallet count per minute as proxy for "humanness".
- Phase classification = single categorical output (1–7) feeding downstream rules.
- Score = (phase-conditioned green flags) × (1 − red flag severity), with hard zero on any honeypot or rug detection.
- **Liquidity threshold is the most important gating filter** — below ~$30k, do not produce a buy signal regardless of other signals.
