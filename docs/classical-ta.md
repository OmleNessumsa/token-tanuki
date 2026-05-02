# Classical Technical Analysis Reference

Reference compiled from Bulkowski's *Encyclopedia of Chart Patterns* and *Encyclopedia of Candlestick Charts*, Murphy's *Technical Analysis of the Financial Markets*, Edwards & Magee's *Technical Analysis of Stock Trends*, and Investopedia. Pattern statistics are Bulkowski's bull-market figures unless otherwise noted.

---

## 1. Candlestick patterns

A candlestick is one period of OHLC. Body = open→close range, wick/shadow = high/low extreme. Color = close vs open. Patterns are 1–5 candles. Bulkowski tested 103 candle types; most candles are near-random (50–55%) without context. Reliability comes from *location* (at S/R, end of trend) and *volume confirmation*. **A candlestick is a trigger, never a standalone signal.**

### Single-candle patterns

| Pattern | Body | Wick rule | Direction | Bulkowski reversal rate | Use |
|---|---|---|---|---|---|
| Hammer | Small, near top | Lower wick ≥ 2× body, tiny upper | Bullish reversal at downtrend bottom | ~60% | Signal only at support after ≥3-bar decline |
| Inverted hammer | Small, near bottom | Upper wick ≥ 2× body, tiny lower | Bullish reversal at downtrend bottom | ~60% | Requires next-bar bullish confirmation |
| Hanging man | Same shape as hammer | At top of uptrend | Bearish reversal | ~59% | Weak alone; needs bearish next bar |
| Shooting star | Same shape as inverted hammer | At top of uptrend | Bearish reversal | ~59% (Bulkowski "near random") | Score only with volume + trend context |
| Doji | Open ≈ close | Either wick | Indecision | ~50% | Modifier only — reduce trend confidence |
| Dragonfly doji | O=C at top of bar | Long lower wick | Bullish reversal at bottom | ~50–55% | Stronger doji at support |
| Gravestone doji | O=C at bottom | Long upper wick | Bearish reversal at top | ~50–55% | Stronger doji at resistance |
| Marubozu | Full body, no wicks | — | Strong continuation | ~55% | Trend-strength score, not entry |
| Spinning top | Small body, both wicks moderate | — | Indecision | ~50% | Doji-equivalent modifier |

### Multi-candle patterns (ranked by Bulkowski reliability)

| Pattern | Candles | Bull-market rate | Notes |
|---|---|---|---|
| Three line strike (bullish reversal) | 4 | 84% | Very rare, very high confidence |
| Three white soldiers | 3 | 82% | Three long bullish bodies, each closing near high |
| Three black crows | 3 | 78–79% bearish | Three long bearish bodies, each opening within prior body |
| Morning star | 3 | 78% bullish | Long red, small body (gap down), long green closing into first body |
| Evening star | 3 | 72% bearish | Mirror of morning star |
| Bullish/bearish abandoned baby | 3 | 69–70% | Star variant with doji + gaps both sides; very rare |
| Bullish engulfing | 2 | 55–63% | Green body fully engulfs prior red; +2× volume = strong |
| Bearish engulfing | 2 | 55–63% | Mirror |
| Piercing line | 2 | ~58% bullish | Green closes above midpoint of prior red |
| Dark cloud cover | 2 | ~58% bearish | Mirror of piercing |
| Bullish/bearish harami | 2 | ~53% | Weak alone |

### Required context for any candle pattern
1. **Location**: at horizontal S/R, trendline, MA (20/50/200), or VWAP.
2. **Trend state**: reversal patterns require an existing trend of ≥5 bars in the opposite direction.
3. **Volume**: confirmation candle should have ≥1.5× SMA(20) volume.
4. **Confirmation bar**: next candle must close in the pattern's signaled direction for entry.

### Classification for scoring
- **Signal-grade** (high weight): three white soldiers, three black crows, morning/evening star, abandoned baby, three line strike.
- **Trigger-grade** (medium, requires confluence): hammer, inverted hammer, shooting star, hanging man, engulfing, piercing line, dark cloud cover.
- **Modifier-only** (do not enter on these): doji variants, spinning top, marubozu, harami, tweezers.

---

## 2. Chart patterns

All percentages are Bulkowski bull-market stats. "Break-even failure" = price fails to move ≥5% from breakout.

### Reversal patterns

| Pattern | Failure rate | Avg move | Throwback/pullback | Target | Volume |
|---|---|---|---|---|---|
| Head & shoulders top | 4% | -22% | 50% pullback | Neckline − head height | Decreasing across L-H-R; spike on neckline break |
| Inverse H&S | 3% | +38% | 45% throwback | Neckline + head depth | Volume rises on right shoulder + breakout |
| Double top | 11% | -19% | 61% pullback | Neckline − peak-to-trough | Lower volume on 2nd peak; surge on neckline break |
| Double bottom | 4% | +37% | 64% throwback | Neckline + depth | Higher volume on 2nd bottom + breakout |
| Triple top | 10% | -19% | 61% | Same as double top | Declining volume on each peak |
| Triple bottom | 4% | +37% | 64% | Same as double bottom | Rising volume on breakout |
| Rounding bottom | Lowest failure (rank 1 up) | +43% | 40% | Cup depth | Mirrors curve (low at center, rising at edges) |
| Falling wedge (reversal) | Low | +32% | 56% | Wedge high | Volume declines, spikes on breakout |
| Rising wedge (reversal) | Worst — rank 31 up, 36 down | -14% on down break | 73% | Wedge low | Volume declines through pattern |

Updated inverse H&S (2,800+ trades): 19% break-even failure, 81% break neckline by ≥5%, but only **51% reach the full measured move**. Calibrate targets accordingly.

### Continuation patterns

| Pattern | Failure | Avg move | Target | Notes |
|---|---|---|---|---|
| **High & tight flag** (≥90% gain in ≤2 months, then small consolidation) | **0%** (lowest) | **+69%** (253 samples) | Flagpole height + breakout | Heavy on pole, contraction in flag, surge on breakout |
| Cup with handle | 5% | +34% | Cup depth + breakout | Only 63% hit target; 47% drop within 2 months |
| Symmetrical triangle (up break) | 9% | +31% | Triangle height added | Volume contracts through, expands on breakout |
| Ascending triangle | 13% (up) | +35% | Flat top + height | Same |
| Descending triangle | 16% (down) | -16% | Flat bottom − height | Same |
| Bull flag | 4% | +23% | Flagpole height | Heavy pole, light flag, surge on breakout |
| Bear flag | 8% | -12% | Mirror | |
| Pennant | 7% (up) / 16% (down) | +24% / -16% | Pole height | Contracting volume, breakout surge |
| Rectangle top (up break) | 9% | +39% | Rectangle height | Edge-touches with volume |

### Identification rules
- **Triangle**: ≥4 trendline touches (2 upper, 2 lower); converging slopes; breakout in 2/3 of distance to apex.
- **Flag**: prior strong move ("pole") of ≥15%; consolidation slopes counter-trend; duration <3 weeks daily / proportional intraday.
- **H&S**: 3 peaks where middle > outer two, outer two within 10% of each other; neckline through reaction lows.
- **Double top/bottom**: peaks within 3% of each other, separated by ≥10 bars; valley between ≥10% retrace.
- **Cup**: U-shape (not V), depth 12–33%, duration 7+ weeks daily; handle <½ cup depth, drift down 1–4 weeks.

### Failure modes
- **Throwback/pullback** within 30 days **hurt performance** by ~10pp. Patterns without them outperform.
- **Premature breakout** (gap-and-fail) on volume <1.5× average → low confidence.
- **Apex breakout in triangles** (last ⅓ of distance) underperforms.

---

## 3. Trend, S/R, volume

### Trendlines
- ≥3 touches to be valid; 2 = tentative.
- Drawn through extremes (wicks) for conservative; through bodies for aggressive (use bodies on log charts for high-volatility crypto).
- Steeper trendlines (>45°) break sooner.
- A break is confirmed by a close beyond the line by >0.5 ATR (or 1× ATR for noisy markets).

### Horizontal S/R
- Cluster swing highs/lows within 0.5–1% of price for liquid assets, 2–3% for crypto small-caps.
- **Strength factors**: (a) ≥3 touches, (b) higher timeframe, (c) high volume at level, (d) recency, (e) round numbers, (f) prior all-time-highs are major.
- **Role reversal**: broken resistance becomes support and vice versa; valid for ~30–60 bars post-break.

### Supply/demand zones
- Zone = candle body range immediately preceding a strong directional move (≥3 bars same direction, ≥2 ATR).
- Fresh until tested; first retest = highest probability.

### Volume tools

| Tool | Use |
|---|---|
| Volume SMA(20) | Confirmation threshold (1.5× = significant) |
| VWAP | Intraday fair value; price > VWAP = institutional bullish bias |
| OBV | Divergence signal; OBV must trend with price; OBV new high before price = bullish |
| A/D line | Weighted OBV using close position in range; less noisy |
| CMF (Chaikin Money Flow, 20) | >0 accumulation, <0 distribution; >0.25 strong |
| Volume Profile | HVN = S/R, LVN = gaps prices traverse fast, POC = max-volume price |

**Any breakout signal without volume ≥1.5× SMA(20) should have its score halved.**

---

## 4. Indicators

### Moving averages
- SMA / EMA (defaults: 20, 50, 200; fast: 9, 21, 50)
- Golden cross (SMA50 > SMA200) / death cross — long-term regime filter, lags badly
- EMA ribbon (8/13/21/34/55) — all stacked + sloping = strong trend; tangling = chop

### Oscillators

| Indicator | Default | Signal | False signal |
|---|---|---|---|
| RSI | 14 | >70 OB, <30 OS; **divergence** is the high-value signal | In strong trends, RSI sits >70 or <30 — do NOT counter-trade |
| Stochastic | 14,3,3 | %K crosses %D in OB/OS | Whipsaws in chop |
| MACD | 12,26,9 | Cross above signal = bullish; histogram momentum; divergence | Signal-line crosses near zero are noise |
| Bollinger Bands | 20,2 | **Squeeze** (band width <6-month low) precedes expansion; **walk** along upper band = strong trend | Counter-trading bands in trends loses |
| ATR | 14 | Stop sizing and position sizing only — never direction | — |
| Parabolic SAR | 0.02, 0.2 | Trend-following stop; flips on close | Whipsaws in ranging markets |

### Independent vs redundant indicators

| Type | Pick one |
|---|---|
| Trend | SMA, EMA, MACD line, Ichimoku, PSAR |
| Momentum | RSI, Stochastic, MACD histogram, ROC |
| Volatility | Bollinger, ATR, Keltner |
| Volume | OBV, A/D, CMF, VWAP |

**Recommended stack:** EMA(50)/EMA(200) + RSI(14) + Bollinger(20,2) + OBV. Four dimensions, no redundancy.

---

## 5. Multi-timeframe analysis

| Decision | Timeframe | Read |
|---|---|---|
| Bias / regime | 1D | Trend direction (200 SMA), major S/R, dominant pattern |
| Setup | 4H | Pattern formation, S/R retest, indicator alignment |
| Trigger / entry | 1H or 15m | Candlestick trigger, micro-structure break, volume spike |

Rules: only take **long** signals on LTF if HTF trend is up or neutral. HTF S/R levels override LTF levels at the same price. Smallest used TF for entry should be ≥1/8th of HTF.

Crypto-specific: 24/7 market, no session opens; UTC midnight is conventional daily close. Use VWAP anchored to recent significant event (token launch, swing low) rather than session VWAP.

---

## 6. Risk management

- **Position sizing**: 1–2% of equity per trade (Tharp). For crypto small-caps cap at **0.5–1%**.
- **R-multiples**: 1R = dollar risk on the trade. Express all P&L in R. E = (win% × avg win R) − (loss% × avg loss R). Need E > 0 after fees/slippage.
- **Stops**: structure (below swing low + 0.25–0.5 ATR), or ATR-based (Entry − k × ATR(14), k = 1.5–3). Avoid percent-based stops.
- **Reward:risk minimum 2:1**. With 2:1 and 40% win rate → positive expectancy.
- **Why retail fails**: oversized positions, no stops, averaging losers, overtrading low-edge setups, no journaling, costs eroding small edges.

---

## 7. Divergence

- **Bullish regular**: price LL, oscillator HL → downtrend exhaustion (reversal).
- **Bearish regular**: price HH, oscillator LH → uptrend exhaustion (reversal).
- **Bullish hidden** (continuation in uptrend): price HL, oscillator LL → pullback ending.
- **Bearish hidden** (continuation in downtrend): price LH, oscillator HH → retracement ending.

Validity: confirmed swings (fractal: higher than 2 bars on each side), 5–60 bars apart, oscillator uses closes. RSI divergences below 30 / above 70 carry more weight. Triple divergence > double.

---

## 8. What does NOT work

| Concept | Status |
|---|---|
| Elliott Wave (for retail) | Folklore — wave counts subjective and revised post-hoc; no peer-reviewed forecasting power |
| Fibonacci as predictive | Weak — 38.2/50/61.8 work no better than other round retracements; self-fulfilling clustering, not market memory |
| Gann angles, Gann squares | Folklore |
| Harmonic patterns (Gartley, Bat, Butterfly, Crab) | Backtests near random when properly out-of-sample |
| Most "secret" candle patterns | Noise — only ~10–15 patterns show meaningful edge with proper context |
| Ichimoku as standalone system | Weak — works as visual trend filter, not signal generator |
| Lunar / astro-trading | Folklore |
| Williams %R, CCI as primary | Redundant with RSI/Stochastic |

### What DOES have empirical support
- **Trend persistence / momentum**: Jegadeesh & Titman (1993) — 3–12 month momentum is one of the most robust anomalies.
- **Mean reversion** at very short (≤5d) and very long (3–5y) horizons.
- **Volume confirmation**: breakouts on high volume have measurably higher follow-through.
- **Volatility breakout** (Donchian, Turtle): documented profitability in trending markets.
- **High & tight flag** (Bulkowski): 0% break-even failure, +69% average rise.
- **Inverse H&S, double bottom, rounding bottom**: lowest-failure bullish patterns.

---

## Scoring rubric

| Component | Weight | Inputs |
|---|---|---|
| HTF trend | 25 | Price vs SMA(200), HTF higher-highs/higher-lows |
| Chart pattern | 20 | Recognized pattern + Bulkowski reliability + breakout confirmation |
| Candlestick trigger | 10 | Signal-grade pattern at S/R within last 1–3 bars |
| S/R context | 15 | Distance to nearest S/R; strength of level |
| Volume | 15 | Breakout vol ≥1.5× SMA(20); OBV/A/D trending with price |
| Momentum | 10 | RSI direction, MACD histogram sign, divergence presence |
| R:R feasibility | 5 | Computed target / stop ≥ 2 |

Reject ("not a good buy") if: HTF downtrend AND no clear reversal pattern; OR R:R <1.5; OR volume confirmation absent on triggering bar; OR price is mid-range with no proximate S/R edge.

---

## Sources
- Bulkowski, T. *Encyclopedia of Chart Patterns*, 3rd ed., Wiley.
- Bulkowski, T. *Encyclopedia of Candlestick Charts*, Wiley, 2008.
- thepatternsite.com — Bulkowski's online statistics database.
- Murphy, J. *Technical Analysis of the Financial Markets*, NYIF.
- Edwards, R.D., Magee, J. *Technical Analysis of Stock Trends*, 11th ed.
- Tharp, V. *Trade Your Way to Financial Freedom* (position sizing).
- Jegadeesh & Titman (1993), *Returns to Buying Winners and Selling Losers*.
