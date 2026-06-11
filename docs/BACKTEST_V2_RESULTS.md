# Backtest v2 — Results

**Generated:** 2026-06-11T12:26:05.404Z

## Run metadata

| Field | Value |
|---|---|
| Window | 2026-03-13 → 2026-06-11 |
| Window length | 90.0 days |
| Grid size | 32 configs |
| Universe size | top-15 |
| Wall-clock | 16894.8s |

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
| 1 | `SHORT-c70-s2T-atr2.5-h36-cd12` | SHORT | c70 stage2 atr2.5 h36 cd12 | -0.178 | +0.704 | 125% (RED) | +0.27 | 2.64 | 43.2% | no |
| 2 | `SHORT-c70-s2F-atr2.5-h36-cd12` | SHORT | c70 no-s2 atr2.5 h36 cd12 | -0.013 | +0.490 | 103% (RED) | +0.20 | 2.64 | 39.2% | no |
| 3 | `SHORT-c65-s2T-atr2.5-h36-cd12` | SHORT | c65 stage2 atr2.5 h36 cd12 | +0.028 | +0.227 | 88% (RED) | +0.11 | 11.04 | 15.1% | no |
| 4 | `SHORT-c65-s2F-atr2.5-h36-cd12` | SHORT | c65 no-s2 atr2.5 h36 cd12 | +0.036 | +0.160 | 78% (RED) | +0.08 | 12.63 | 13.8% | no |
| 5 | `SHORT-c55-s2T-atr2.5-h36-cd12` | SHORT | c55 stage2 atr2.5 h36 cd12 | -0.178 | -0.095 | 46% | -0.06 | 68.81 | 12.8% | no |
| 6 | `SHORT-c60-s2T-atr2.5-h36-cd12` | SHORT | c60 stage2 atr2.5 h36 cd12 | -0.217 | -0.106 | 51% (RED) | -0.06 | 47.47 | 17.6% | no |
| 7 | `SHORT-c55-s2T-atr1.5-h36-cd12` | SHORT | c55 stage2 atr1.5 h36 cd12 | -0.346 | -0.120 | 65% (RED) | -0.05 | 71.82 | 19.6% | no |
| 8 | `SHORT-c55-s2F-atr2.5-h36-cd12` | SHORT | c55 no-s2 atr2.5 h36 cd12 | -0.180 | -0.140 | 22% | -0.08 | 84.49 | 13.1% | no |
| 9 | `SHORT-c60-s2F-atr2.5-h36-cd12` | SHORT | c60 no-s2 atr2.5 h36 cd12 | -0.212 | -0.142 | 33% | -0.07 | 49.42 | 17.4% | no |
| 10 | `SHORT-c60-s2T-atr1.5-h36-cd12` | SHORT | c60 stage2 atr1.5 h36 cd12 | -0.448 | -0.163 | 64% (RED) | -0.06 | 75.43 | 14.8% | no |
| 11 | `SHORT-c55-s2F-atr1.5-h36-cd12` | SHORT | c55 no-s2 atr1.5 h36 cd12 | -0.336 | -0.177 | 47% | -0.07 | 97.59 | 18.3% | no |
| 12 | `SHORT-c60-s2F-atr1.5-h36-cd12` | SHORT | c60 no-s2 atr1.5 h36 cd12 | -0.414 | -0.216 | 48% | -0.08 | 79.78 | 14.4% | no |
| 13 | `LONG-c60-s2F-atr2.5-h36-cd12` | LONG | c60 no-s2 atr2.5 h36 cd12 | -0.298 | -0.311 | 4% | -0.21 | 1434.73 | 13.7% | no |
| 14 | `LONG-c55-s2F-atr2.5-h36-cd12` | LONG | c55 no-s2 atr2.5 h36 cd12 | -0.294 | -0.316 | 7% | -0.22 | 1558.30 | 13.3% | no |
| 15 | `LONG-c65-s2F-atr2.5-h36-cd12` | LONG | c65 no-s2 atr2.5 h36 cd12 | -0.289 | -0.318 | 9% | -0.21 | 1302.72 | 12.7% | no |
| 16 | `LONG-c70-s2F-atr2.5-h36-cd12` | LONG | c70 no-s2 atr2.5 h36 cd12 | -0.277 | -0.329 | 16% | -0.23 | 1152.92 | 12.5% | no |
| 17 | `LONG-c65-s2T-atr2.5-h36-cd12` | LONG | c65 stage2 atr2.5 h36 cd12 | -0.269 | -0.348 | 23% | -0.24 | 1145.91 | 12.3% | no |
| 18 | `LONG-c70-s2T-atr2.5-h36-cd12` | LONG | c70 stage2 atr2.5 h36 cd12 | -0.263 | -0.349 | 25% | -0.24 | 1042.28 | 12.0% | no |
| 19 | `LONG-c60-s2T-atr2.5-h36-cd12` | LONG | c60 stage2 atr2.5 h36 cd12 | -0.274 | -0.354 | 23% | -0.24 | 1271.71 | 11.6% | no |
| 20 | `LONG-c55-s2T-atr2.5-h36-cd12` | LONG | c55 stage2 atr2.5 h36 cd12 | -0.268 | -0.363 | 26% | -0.26 | 1370.48 | 11.3% | no |
| 21 | `SHORT-c65-s2T-atr1.5-h36-cd12` | SHORT | c65 stage2 atr1.5 h36 cd12 | -0.178 | -0.414 | 57% (RED) | -0.17 | 31.90 | 17.8% | no |
| 22 | `LONG-c55-s2F-atr1.5-h36-cd12` | LONG | c55 no-s2 atr1.5 h36 cd12 | -0.477 | -0.431 | 10% | -0.20 | 2118.05 | 14.5% | no |
| 23 | `LONG-c60-s2F-atr1.5-h36-cd12` | LONG | c60 no-s2 atr1.5 h36 cd12 | -0.469 | -0.438 | 7% | -0.21 | 2023.51 | 15.2% | no |
| 24 | `LONG-c65-s2F-atr1.5-h36-cd12` | LONG | c65 no-s2 atr1.5 h36 cd12 | -0.468 | -0.444 | 5% | -0.21 | 1815.85 | 14.6% | no |
| 25 | `LONG-c70-s2F-atr1.5-h36-cd12` | LONG | c70 no-s2 atr1.5 h36 cd12 | -0.452 | -0.468 | 3% | -0.22 | 1639.92 | 14.1% | no |
| 26 | `LONG-c65-s2T-atr1.5-h36-cd12` | LONG | c65 stage2 atr1.5 h36 cd12 | -0.452 | -0.494 | 8% | -0.24 | 1628.67 | 12.4% | no |
| 27 | `SHORT-c65-s2F-atr1.5-h36-cd12` | SHORT | c65 no-s2 atr1.5 h36 cd12 | -0.137 | -0.494 | 72% (RED) | -0.21 | 36.28 | 16.3% | no |
| 28 | `LONG-c70-s2T-atr1.5-h36-cd12` | LONG | c70 stage2 atr1.5 h36 cd12 | -0.444 | -0.497 | 11% | -0.24 | 1485.54 | 11.0% | no |
| 29 | `LONG-c60-s2T-atr1.5-h36-cd12` | LONG | c60 stage2 atr1.5 h36 cd12 | -0.448 | -0.512 | 13% | -0.25 | 1839.99 | 13.2% | no |
| 30 | `LONG-c55-s2T-atr1.5-h36-cd12` | LONG | c55 stage2 atr1.5 h36 cd12 | -0.448 | -0.528 | 15% | -0.26 | 1990.25 | 12.2% | no |
| 31 | `SHORT-c70-s2T-atr1.5-h36-cd12` | SHORT | c70 stage2 atr1.5 h36 cd12 | -0.739 | -1.188 | 38% | -1.01 | 9.51 | 29.8% | no |
| 32 | `SHORT-c70-s2F-atr1.5-h36-cd12` | SHORT | c70 no-s2 atr1.5 h36 cd12 | -0.449 | -1.209 | 63% (RED) | -1.10 | 10.88 | 26.0% | no |

## Per-gate breakdown (top-10 by OOS expectancy)

| Config ID | OOS exp gate | OOS Sharpe gate | OOS DD gate | Concentration gate | Overfitting gate |
|---|:---:|:---:|:---:|:---:|:---:|
| `SHORT-c70-s2T-atr2.5-h36-cd12` | pass | FAIL | pass | pass | FAIL |
| `SHORT-c70-s2F-atr2.5-h36-cd12` | pass | FAIL | pass | pass | FAIL |
| `SHORT-c65-s2T-atr2.5-h36-cd12` | pass | FAIL | pass | pass | FAIL |
| `SHORT-c65-s2F-atr2.5-h36-cd12` | pass | FAIL | pass | pass | FAIL |
| `SHORT-c55-s2T-atr2.5-h36-cd12` | FAIL | FAIL | FAIL | pass | pass |
| `SHORT-c60-s2T-atr2.5-h36-cd12` | FAIL | FAIL | FAIL | pass | FAIL |
| `SHORT-c55-s2T-atr1.5-h36-cd12` | FAIL | FAIL | FAIL | pass | FAIL |
| `SHORT-c55-s2F-atr2.5-h36-cd12` | FAIL | FAIL | FAIL | pass | pass |
| `SHORT-c60-s2F-atr2.5-h36-cd12` | FAIL | FAIL | FAIL | pass | pass |
| `SHORT-c60-s2T-atr1.5-h36-cd12` | FAIL | FAIL | FAIL | pass | FAIL |

## Top-3 configs — per-symbol OOS breakdown

Aggregated across folds 1-3 (test windows). Excludes the aggregate sanity fold.

### SHORT-c70-s2T-atr2.5-h36-cd12

| Symbol | Trades | Expectancy | Total R |
|---|---:|---:|---:|
| AVAX-USDT | 1 | +5.229 | +5.23 |
| BTC-USDT | 3 | +1.212 | +3.64 |
| HBAR-USDT | 1 | -0.168 | -0.17 |
| ATOM-USDT | 1 | -0.689 | -0.69 |
| DOT-USDT | 1 | -1.112 | -1.11 |
| BCH-USDT | 1 | -1.264 | -1.26 |

### SHORT-c70-s2F-atr2.5-h36-cd12

| Symbol | Trades | Expectancy | Total R |
|---|---:|---:|---:|
| AVAX-USDT | 1 | +5.229 | +5.23 |
| BTC-USDT | 3 | +1.212 | +3.64 |
| HBAR-USDT | 1 | -0.168 | -0.17 |
| ATOM-USDT | 1 | -0.689 | -0.69 |
| DOT-USDT | 1 | -1.112 | -1.11 |
| FET-USDT | 1 | -1.226 | -1.23 |
| BCH-USDT | 1 | -1.264 | -1.26 |

### SHORT-c65-s2T-atr2.5-h36-cd12

| Symbol | Trades | Expectancy | Total R |
|---|---:|---:|---:|
| AAVE-USDT | 1 | +5.237 | +5.24 |
| ADA-USDT | 3 | +1.578 | +4.73 |
| APT-USDT | 1 | +3.332 | +3.33 |
| AVAX-USDT | 3 | +0.914 | +2.74 |
| BTC-USDT | 7 | +0.320 | +2.24 |
| DOGE-USDT | 3 | +0.670 | +2.01 |
| ATOM-USDT | 2 | +0.852 | +1.70 |
| FIL-USDT | 2 | -0.222 | -0.44 |
| DOT-USDT | 2 | -0.539 | -1.08 |
| BCH-USDT | 4 | -0.836 | -3.34 |
| ETH-USDT | 3 | -1.179 | -3.54 |
| HBAR-USDT | 5 | -1.081 | -5.41 |

## Concentration check

No config has a single symbol contributing > 50% of OOS R in any fold. Pass.

## Certified configs

**No config passed all certification gates.**

This is a legitimate outcome of an honest backtest, not a failure of the harness. The system either has no edge on this universe + window, or the gates are calibrated tighter than the signal can clear.

Do NOT relax the gates in search of a pass. Either:

- Investigate WHY no config certified (concentration? overfitting? all configs have OOS expectancy at-zero?). The ranked table above shows the per-gate failure pattern.
- Accept "no edge found" and escalate to a v3 ticket (different timeframe, different signal, different universe).
