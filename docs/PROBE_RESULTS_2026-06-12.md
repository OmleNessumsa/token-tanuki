# Probe results — 2026-06-12 (C3 + C4 first experiments)

Continuation of the diagnosis arc in `HANDOVER_2026-06-12.md`. Both open
paths chosen there (C3 timeframe shift, C4 funding-rate gradient) were
tested today. Both failed their pre-registered criteria. Raw outputs for
every probe are persisted in `logs/` before any display formatting.

## C3 — timeframe shift (5m → 1h): DEAD

### probe-1h-grid.ts — 60d × 5 sym × 128 configs on 1h bars

1h bars aggregated from the existing 5m cache (`aggregateTo1h`, 0 partial
buckets). Same grid family as the 5m probes; horizons 6/12/24/48 bars
(= literal hours).

- **0/128 configs pass the three cheap gates** (netExp > 0.1, Sharpe > 1, conc ≤ 50%).
- LONG mean -0.20 to -0.28R at every horizon — same structural negative as 5m.
- SHORT mean monotone-improving with horizon (+0.01 → +0.55R) — the exact
  signature that D1 proved was regime-tracking on 5m.
- Top "performers" had n=4 trades and 69-87% single-symbol concentration.
- Raw: `logs/probe-1h-grid-2026-06-11.json`

### probe-1h-windows.ts — regime check, two non-overlapping 45d windows

| Metric | W1 (2026-04-27→06-11) | W2 (2026-03-13→04-27) |
|---|---|---|
| SHORT mean, h=12 | +0.32R | **-0.13R** |
| SHORT mean, h=48 | +0.91R | **-0.14R** |
| LONG mean, h=12..48 | -0.40..-0.55R | -0.16..-0.41R |

- **0 of 60** configs with n≥10 in both windows were stable-positive; 12 sign-flipped.
- Verdict: identical to the 5m D1 result. The scoreChart signal set has no
  edge on 1h either. **The signal source is the problem, not the resolution.**
- Raw: `logs/probe-1h-windows-2026-06-11.json`

## C4 — funding-rate gradient: NO STANDALONE EDGE

Infrastructure added: `getFundingRateHistory()` in `src/clients/blofin.ts`
(paginated, `after=<ms>` pages older, 3+ years of depth verified). Blofin
also serves native `1H` candles 3+ years back — no 5m cache dependency
needed for hourly work.

### probe-funding-btc.ts — 90d signal-quality probe (BTC + ETH)

Funding percentile (vs trailing 90 settlements = 30d) vs forward log-returns.
Looked promising: IC -0.19 (BTC) / -0.22 (ETH) at h=72, extremes in the
hypothesized direction. **But** naive z≈-3 was ~3× inflated by 9× overlapping
forward windows, and it was one regime-structured 90d window.

### probe-funding-robustness.ts — overlap-corrected, split-half, 5 syms

Pre-registered criteria: h=72 non-overlap IC < 0 on ≥4/5 syms AND both-halves
negative on ≥3/5. **Result: 3/5 and 2/5 → FAIL.** SOL persistently positive
(+0.24). Underpowered though (29 independent obs/sym), hence the 1y probe.

### probe-funding-1y.ts — decisive: 365d × 5 sym, native 1H candles

1086 observations per symbol, quarter-split stability, non-overlapping IC.

| h=72 | IC non-overlap (n=121) |
|---|---|
| BTC | -0.036 |
| ETH | +0.020 |
| SOL | +0.084 |
| XRP | -0.125 |
| DOGE | +0.020 |

- **Pre-registered criteria FAIL**: 2/5 negative (need ≥4); pooled extreme
  bucket pct≤0.1 went the *wrong* way at h=72 (-53bps where positive expected).
- At h=24 a consistent faint contrarian tilt exists: IC negative on 4/5 syms,
  crowded longs -43bps / crowded shorts +30bps, |t|≈1.4 over a full year.
  **Directionally right, economically dead**: the locked cost model is 14bps
  round-trip and the gross tilt won't survive realistic execution of a 24h hold.
- Raw: `logs/probe-funding-1y-2026-06-12.json` (5430 obs — reusable for
  cross-sectional analysis without refetching).

## C4b — cross-sectional funding (probe-funding-xsec.ts): FAIL on criteria, but borderline

1y × 26-symbol universe (top Blofin USDT perps by today's volume, ≥97%
coverage), long lowest-funding quintile / short highest, equal-weight,
market-neutral. Funding ranked PER HOUR (Blofin mixes 8h and 4h cycles —
HYPE/ONDO/TAO/DEXE/1000BONK settle 4-hourly; the first run naively assumed
8h everywhere and silently dropped 91% of cross-sections — fixed). Carry
accrual included in PnL. 544 settlement cross-sections.

| h | gross total | t (non-ovl) | quarters + | measured turnover/leg | NET @ measured turnover |
|---|---|---|---|---|---|
| 8h | 15.1 bps | 2.48 | 4/4 | 42% | +3.3 bps (≈10 bps/day) |
| 24h | 25.3 bps | 1.40 | 4/4 | 53% | +10.4 bps/day |
| 72h | 84.0 bps | 1.63 | 4/4 | 57% | +22.7 bps/day |

- **Pre-registered criteria @ h=24: FAIL** (t=1.40 < 2.0; quarters 4/4 ✓; gross 25.3 ≥ 14 ✓).
- Carry leg is near-mechanical (t=21-46) — you reliably earn the funding
  differential. The price leg is positive at every horizon but noisy (t≤1.1).
- This is the ONLY construction in the whole project with no sign-flip
  anywhere: 4/4 quarters positive at all three horizons, net positive at
  measured turnover at all three horizons.
- Caveats: survivorship-biased universe (ranked by today's volume), 1y
  sample, net t-stats < 2 → cannot rule out zero.
- The one principled power-increase left: the SAME pre-registered test on
  3 years of data (Blofin serves it; ~15 min runtime). Not goalpost-moving —
  same construction, same criteria, 3× sample.
- Raw: `logs/probe-funding-xsec-2026-06-12.json` (incl. baskets per
  settlement — turnover/cost analysis reproducible without refetching).

## Net verdict after today

| Path | Status |
|---|---|
| scoreChart on 5m (all variants) | dead (2026-06-11) |
| C3: scoreChart on 1h | **dead (today)** |
| C4a: time-series funding percentile | **no standalone edge (today)** |
| C4b: cross-sectional funding (26 syms, market-neutral) | **FAIL on pre-registered gate, but borderline** — only construction with no sign-flips; 3y re-test is the single remaining justifiable probe |
| C4c: regime detection as a gate | untested — but there is no positive-expectancy strategy left to gate |
| C4d: on-chain signals | untested, needs new data source |
| C5: stop | always available, free |

Note on C4c: regime detection was originally framed as "gate the existing
scoreChart signals by regime". That framing is now void — both regime
directions have been tested implicitly via the window splits, and the
underlying signal is negative-to-flat in *all* of them. A regime gate can
only help a signal that is positive somewhere.
