# Books Implemented — What Each Source Contributes

Every recommendation in this tool comes from a citable source. This document maps each
implemented book to the code that uses it.

## Tier 1 — Canon

### Bulkowski — *Encyclopedia of Chart Patterns* (3rd ed., 2021)
**Source data:** [`src/data/bulkowski-chart-patterns.json`](../src/data/bulkowski-chart-patterns.json) (48 patterns)
**Code:** [`src/analysis/weights.ts`](../src/analysis/weights.ts) → `getChartPatternWeight()`
**What it gives us:** Empirical statistics per pattern: failure rate, avg move, throwback %,
target-hit %. These are converted into 0–20 weights via `(1 - failure/100) × √avgMove × 2`.
Top weights:
- High & Tight Flag: **16.6** (0% failure, +69% avg)
- Double Bottom: **12.1** (4% / +40%)
- Inverse H&S: **12.0** (4% / +39%)
- Cup with Handle: **11.1** (5% / +34%)

### Bulkowski — *Encyclopedia of Candlestick Charts* (2008)
**Source data:** [`src/data/bulkowski-candlestick.json`](../src/data/bulkowski-candlestick.json) (52 patterns)
**Code:** [`src/analysis/weights.ts`](../src/analysis/weights.ts) → `getCandleWeight()`
**What it gives us:** Reversal/continuation reliability rates from a 4.7M-candle study,
plus the master "overall rank" that orders 103 patterns by performance.
Top reliability: Three Stars in the South (86%), Three-Line Strike Bearish (84%),
Three White Soldiers (82%).

### Murphy — *Technical Analysis of the Financial Markets* (1999)
**Source PDF:** scanned (no embedded text), so concepts encoded directly.
**Code:** [`src/analysis/intermarket.ts`](../src/analysis/intermarket.ts), [`src/analysis/indicators.ts`](../src/analysis/indicators.ts)
**What it gives us:** RSI/MACD/EMA formulas in `indicators.ts` follow Murphy's standard
definitions. Murphy's Ch. 17 (Intermarket Analysis) is operationalized as `getIntermarketContext()`
which fetches BTC's 24h/7d % change and classifies the market regime
(`btc_dump`, `btc_dominance_rising`, `altseason`, `neutral`) — outputs a multiplier
applied to alt-long verdicts.

### Edwards/Magee/Bassetti — *Technical Analysis of Stock Trends* (11th ed., 2018)
**Source text:** [`docs/source/text/edwards-magee-stock-trends.txt`](source/text/) (extracted via pymupdf)
**Code:** [`src/analysis/edwards-magee.ts`](../src/analysis/edwards-magee.ts) → `refineHit()`
**What it gives us:** Geometric quality refinements for chart patterns —
shoulder symmetry on H&S, ≥10-bar separation on double tops/bottoms,
volume contraction in triangles. Each pattern's confidence gets multiplied
by 0.5 + geometryScore (range 0.5–1.5).

### Nison — *Japanese Candlestick Charting Techniques* (2nd ed., 2001)
**Coverage:** Pattern definitions are encoded by the [`cm45t3r/candlestick`](https://github.com/cm45t3r/candlestick)
npm library (18 patterns following standard Nison-derived definitions).
Bulkowski's empirical reliability data sits on top as the weight layer.
No additional Nison-specific module needed.

### Pring — *Technical Analysis Explained* (5th ed., 2014)
**Source text:** [`docs/source/text/pring-technical-analysis.txt`](source/text/) (extracted via pandoc from EPUB)
**Code:** [`src/analysis/indicators.ts`](../src/analysis/indicators.ts) → `kst()`, `specialK()`, `kstCrossover()`
**What it gives us:** KST (Know Sure Thing) oscillator — sum of 4 weighted ROCs across
multiple time spans. Both short-term (daily: ROC 10/15/20/30) and long-term variants.
Plus Special K — extended KST combining 12 ROCs across short/intermediate/long
horizons. KST ↔ signal-line crossover detection feeds the chart score.

### Aronson — *Evidence-Based Technical Analysis* (Wiley 2011)
**Source text:** [`docs/source/text/aronson-evidence-based-ta.txt`](source/text/)
**Code:** [`src/analysis/validation.ts`](../src/analysis/validation.ts) → `permutationTest()`, `blockShuffle()`
**What it gives us:** Monte Carlo permutation testing framework. Take any strategy +
historical OHLCV → block-shuffle the series N times → compute p-value (probability
under null that random data beats the real run). This is the only book in the canon
that gives us a way to *validate* whether a rule has actual edge or is data-mining noise.

## Tier 2 — Specialized

### Tharp — *Trade Your Way to Financial Freedom* (2nd ed., 2007)
**Source text:** [`docs/source/text/tharp-trade-your-way.txt`](source/text/)
**Code:** [`src/analysis/sizing.ts`](../src/analysis/sizing.ts)
**What it gives us:**
- `expectancy()` — E = win% × avg_win_R + loss% × avg_loss_R
- `sizeByPctRisk()` — Tharp Model 3: position = (equity × risk%) / |entry − stop|
- `sizeByVolatility()` — Tharp Model 4: position = (equity × vol%) / ATR
- `atrStop()` / `structureStop()` — stop placement helpers
- `planTrade()` — composes entry/stop/target/sizing, rejects R:R < 2:1

### Perl/DeMark — *DeMark Indicators* (Bloomberg Press 2008)
**Source text:** [`docs/source/text/perl-demark-indicators.txt`](source/text/)
**Code:** [`src/analysis/demark.ts`](../src/analysis/demark.ts) → `tdSequential()`, `recentTdSignal()`
**What it gives us:** TD Sequential 9-13-9 algorithm. Tracks both setup phase
(9 consecutive closes vs close 4 bars earlier) and countdown phase (13 bars where
close vs high/low 2 bars earlier). Signals exhaustion at the bottom (Buy) or top
(Sell) of trends — a leading mean-reversion signal independent of momentum oscillators.
Wired into chart scoring: +5 for Setup completion, +12 for Countdown.

### Minervini — *Trade Like a Stock Market Wizard* (2013)
**Source text:** [`docs/source/text/minervini-stock-market-wizard.txt`](source/text/)
**Code:** [`src/analysis/trend-template.ts`](../src/analysis/trend-template.ts) → `trendTemplate()`, `detectVCP()`
**What it gives us:** SEPA Trend Template — 8 explicit numeric criteria ALL of which
must be true for a stock to be in a "Stage 2" uptrend. Plus VCP (Volatility Contraction
Pattern) detection — sequence of progressively tighter pullbacks signaling a base
ready to break out.

### Connors & Raschke — *Street Smarts* (1996)
**Source text:** [`docs/source/text/connors-raschke-street-smarts.txt`](source/text/)
**Code:** [`src/analysis/setups.ts`](../src/analysis/setups.ts)
**What it gives us:** Three rule-based short-term setups:
- `turtleSoup()` — false breakout of a 20-period extreme set ≥4 bars ago
- `eightyTwenty()` — yesterday's open in opposite 20% of close, today probes through
- `holyGrail()` — pullback to EMA20 in a strong (ADX > 30) trend

Each returns trigger price, stop price, and direction.

### López de Prado — *Advances in Financial Machine Learning* (Wiley 2018)
**Source text:** [`docs/source/text/lopez-de-prado-financial-ml.txt`](source/text/)
**Code:** [`src/analysis/labeling.ts`](../src/analysis/labeling.ts) → `tripleBarrierLabel()`, `purgedKFold()`
**What it gives us:** Triple-barrier event labeling — assign each entry a {+1, 0, −1}
label based on which of (upper_target, lower_stop, vertical_timeout) was hit first.
This produces path-dependent labels that match real trade outcomes. Plus purged
k-fold cross-validation that excludes train samples whose horizon overlaps the test
window — prevents the leakage that inflates ML backtest results.

## Coverage Summary

| Book | Implemented | Module | Tests |
|---|---|---|---|
| Bulkowski Chart Patterns | ✅ | `weights.ts` (data) | covered via chart.test.ts |
| Bulkowski Candlestick Charts | ✅ | `weights.ts` (data) | covered via chart.test.ts |
| Murphy | ✅ | `intermarket.ts` + `indicators.ts` | `intermarket.test.ts` |
| Edwards/Magee | ✅ | `edwards-magee.ts` | `edwards-magee.test.ts` |
| Nison | ✅ (via cm45t3r) | `patterns.ts` | `patterns.test.ts` |
| Pring | ✅ | `indicators.ts` (kst/specialK) | `pring.test.ts` |
| Aronson | ✅ | `validation.ts` | `validation.test.ts` |
| Tharp | ✅ | `sizing.ts` | `sizing.test.ts` |
| Perl/DeMark | ✅ | `demark.ts` | `demark.test.ts` |
| Minervini | ✅ | `trend-template.ts` | `trend-template.test.ts` |
| Connors/Raschke | ✅ | `setups.ts` | `setups.test.ts` |
| López de Prado | ✅ | `labeling.ts` | `labeling.test.ts` |

**12 of 12 books implemented.** 145 tests passing.
