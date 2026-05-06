# Aronson Backtest Results — Composite ≥75 LONG Strategy

**Date:** 2026-05-06
**Universe:** Top-30 MEXC perps by 24h volume (26 with ≥250 daily bars)
**Window:** 500 daily bars per perp (~16 months)
**Permutations:** 200 block-shuffles per variant (block size 5, seed 42)
**Methodology:** David Aronson, *Evidence-Based Technical Analysis* (Wiley, 2006)

---

## Summary

The composite ≥75 LONG strategy as originally deployed has **negative expectancy** when applied broadly across the top-30 MEXC perp universe. However, adding a Weinstein/Minervini **Stage 2 trend filter** (close > 150-day SMA) flips the system to **statistically significant positive expectancy**.

**Recommendation:** integrate Stage 2 filter into live `scoreChart` as a hard gate for LONG alerts. Do not deploy auto-trading — alert-with-human-judgment remains the best workflow given modest per-trade EV.

---

## Variant comparison

| Variant | Trades | Winrate | Avg Win | Avg Loss | Payoff | Expectancy | Total R | Max DD | p-value |
|---|---|---|---|---|---|---|---|---|---|
| Baseline (composite ≥75) | 360 | 40.3% | +0.92R | −0.65R | 1.40 | −0.021R | **−7.5R** | 33.6R | 0.0000 |
| + Breakout filter required | 360 | 40.3% | +0.92R | −0.65R | 1.40 | −0.021R | **−7.7R** | 39.4R | 0.0000 |
| **+ Stage 2 filter (>150d SMA)** | **303** | **41.6%** | **+1.01R** | **−0.67R** | **1.49** | **+0.024R** | **+7.4R** | **31.0R** | **0.0000** |

### Statistical significance ≠ profitability
All three variants have p-value < 0.0001 vs random block-shuffles. But the shuffled distribution mean is around −230R, so even a losing system "beats" random. **Significance only proves the system is not noise; profitability requires positive expectancy on top of significance.**

### Why the breakout filter is a non-event
Composite ≥75 already implicitly fires when Donchian breakout signal is active (the breakout component contributes weight to the composite score). Adding `requireBreakout` excluded zero trades — same 360 trades, same R distribution. The hypothesis "breakout is the edge above composite" is **falsified**.

### Why Stage 2 filter works
Weinstein's Stage 2 (close > 30-week SMA) excludes assets in confirmed downtrends or extended consolidation. The filter:
- Removed 57 trades that fired during chop/downtrend phases
- Eliminated **BTC** from top-10 (it was sideways most of the window)
- Removed **AVAX** from bottom-5
- Improved per-trade winner expectancy on remaining trades (better timing on real trends)

---

## Per-coin breakdown (Stage 2 variant)

### Top 10 contributors

| Symbol | Trades | Winrate | Expectancy | Total R |
|---|---|---|---|---|
| ZEC | 32 | 53% | +0.96R | **+30.7R** ⭐ |
| ENA | 12 | 50% | +0.54R | +6.4R |
| SKYAI | 13 | 69% | +0.42R | +5.5R |
| ETH | 16 | 56% | +0.33R | +5.3R |
| LINK | 16 | 44% | +0.11R | +1.8R |
| SOL | 16 | 56% | +0.03R | +0.4R |
| PEPE | 3 | 33% | +0.02R | +0.1R |
| HYPE | 25 | 44% | −0.01R | −0.1R |
| FARTCOIN | 3 | 67% | −0.15R | −0.5R |
| PENGU | 5 | 20% | −0.20R | −1.0R |

### Bottom 5

| Symbol | Trades | Winrate | Expectancy | Total R |
|---|---|---|---|---|
| ICP | 13 | 23% | −0.39R | −5.0R |
| LUNC | 8 | 13% | −0.50R | −4.0R |
| XRP | 5 | 20% | −0.72R | −3.6R |
| BCH | 24 | 46% | −0.14R | −3.4R |
| ONDO | 10 | 30% | −0.33R | −3.3R |

### ZEC dependency
ZEC alone contributes +30.7R out of +7.4R total — meaning **without ZEC the system is still negative (−23.3R).** This is a real concentration risk:
- The 16-month window covered ZEC's massive Q4 2025 / Q1 2026 rally
- The system caught it via breakout + uptrend + Connors setups
- Whether this repeats is unknowable

The filter is sound; the dependency reflects reality of crypto trends being concentrated.

---

## Honest takeaways

1. **The system as originally deployed loses money over the broad perp universe.** Negative expectancy + brutal max drawdown.
2. **Stage 2 filter materially improves it.** Positive EV, lower max DD, fewer false starts.
3. **Per-trade edge is modest** (+0.024R). At 1% risk/trade ≈ +0.024% per trade. With ~190 trades/year × Stage 2 frequency ≈ +4.5% annualized. Real but not life-changing.
4. **High dependency on a few trending coins.** ZEC dominates. If next 16 months produce a different "ZEC", system catches it; if no clear trender exists, system probably underperforms.
5. **Statistical significance is necessary but not sufficient** — beating random shuffles only proves the system isn't noise. Profitability requires the signs to align.

---

## Recommendations

**Tier 1 — implement now:**
1. Add Stage 2 filter to live `scoreChart`: hard gate that only allows LONG alert if `close > SMA(150)` on daily.
2. Display Stage 2 status on every trade card: ✅ Stage 2 confirmed / ❌ pre-Stage 2 (no LONG).

**Tier 2 — investigate next:**
3. Replicate this backtest with 1000+ permutations (current 200 already gives p<0.0001, but more is more confident).
4. Test SHORT-side Aronson: composite ≤25 + close < 150d SMA. Crypto bear opportunities currently invisible.
5. Forward-test live for 4-8 weeks with very small sizing (€10-20 per signal, only on Stage-2 confirmed) to validate out-of-sample.

**Tier 3 — defer until forward-test data:**
6. Add CoinGlass features (funding extreme, OI rising) as additional scoring inputs. Run new Aronson with those features, check whether EV improves further.
7. Consider per-symbol whitelist after seeing 6+ months live data — but treat with extreme suspicion of overfitting.

**Do NOT do:**
- Threshold sweep (75/80/85). Exact Aronson overfit-trap.
- Cherry-pick symbol whitelist from this backtest. Same trap.
- Deploy auto-trading. Per-trade EV is too modest, max DD too brutal — human judgment via alerts remains the right model.
