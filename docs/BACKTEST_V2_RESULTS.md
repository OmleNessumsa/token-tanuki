# Backtest v2 — Results

**Generated:** 2026-06-10T04:51:11.599Z

## Run metadata

| Field | Value |
|---|---|
| Window | 2026-05-11 → 2026-06-10 |
| Window length | 30.0 days |
| Grid size | 32 configs |
| Universe size | top-5 |
| Wall-clock | 309.6s |

## Certification gates

A config is **certified** only if it passes every gate below.

| Gate | Threshold |
|---|---|
| OOS mean expectancy | > +0.10 R/trade |
| OOS mean Sharpe | > 1.00 |
| OOS max drawdown | < 20.0 R |
| Single-symbol share | <= 50% |
| IS-OOS delta | <= 50% |

**Certified configs:** 0 of 32.

## Ranked configs

Sorted by out-of-sample mean expectancy descending. IS-OOS delta > 50% is the architect's overfitting red flag (marked `RED`).

| Rank | Config ID | Side | Summary | IS exp | OOS exp | IS-OOS delta | OOS Sharpe | OOS max DD | Top sym share | Certified |
|---:|---|---|---|---:|---:|---:|---:|---:|---:|:---:|
| 1 | `SHORT-c60-s2T-atr1.5-h36-cd12` | SHORT | c60 stage2 atr1.5 h36 cd12 | -0.079 | +0.191 | 141% (RED) | +0.09 | 6.78 | 55.9% | no |
| 2 | `SHORT-c60-s2F-atr1.5-h36-cd12` | SHORT | c60 no-s2 atr1.5 h36 cd12 | -0.110 | +0.191 | 157% (RED) | +0.09 | 6.78 | 55.9% | no |
| 3 | `SHORT-c70-s2T-atr1.5-h36-cd12` | SHORT | c70 stage2 atr1.5 h36 cd12 | -1.560 | 0.000 | 100% (RED) | 0.00 | 0.00 | 0.0% | no |
| 4 | `SHORT-c70-s2T-atr2.5-h36-cd12` | SHORT | c70 stage2 atr2.5 h36 cd12 | -1.255 | 0.000 | 100% (RED) | 0.00 | 0.00 | 0.0% | no |
| 5 | `SHORT-c70-s2F-atr1.5-h36-cd12` | SHORT | c70 no-s2 atr1.5 h36 cd12 | -1.560 | 0.000 | 100% (RED) | 0.00 | 0.00 | 0.0% | no |
| 6 | `SHORT-c70-s2F-atr2.5-h36-cd12` | SHORT | c70 no-s2 atr2.5 h36 cd12 | -1.255 | 0.000 | 100% (RED) | 0.00 | 0.00 | 0.0% | no |
| 7 | `SHORT-c55-s2T-atr2.5-h36-cd12` | SHORT | c55 stage2 atr2.5 h36 cd12 | -0.139 | -0.037 | 74% (RED) | -0.03 | 10.68 | 41.6% | no |
| 8 | `SHORT-c55-s2T-atr1.5-h36-cd12` | SHORT | c55 stage2 atr1.5 h36 cd12 | -0.105 | -0.042 | 60% (RED) | -0.02 | 13.78 | 46.7% | no |
| 9 | `SHORT-c60-s2T-atr2.5-h36-cd12` | SHORT | c60 stage2 atr2.5 h36 cd12 | -0.003 | -0.047 | 94% (RED) | -0.03 | 5.21 | 47.3% | no |
| 10 | `SHORT-c60-s2F-atr2.5-h36-cd12` | SHORT | c60 no-s2 atr2.5 h36 cd12 | -0.010 | -0.047 | 80% (RED) | -0.03 | 5.21 | 47.3% | no |
| 11 | `SHORT-c55-s2F-atr2.5-h36-cd12` | SHORT | c55 no-s2 atr2.5 h36 cd12 | -0.132 | -0.089 | 33% | -0.07 | 11.77 | 38.5% | no |
| 12 | `SHORT-c55-s2F-atr1.5-h36-cd12` | SHORT | c55 no-s2 atr1.5 h36 cd12 | -0.095 | -0.098 | 3% | -0.05 | 14.93 | 41.6% | no |
| 13 | `LONG-c70-s2T-atr2.5-h36-cd12` | LONG | c70 stage2 atr2.5 h36 cd12 | -0.646 | -0.390 | 40% | -0.33 | 120.05 | 33.0% | no |
| 14 | `LONG-c70-s2F-atr2.5-h36-cd12` | LONG | c70 no-s2 atr2.5 h36 cd12 | -0.624 | -0.400 | 36% | -0.35 | 149.84 | 32.2% | no |
| 15 | `LONG-c55-s2F-atr2.5-h36-cd12` | LONG | c55 no-s2 atr2.5 h36 cd12 | -0.614 | -0.405 | 34% | -0.34 | 215.68 | 26.0% | no |
| 16 | `LONG-c60-s2F-atr2.5-h36-cd12` | LONG | c60 no-s2 atr2.5 h36 cd12 | -0.621 | -0.415 | 33% | -0.35 | 202.85 | 27.1% | no |
| 17 | `LONG-c55-s2T-atr2.5-h36-cd12` | LONG | c55 stage2 atr2.5 h36 cd12 | -0.676 | -0.416 | 39% | -0.35 | 167.29 | 30.9% | no |
| 18 | `LONG-c65-s2F-atr2.5-h36-cd12` | LONG | c65 no-s2 atr2.5 h36 cd12 | -0.613 | -0.426 | 31% | -0.36 | 188.53 | 26.0% | no |
| 19 | `LONG-c60-s2T-atr2.5-h36-cd12` | LONG | c60 stage2 atr2.5 h36 cd12 | -0.671 | -0.431 | 36% | -0.36 | 164.92 | 30.4% | no |
| 20 | `LONG-c65-s2T-atr2.5-h36-cd12` | LONG | c65 stage2 atr2.5 h36 cd12 | -0.667 | -0.454 | 32% | -0.39 | 155.97 | 29.6% | no |
| 21 | `LONG-c55-s2F-atr1.5-h36-cd12` | LONG | c55 no-s2 atr1.5 h36 cd12 | -0.874 | -0.588 | 33% | -0.37 | 312.98 | 26.3% | no |
| 22 | `LONG-c65-s2F-atr1.5-h36-cd12` | LONG | c65 no-s2 atr1.5 h36 cd12 | -0.877 | -0.615 | 30% | -0.38 | 272.56 | 23.2% | no |
| 23 | `LONG-c60-s2F-atr1.5-h36-cd12` | LONG | c60 no-s2 atr1.5 h36 cd12 | -0.896 | -0.620 | 31% | -0.40 | 303.05 | 27.2% | no |
| 24 | `LONG-c70-s2F-atr1.5-h36-cd12` | LONG | c70 no-s2 atr1.5 h36 cd12 | -0.907 | -0.630 | 31% | -0.42 | 236.17 | 25.8% | no |
| 25 | `LONG-c70-s2T-atr1.5-h36-cd12` | LONG | c70 stage2 atr1.5 h36 cd12 | -0.878 | -0.664 | 24% | -0.44 | 199.23 | 26.7% | no |
| 26 | `LONG-c65-s2T-atr1.5-h36-cd12` | LONG | c65 stage2 atr1.5 h36 cd12 | -0.898 | -0.664 | 26% | -0.43 | 225.88 | 28.9% | no |
| 27 | `LONG-c60-s2T-atr1.5-h36-cd12` | LONG | c60 stage2 atr1.5 h36 cd12 | -0.934 | -0.664 | 29% | -0.42 | 243.83 | 30.2% | no |
| 28 | `LONG-c55-s2T-atr1.5-h36-cd12` | LONG | c55 stage2 atr1.5 h36 cd12 | -0.939 | -0.671 | 29% | -0.42 | 259.01 | 29.4% | no |
| 29 | `SHORT-c65-s2T-atr2.5-h36-cd12` | SHORT | c65 stage2 atr2.5 h36 cd12 | +0.547 | -0.731 | 175% (RED) | -0.97 | 2.34 | 94.3% | no |
| 30 | `SHORT-c65-s2F-atr2.5-h36-cd12` | SHORT | c65 no-s2 atr2.5 h36 cd12 | +0.550 | -0.731 | 175% (RED) | -0.97 | 2.34 | 94.3% | no |
| 31 | `SHORT-c65-s2T-atr1.5-h36-cd12` | SHORT | c65 stage2 atr1.5 h36 cd12 | +0.229 | -0.774 | 130% (RED) | -0.88 | 2.56 | 91.6% | no |
| 32 | `SHORT-c65-s2F-atr1.5-h36-cd12` | SHORT | c65 no-s2 atr1.5 h36 cd12 | +0.176 | -0.774 | 123% (RED) | -0.88 | 2.56 | 91.6% | no |

## Per-gate breakdown (top-10 by OOS expectancy)

| Config ID | OOS exp gate | OOS Sharpe gate | OOS DD gate | Concentration gate | Overfitting gate |
|---|:---:|:---:|:---:|:---:|:---:|
| `SHORT-c60-s2T-atr1.5-h36-cd12` | pass | FAIL | pass | FAIL | FAIL |
| `SHORT-c60-s2F-atr1.5-h36-cd12` | pass | FAIL | pass | FAIL | FAIL |
| `SHORT-c70-s2T-atr1.5-h36-cd12` | FAIL | FAIL | pass | pass | FAIL |
| `SHORT-c70-s2T-atr2.5-h36-cd12` | FAIL | FAIL | pass | pass | FAIL |
| `SHORT-c70-s2F-atr1.5-h36-cd12` | FAIL | FAIL | pass | pass | FAIL |
| `SHORT-c70-s2F-atr2.5-h36-cd12` | FAIL | FAIL | pass | pass | FAIL |
| `SHORT-c55-s2T-atr2.5-h36-cd12` | FAIL | FAIL | pass | pass | FAIL |
| `SHORT-c55-s2T-atr1.5-h36-cd12` | FAIL | FAIL | pass | pass | FAIL |
| `SHORT-c60-s2T-atr2.5-h36-cd12` | FAIL | FAIL | pass | pass | FAIL |
| `SHORT-c60-s2F-atr2.5-h36-cd12` | FAIL | FAIL | pass | pass | FAIL |

## Top-3 configs — per-symbol OOS breakdown

Aggregated across folds 1-3 (test windows). Excludes the aggregate sanity fold.

### SHORT-c60-s2T-atr1.5-h36-cd12

| Symbol | Trades | Expectancy | Total R |
|---|---:|---:|---:|
| ETH-USDT | 5 | +1.770 | +8.85 |
| SOL-USDT | 2 | +0.110 | +0.22 |
| DOGE-USDT | 1 | -1.278 | -1.28 |
| BTC-USDT | 4 | -1.374 | -5.50 |

### SHORT-c60-s2F-atr1.5-h36-cd12

| Symbol | Trades | Expectancy | Total R |
|---|---:|---:|---:|
| ETH-USDT | 5 | +1.770 | +8.85 |
| SOL-USDT | 2 | +0.110 | +0.22 |
| DOGE-USDT | 1 | -1.278 | -1.28 |
| BTC-USDT | 4 | -1.374 | -5.50 |

### SHORT-c70-s2T-atr1.5-h36-cd12

_No OOS trades._

## Concentration check

The following configs failed the concentration kill-switch (> 50% R from one symbol in at least one OOS fold). Treat their headline numbers as unrepresentative.

| Config ID | Fold | Top symbol share |
|---|---|---:|
| `SHORT-c60-s2T-atr1.5-h36-cd12` | fold1 | 55.9% |
| `SHORT-c60-s2F-atr1.5-h36-cd12` | fold1 | 55.9% |
| `SHORT-c65-s2T-atr1.5-h36-cd12` | fold1 | 91.6% |
| `SHORT-c65-s2T-atr2.5-h36-cd12` | fold1 | 94.3% |
| `SHORT-c65-s2F-atr1.5-h36-cd12` | fold1 | 91.6% |
| `SHORT-c65-s2F-atr2.5-h36-cd12` | fold1 | 94.3% |

## Certified configs

**No config passed all certification gates.**

This is a legitimate outcome of an honest backtest, not a failure of the harness. The system either has no edge on this universe + window, or the gates are calibrated tighter than the signal can clear.

Do NOT relax the gates in search of a pass. Either:

- Investigate WHY no config certified (concentration? overfitting? all configs have OOS expectancy at-zero?). The ranked table above shows the per-gate failure pattern.
- Accept "no edge found" and escalate to a v3 ticket (different timeframe, different signal, different universe).
