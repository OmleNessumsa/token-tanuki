# Integration Contract — backend-morty × tester-morty (Backtest v2)

**Companion to:** `BACKTEST_V2_ARCHITECTURE.md`
**Purpose:** zero-overlap parallel execution. If both Morty's follow this contract, their PRs merge clean.

---

## File ownership (no overlap)

### backend-morty owns

- `/Users/elmo.asmussen/Projects/Crypto/src/analysis/backtest.ts` — SHORT-side widening (additive only)
- `/Users/elmo.asmussen/Projects/Crypto/src/backtest/data-fetcher.ts` — NEW
- `/Users/elmo.asmussen/Projects/Crypto/src/backtest/universe.ts` — NEW
- `/Users/elmo.asmussen/Projects/Crypto/src/backtest/grid.ts` — NEW
- `/Users/elmo.asmussen/Projects/Crypto/src/backtest/score-cache.ts` — NEW
- `/Users/elmo.asmussen/Projects/Crypto/src/backtest/walk-forward.ts` — NEW
- `/Users/elmo.asmussen/Projects/Crypto/src/backtest/metrics.ts` — NEW
- `/Users/elmo.asmussen/Projects/Crypto/src/backtest/reporter.ts` — NEW
- `/Users/elmo.asmussen/Projects/Crypto/scripts/backtest-v2.ts` — NEW
- `/Users/elmo.asmussen/Projects/Crypto/src/clients/blofin.ts` — extend `getNativeCandles` with `{ before?, after?, limit? }` cursor support (additive, default-compatible)

### tester-morty owns

- `/Users/elmo.asmussen/Projects/Crypto/tests/backtest/` — ALL files in this folder
- `/Users/elmo.asmussen/Projects/Crypto/tests/backtest/fixtures/` — synthesized JSON fixtures + one real BTC-USDT-5m 5000-bar snapshot
- `/Users/elmo.asmussen/Projects/Crypto/tests/backtest/_helpers.ts` — fixture-loading, synth-series generators (private to tests)

### Shared (changes require both Morty's to approve via integration-morty)

- `BACKTEST_V2_ARCHITECTURE.md` — this document. If a signature here changes mid-flight, both PRs rebase.
- `INTEGRATION_CONTRACT.md` — same.

### Off-limits to both

- `src/analysis/chart.ts`, `src/analysis/indicators.ts` — read-only. v2 does not modify signal logic (PRD §3).
- `src/whitelist.ts` — read-only (`BLOFIN_TOP30_ASSETS` is consulted, never mutated).
- `scripts/paper-trader.ts`, `scripts/scan-blofin.ts` — out of scope for v2.

---

## Type signatures backend-morty MUST export (verbatim)

Tester-morty's tests `import { ... } from "<module>"` against these symbols. Any rename or shape-change breaks tests; backend-morty must coordinate via integration-morty before changing.

From `src/analysis/backtest.ts` (existing — widened only):

- `BacktestTrade` (with `side: "LONG" | "SHORT"`)
- `BacktestConfig` (with optional `side?: "LONG" | "SHORT"`)
- `BacktestStats` (unchanged)
- `runStrategyOnSeries(candles, config?)` (signature unchanged; behavior gated on `config.side`)
- `summarize`, `permutationTest` (unchanged)

From `src/backtest/grid.ts`:

- `type GridSpec`
- `type BacktestConfigV2`
- `expandGrid(spec)`
- `configId(cfg)`

From `src/backtest/score-cache.ts`:

- `type ScoreSnapshot`, `type ScoreSeries`
- `precomputeScores(candles, warmupBars, stage2SmaPeriod)`
- `getScoreAt(series, barIndex)`

From `src/backtest/universe.ts`:

- `type UniverseSnapshot`
- `buildUniverseSnapshot(seriesBySymbol, asOfMs, topN)`
- `rollingQuoteVolume24h(candles, asOfMs)`

From `src/backtest/walk-forward.ts`:

- `type Fold`, `type FoldResult`, `type WalkForwardResult`
- `defineFolds(startMs, endMs)`
- `runWalkForward(cfg, seriesBySymbol, folds, opts)`

From `src/backtest/metrics.ts`:

- `type ExtendedStats`, `type ConcentrationReport`
- `extendStats`, `sharpe`, `profitFactor`, `symbolConcentration`, `isOosDelta`

From `src/backtest/data-fetcher.ts`:

- `type FetchRange`, `type CachedSeries`
- `fetchSeriesCached`, `loadCachedSeries`, `cacheDir`

Full signatures are in `BACKTEST_V2_ARCHITECTURE.md` §Public API Signatures. That document is normative.

---

## Shared fixtures — location and format

**Location:** `/Users/elmo.asmussen/Projects/Crypto/tests/backtest/fixtures/`

**Format:** JSON, one of two shapes per file:

1. **Single-symbol series fixture** — for `runStrategyOnSeries` and `scoreAtBar` tests:
   ```json
   {
     "instId": "BTC-USDT",
     "bar": "5m",
     "candles": [
       { "t": 1704067200, "o": 42150.5, "h": 42155.0, "l": 42148.2, "c": 42153.1, "v": 125430.5 }
     ]
   }
   ```
   File name pattern: `<scenario>.json` (e.g. `synth-trend-up-200.json`, `btc-5m-5000bars.json`).

2. **Multi-symbol scenario fixture** — for universe and walk-forward tests:
   ```json
   {
     "asOfMs": 1717891200000,
     "symbols": {
       "A-USDT": { "instId": "A-USDT", "bar": "5m", "candles": [/* ... */] },
       "B-USDT": { "instId": "B-USDT", "bar": "5m", "candles": [/* ... */] }
     }
   }
   ```

**Fixture generation:** tester-morty writes a script `tests/backtest/_helpers.ts` exporting:
- `synthTrendSeries(direction, bars, seed)` — deterministic price walk
- `synthPulseSeries(pulseAtIndices, baselineDirection, bars, seed)` — guaranteed-signal pulses at named indices
- `loadFixture<T>(name)` — JSON load + Zod validate

Fixtures are committed (small enough). The real-data BTC fixture is fetched once by tester-morty and committed (~400KB).

**Determinism contract:** all synth generators take an explicit seed. Fixtures regenerated from the same seed must be byte-identical. CI may regenerate and diff.

---

## Merge order & integration-morty checklist

### Merge order

1. **backend-morty PR #1:** `src/analysis/backtest.ts` SHORT-side widening + `src/backtest/grid.ts` + `src/backtest/metrics.ts`.
   - Smallest, lowest-risk slice. Provides types for everything downstream.
2. **tester-morty PR #1:** fixtures + helpers + tests for `short-r-math`, `short-stage2`, `no-look-ahead`, `grid`, `metrics`.
   - Lands immediately after PR #1.
3. **backend-morty PR #2:** `src/backtest/data-fetcher.ts` + Blofin client extension + `src/backtest/universe.ts`.
4. **tester-morty PR #2:** `data-fetcher`, `universe-snapshot`, `fold-boundaries` tests.
5. **backend-morty PR #3:** `src/backtest/walk-forward.ts`.
6. **backend-morty PR #4:** `src/backtest/reporter.ts` + `scripts/backtest-v2.ts`.
7. **tester-morty PR #3:** `reporter`, `integration-smoke` tests.

Tester-morty PRs always lag by one cycle so types exist before tests import them.

### integration-morty's checklist (before final merge)

- [ ] All public exports in `BACKTEST_V2_ARCHITECTURE.md §Public API Signatures` exist with the exact signatures stated.
- [ ] `npm test` passes locally; every test file listed in §Test Strategy is present and green.
- [ ] No new dependency added to `package.json` without justification (JSONL.gz uses built-ins; nothing else should be needed).
- [ ] No look-ahead test (`tests/backtest/no-look-ahead.test.ts`) exists and passes for both LONG and SHORT.
- [ ] Universe-snapshot test asserts the "vol=0 for symbols with <288 bars before asOfMs" rule.
- [ ] `scripts/backtest-v2.ts` runs end-to-end on a 1-symbol 1-fold smoke configuration in < 60 seconds.
- [ ] No imports from `src/backtest/` into `src/analysis/` (one-way dependency rule).
- [ ] `src/backtest/metrics.ts` and `src/backtest/grid.ts` contain no I/O calls (grep for `fetch`, `fs.`, `Date.now` — zero matches).
- [ ] `data-fetcher.ts` is the only `src/backtest/*` module that imports from `src/clients/`.
- [ ] Cache files land under `~/.cryptotrader-data/blofin-5m/` (or `$CRYPTOTRADER_STATE_DIR/blofin-5m/`), not in repo or `/tmp`.
- [ ] Acceptance: a fresh-clone reviewer can run `npx tsx scripts/backtest-v2.ts --smoke` and see results in < 5 min.

---

## Communication protocol mid-flight

- Signature questions → raised as comments on `BACKTEST_V2_ARCHITECTURE.md` open questions section. Rick resolves.
- Discovered ambiguity not covered by the architecture doc → both Morty's notify integration-morty before deciding. No silent reinterpretation.
- Cross-PR refactors → forbidden during the parallel window. Land them post-merge as separate cleanup tickets.
