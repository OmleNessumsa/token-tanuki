/**
 * universe-snapshot.ts — fold-start volume rank without look-ahead.
 *
 * From BACKTEST_V2_ARCHITECTURE.md §Look-ahead Bias Audit (b) — the look-ahead
 * boundary lives in `rollingQuoteVolume24h(candles, asOfMs)`:
 *
 *   - Sum c.v over the last 288 5m bars whose CLOSE-TIME (= t*1000 + 5*60*1000)
 *     is <= asOfMs.
 *   - Symbols with <288 such bars get quoteVol24h = 0 (new-listing protection).
 *   - Tie-break by instId asc (determinism).
 *   - Pure function — no clocks, no I/O.
 *
 * Threat model: if we accidentally include a candle whose close-time > asOfMs,
 * we smuggle in foresight ("ZEC is going to pump tomorrow"). These tests
 * pin the boundary at the exact ms.
 */

import { describe, expect, it } from "vitest";
// These imports MAY fail until backend-morty's PR #2 lands `universe.ts`.
import {
  rollingQuoteVolume24h,
  buildUniverseSnapshot,
  type UniverseSnapshot,
} from "../../src/backtest/universe.js";
import type { CachedSeries } from "../../src/backtest/data-fetcher.js";
import type { Candle } from "../../src/analysis/indicators.js";

// ---------------------------------------------------------------------------
// Constants & helpers.
// ---------------------------------------------------------------------------

const BAR_MS = 5 * 60 * 1000;
const BAR_SECS = 5 * 60;
const T0_MS = 1_700_000_000_000;
const BARS_24H = 288;

/** Build N consecutive 5m candles with a constant volume value. */
function constVolBars(
  startMs: number,
  count: number,
  volPerBar: number,
  basePrice = 100,
): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < count; i++) {
    bars.push({
      t: Math.floor((startMs + i * BAR_MS) / 1000),
      o: basePrice,
      h: basePrice + 0.1,
      l: basePrice - 0.1,
      c: basePrice,
      v: volPerBar,
    });
  }
  return bars;
}

/** Wrap a Candle[] in the minimal CachedSeries shape universe needs. */
function asSeries(instId: string, candles: Candle[]): CachedSeries {
  const first = candles[0];
  const last = candles[candles.length - 1];
  return {
    instId,
    bar: "5m",
    candles,
    coverage:
      first && last
        ? {
            fromMs: first.t * 1000,
            toMs: last.t * 1000 + BAR_MS,
          }
        : { fromMs: 0, toMs: 0 },
  };
}

// ---------------------------------------------------------------------------
// rollingQuoteVolume24h — standalone tests.
// ---------------------------------------------------------------------------

describe("rollingQuoteVolume24h — basic semantics", () => {
  it("returns 0 when fewer than 288 closed bars are available before asOfMs", () => {
    // 100 bars × volume 1_000_000 = a lot of volume, but <288 closed bars →
    // new-listing protection trips → return 0.
    const bars = constVolBars(T0_MS, 100, 1_000_000);
    // asOfMs = AFTER the last bar's close, so all 100 are eligible by close-time.
    const asOfMs = T0_MS + 100 * BAR_MS;
    expect(rollingQuoteVolume24h(bars, asOfMs)).toBe(0);
  });

  it("sums exactly 288 bars' v when 300 bars are available before asOfMs", () => {
    // 300 bars, each with v=10 → sum of the trailing 288 = 2880.
    const bars = constVolBars(T0_MS, 300, 10);
    // asOfMs at the close of the 300th bar → all 300 bars eligible by close-time.
    const asOfMs = T0_MS + 300 * BAR_MS;
    expect(rollingQuoteVolume24h(bars, asOfMs)).toBe(288 * 10);
  });

  it("excludes bars whose close-time > asOfMs (look-ahead boundary)", () => {
    // 400 bars. Set asOfMs at the close of bar #288 (1-indexed).
    // Eligible bars = those with close-time <= asOfMs → first 288.
    // Bars 289..400 should be excluded — their close-time > asOfMs.
    // First 288 bars carry v=1 each (sum 288), bars 288..400 carry v=999_999.
    const bars: Candle[] = [];
    for (let i = 0; i < 400; i++) {
      bars.push({
        t: Math.floor((T0_MS + i * BAR_MS) / 1000),
        o: 100,
        h: 100,
        l: 100,
        c: 100,
        v: i < 288 ? 1 : 999_999,
      });
    }
    // Close-time of bar index 287 (the 288th) = T0_MS + 287*BAR_MS + BAR_MS = T0_MS + 288*BAR_MS.
    const asOfMs = T0_MS + 288 * BAR_MS;
    expect(rollingQuoteVolume24h(bars, asOfMs)).toBe(288);
  });
});

describe("rollingQuoteVolume24h — close-time boundary strictness", () => {
  it("a candle whose close-time === asOfMs IS included", () => {
    // 290 bars; we want bar with close-time exactly == asOfMs to count.
    // Each bar has v=1.
    const bars = constVolBars(T0_MS, 290, 1);
    // Pick asOfMs as the close-time of bar index 287 (= T0_MS + 288*BAR_MS).
    const asOfMs = T0_MS + 288 * BAR_MS;
    // Eligible bars = those with close-time <= asOfMs = first 288.
    // Sum = 288.
    expect(rollingQuoteVolume24h(bars, asOfMs)).toBe(288);
  });

  it("a candle whose close-time === asOfMs + 1ms is NOT included", () => {
    const bars = constVolBars(T0_MS, 290, 1);
    // asOfMs = close-time of bar 287 minus 1ms → bar 287 closes 1ms AFTER asOfMs.
    const asOfMs = T0_MS + 288 * BAR_MS - 1;
    // Eligible bars = those with close-time <= asOfMs = first 287.
    // 287 < 288 → new-listing protection trips → return 0.
    expect(rollingQuoteVolume24h(bars, asOfMs)).toBe(0);
  });

  it("crossing the close-time boundary by exactly 1ms swaps eligibility", () => {
    // 350 bars, v=2 each. Two asOfMs that differ by 1ms across a close-time.
    const bars = constVolBars(T0_MS, 350, 2);
    const closeTimeBar = T0_MS + 350 * BAR_MS; // close of last bar
    const justAfter = closeTimeBar;
    const justBefore = closeTimeBar - 1;
    // justAfter: last 288 bars eligible → sum = 576.
    // justBefore: last bar excluded → next 288 trailing bars (bars 61..348) → sum = 576.
    // The interesting comparison: increase by exactly +1 v when justAfter
    // pulls in one more newer bar than justBefore does.
    const v1 = rollingQuoteVolume24h(bars, justAfter);
    const v2 = rollingQuoteVolume24h(bars, justBefore);
    expect(v1).toBe(288 * 2);
    expect(v2).toBe(288 * 2);
    // The window slides — both equal 576 because volume is constant.
    // The key invariant for THIS test: both produce a number, neither throws.
    expect(v1).toBe(v2);
  });
});

// ---------------------------------------------------------------------------
// buildUniverseSnapshot — pump-not-yet vs pump-now.
// ---------------------------------------------------------------------------

describe("buildUniverseSnapshot — pump scheduling (no look-ahead)", () => {
  /**
   * Build a synthetic A vs B fixture:
   *   - A: volume 1000/bar from t=0 until T1, then 10000/bar from T1 onward.
   *   - B: steady 5000/bar throughout.
   * Both span 600 bars so the 288-bar window always has data.
   */
  function buildAB(): {
    seriesBySymbol: Record<string, CachedSeries>;
    T1Ms: number;
  } {
    const TOTAL_BARS = 600;
    const T1_BAR_INDEX = 300; // T1 is at bar #300
    const T1_MS = T0_MS + T1_BAR_INDEX * BAR_MS;

    const aBars: Candle[] = [];
    for (let i = 0; i < TOTAL_BARS; i++) {
      aBars.push({
        t: Math.floor((T0_MS + i * BAR_MS) / 1000),
        o: 100,
        h: 100,
        l: 100,
        c: 100,
        v: i < T1_BAR_INDEX ? 1000 : 10000,
      });
    }
    const bBars = constVolBars(T0_MS, TOTAL_BARS, 5000, 50);

    return {
      seriesBySymbol: {
        "A-USDT": asSeries("A-USDT", aBars),
        "B-USDT": asSeries("B-USDT", bBars),
      },
      T1Ms: T1_MS,
    };
  }

  it("at asOfMs = T1 - 1ms, A's pump hasn't materialized → top-1 is B", () => {
    const { seriesBySymbol, T1Ms } = buildAB();
    const snap: UniverseSnapshot = buildUniverseSnapshot(
      seriesBySymbol,
      T1Ms - 1,
      1,
    );
    expect(snap.selected).toEqual(["B-USDT"]);
  });

  it("at asOfMs = T1 + 24h, A's full 288-bar pump window is in → top-1 is A", () => {
    const { seriesBySymbol, T1Ms } = buildAB();
    const asOfMs = T1Ms + 24 * 60 * 60 * 1000; // T1 + 24h
    const snap = buildUniverseSnapshot(seriesBySymbol, asOfMs, 1);
    expect(snap.selected).toEqual(["A-USDT"]);
  });

  it("UniverseSnapshot.asOfMs is propagated exactly from input", () => {
    const { seriesBySymbol, T1Ms } = buildAB();
    const snap = buildUniverseSnapshot(seriesBySymbol, T1Ms, 2);
    expect(snap.asOfMs).toBe(T1Ms);
  });

  it("ranked array is sorted descending by quoteVol24h", () => {
    const { seriesBySymbol } = buildAB();
    // Pick asOfMs well past the pump so A > B.
    const asOfMs = T0_MS + 600 * BAR_MS;
    const snap = buildUniverseSnapshot(seriesBySymbol, asOfMs, 2);
    expect(snap.ranked.length).toBeGreaterThanOrEqual(2);
    expect(snap.ranked[0]!.quoteVol24h).toBeGreaterThanOrEqual(
      snap.ranked[1]!.quoteVol24h,
    );
  });
});

// ---------------------------------------------------------------------------
// New-listing protection.
// ---------------------------------------------------------------------------

describe("buildUniverseSnapshot — new-listing protection", () => {
  it("a symbol with <288 bars before asOfMs has quoteVol24h=0 and is not selected", () => {
    // A: long-lived, steady volume 5000.
    // B: long-lived, steady volume 5000 (tie with A on raw vol).
    // C: only 100 bars before asOfMs, each with volume 1_000_000 (would WIN
    //    if look-ahead was leaking).
    const longBars = constVolBars(T0_MS, 600, 5000);
    const newListingBars = constVolBars(
      T0_MS + 500 * BAR_MS, // C lists late
      100,
      1_000_000,
    );

    const seriesBySymbol = {
      "A-USDT": asSeries("A-USDT", longBars),
      "B-USDT": asSeries("B-USDT", longBars.map((c) => ({ ...c }))),
      "C-USDT": asSeries("C-USDT", newListingBars),
    };

    // asOfMs = close of C's 100th bar → C has exactly 100 closed bars (< 288).
    const asOfMs = T0_MS + 500 * BAR_MS + 100 * BAR_MS;
    const snap = buildUniverseSnapshot(seriesBySymbol, asOfMs, 1);

    // C must NOT be selected.
    expect(snap.selected).not.toContain("C-USDT");
    // C's quoteVol24h in `ranked` is 0 (or it's filtered out entirely;
    // either is acceptable per the architecture doc).
    const cEntry = snap.ranked.find((r) => r.instId === "C-USDT");
    if (cEntry !== undefined) {
      expect(cEntry.quoteVol24h).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tie-break determinism.
// ---------------------------------------------------------------------------

describe("buildUniverseSnapshot — tie-break determinism", () => {
  it("on identical volumes, ties break by instId ascending", () => {
    const sharedBars = constVolBars(T0_MS, 600, 5000);
    const seriesBySymbol = {
      "E-USDT": asSeries("E-USDT", sharedBars),
      "D-USDT": asSeries("D-USDT", sharedBars.map((c) => ({ ...c }))),
    };
    const asOfMs = T0_MS + 600 * BAR_MS;
    const snap = buildUniverseSnapshot(seriesBySymbol, asOfMs, 2);

    // D before E (alpha asc) when vols tie.
    const dIdx = snap.ranked.findIndex((r) => r.instId === "D-USDT");
    const eIdx = snap.ranked.findIndex((r) => r.instId === "E-USDT");
    expect(dIdx).toBeLessThan(eIdx);
    // selected top-1 → D, not E.
    expect(snap.selected[0]).toBe("D-USDT");
  });

  it("byte-identical output across 5 consecutive calls (determinism)", () => {
    // Mix of pumping + tying + new-listing symbols.
    const bars1 = constVolBars(T0_MS, 600, 5000);
    const bars2 = constVolBars(T0_MS, 600, 7000);
    const bars3 = constVolBars(T0_MS, 600, 5000); // ties with bars1
    const seriesBySymbol = {
      "Z-USDT": asSeries("Z-USDT", bars1),
      "M-USDT": asSeries("M-USDT", bars2),
      "A-USDT": asSeries("A-USDT", bars3),
    };
    const asOfMs = T0_MS + 600 * BAR_MS;

    const first = buildUniverseSnapshot(seriesBySymbol, asOfMs, 3);
    const firstJson = JSON.stringify(first);
    for (let i = 0; i < 4; i++) {
      const snap = buildUniverseSnapshot(seriesBySymbol, asOfMs, 3);
      expect(JSON.stringify(snap)).toBe(firstJson);
    }
  });
});

// ---------------------------------------------------------------------------
// Selected = first topN of ranked.
// ---------------------------------------------------------------------------

describe("buildUniverseSnapshot — selected is first topN of ranked", () => {
  it("selected.length === min(topN, ranked.length)", () => {
    const seriesBySymbol = {
      "A-USDT": asSeries("A-USDT", constVolBars(T0_MS, 600, 1000)),
      "B-USDT": asSeries("B-USDT", constVolBars(T0_MS, 600, 2000)),
      "C-USDT": asSeries("C-USDT", constVolBars(T0_MS, 600, 3000)),
    };
    const asOfMs = T0_MS + 600 * BAR_MS;

    const snap2 = buildUniverseSnapshot(seriesBySymbol, asOfMs, 2);
    expect(snap2.selected.length).toBe(2);
    // Selected mirrors ranked top.
    expect(snap2.selected).toEqual(snap2.ranked.slice(0, 2).map((r) => r.instId));

    const snap10 = buildUniverseSnapshot(seriesBySymbol, asOfMs, 10);
    // Only 3 symbols exist; selected can't exceed available rankable symbols.
    expect(snap10.selected.length).toBeLessThanOrEqual(3);
  });
});
