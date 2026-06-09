/**
 * No-look-ahead invariant.
 *
 * Replacing bars strictly AFTER a target index `i` with garbage must NOT
 * change entry decisions at any index <= i. Both LONG and SHORT sides.
 *
 * Why this matters: if `scoreAtBar` (or any downstream filter) silently
 * peeks at future bars, the harness is a fiction. This test fails loudly
 * with the differing trade if look-ahead leaks.
 *
 * NOTE: entry-decision identity ONLY. The trade EXIT walks future bars
 * (by design — that's how stop / horizon exits work), so exit fields
 * are allowed to diverge once garbage bars enter the future window.
 */

import { describe, expect, it } from "vitest";
import {
  runStrategyOnSeries,
  type BacktestConfig,
  type BacktestTrade,
} from "../../src/analysis/backtest.js";
import { synthTrendSeries, type Candle } from "./_helpers.js";

const TARGET_INDEX = 250;
const SERIES_LEN = 300;

const BASE_CONFIG: BacktestConfig = {
  thresholdComposite: 55, // permissive — we just need *some* entries below TARGET_INDEX
  horizonBars: 12,
  stopAtrMult: 2,
  warmupBars: 60,
  cooldownBars: 12,
  requireBreakout: false,
  requireStage2: false,
  stage2SmaPeriod: 50,
};

function garbageBar(t: number): Candle {
  // Pathological values: extreme price, no range, zero volume.
  // Anything peeking forward will be perturbed in an obvious way.
  return { t, o: 999_999, h: 999_999, l: 999_999, c: 999_999, v: 0 };
}

function replaceFuture(candles: readonly Candle[], afterIndex: number): Candle[] {
  const out = candles.slice(0, afterIndex + 1);
  for (let i = afterIndex + 1; i < candles.length; i++) {
    out.push(garbageBar(candles[i]!.t));
  }
  return out;
}

function entryFingerprint(t: BacktestTrade) {
  // Entry-only fingerprint: deliberately omits exit*/rMultiple/exitReason.
  return {
    entryIndex: t.entryIndex,
    entryPrice: t.entryPrice,
    stopPrice: t.stopPrice,
    composite: t.composite,
    side: t.side,
  };
}

function assertSameEntries(
  realTrades: readonly BacktestTrade[],
  garbageTrades: readonly BacktestTrade[],
  cutoffIndex: number,
) {
  const realFiltered = realTrades.filter((t) => t.entryIndex <= cutoffIndex).map(entryFingerprint);
  const garbageFiltered = garbageTrades.filter((t) => t.entryIndex <= cutoffIndex).map(entryFingerprint);

  // Detailed message on mismatch — pinpoints which entry diverged.
  if (JSON.stringify(realFiltered) !== JSON.stringify(garbageFiltered)) {
    // eslint-disable-next-line no-console
    console.error("LOOK-AHEAD LEAK — entry decisions diverged");
    // eslint-disable-next-line no-console
    console.error("real:   ", JSON.stringify(realFiltered, null, 2));
    // eslint-disable-next-line no-console
    console.error("garbage:", JSON.stringify(garbageFiltered, null, 2));
  }
  expect(garbageFiltered).toEqual(realFiltered);
}

describe("no look-ahead — LONG", () => {
  it("entries at index <= TARGET_INDEX are unchanged when future bars are replaced with garbage", () => {
    const candles = synthTrendSeries("up", SERIES_LEN, 42);
    const garbage = replaceFuture(candles, TARGET_INDEX);

    const realTrades = runStrategyOnSeries(candles, { ...BASE_CONFIG, side: "LONG" });
    const garbageTrades = runStrategyOnSeries(garbage, { ...BASE_CONFIG, side: "LONG" });

    assertSameEntries(realTrades, garbageTrades, TARGET_INDEX);
  });
});

describe("no look-ahead — SHORT", () => {
  it("entries at index <= TARGET_INDEX are unchanged when future bars are replaced with garbage", () => {
    const candles = synthTrendSeries("down", SERIES_LEN, 43);
    const garbage = replaceFuture(candles, TARGET_INDEX);

    const realTrades = runStrategyOnSeries(candles, { ...BASE_CONFIG, side: "SHORT" });
    const garbageTrades = runStrategyOnSeries(garbage, { ...BASE_CONFIG, side: "SHORT" });

    assertSameEntries(realTrades, garbageTrades, TARGET_INDEX);
  });
});

describe("no look-ahead — entry decisions are a pure function of the prefix", () => {
  it("running on the truncated prefix yields the same entry set as running on the garbage-padded series", () => {
    // Stronger formulation: the [0..TARGET_INDEX] prefix alone should produce
    // entries identical to the full-length-with-garbage-tail run, modulo
    // the right tail being too close to series-end for the horizon-walk.
    const candles = synthTrendSeries("up", SERIES_LEN, 44);
    const prefix = candles.slice(0, TARGET_INDEX + 1);
    const garbage = replaceFuture(candles, TARGET_INDEX);

    const prefixTrades = runStrategyOnSeries(prefix, { ...BASE_CONFIG, side: "LONG" });
    const garbageTrades = runStrategyOnSeries(garbage, { ...BASE_CONFIG, side: "LONG" });

    // The prefix run can't enter on bars within `horizonBars` of its end (no room
    // to walk to exit), so we compare entries that survive both windows.
    const safeCutoff = TARGET_INDEX - BASE_CONFIG.horizonBars - 1;
    assertSameEntries(prefixTrades, garbageTrades, safeCutoff);
  });
});
