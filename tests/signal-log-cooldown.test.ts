import { describe, expect, it } from "vitest";
import { isOnCooldown, type SignalRecord } from "../src/signal-log.js";

function mkRec(symbol: string, ts: number, fired = true): SignalRecord {
  return {
    id: `${symbol}-${ts}`,
    ts,
    symbol,
    asset: symbol.split("-")[0]!,
    exchange: "coinbase-spot",
    mode: "spot",
    naturalSide: "LONG",
    side: "LONG",
    fired,
    shadowReason: null,
    composite: 60,
    stage2: true,
    aligned: true,
    htfDirection: "bullish",
    ltfDirection: "bullish",
    entryPrice: 100,
    stopPrice: 95,
    tp1Price: 110,
    tp2Price: null,
    tp3Price: null,
    outcome: null,
  };
}

const SIX_HOURS_MS = 6 * 3600 * 1000;

describe("isOnCooldown", () => {
  it("false when no signals exist", () => {
    expect(isOnCooldown([], "DOGE-USDC", SIX_HOURS_MS, 1_000_000_000)).toBe(false);
  });

  it("false when last signal for symbol is older than cooldown window", () => {
    const now = 1_000_000_000;
    const seven_hours_ago = now - 7 * 3600 * 1000;
    const records = [mkRec("DOGE-USDC", seven_hours_ago)];
    expect(isOnCooldown(records, "DOGE-USDC", SIX_HOURS_MS, now)).toBe(false);
  });

  it("true when last signal for symbol is within cooldown window", () => {
    const now = 1_000_000_000;
    const two_hours_ago = now - 2 * 3600 * 1000;
    const records = [mkRec("DOGE-USDC", two_hours_ago)];
    expect(isOnCooldown(records, "DOGE-USDC", SIX_HOURS_MS, now)).toBe(true);
  });

  it("ignores signals for OTHER symbols", () => {
    const now = 1_000_000_000;
    const records = [mkRec("LINK-USDC", now - 60 * 1000)]; // 1 min ago
    expect(isOnCooldown(records, "DOGE-USDC", SIX_HOURS_MS, now)).toBe(false);
  });

  it("ignores SHADOW signals (only fired ones gate the next entry)", () => {
    const now = 1_000_000_000;
    const records = [mkRec("DOGE-USDC", now - 60 * 1000, /*fired=*/ false)];
    expect(isOnCooldown(records, "DOGE-USDC", SIX_HOURS_MS, now)).toBe(false);
  });

  it("uses most-recent fired signal — old + new mixed should still gate", () => {
    const now = 1_000_000_000;
    const records = [
      mkRec("DOGE-USDC", now - 48 * 3600 * 1000), // 2d ago
      mkRec("DOGE-USDC", now - 30 * 60 * 1000),   // 30m ago
    ];
    expect(isOnCooldown(records, "DOGE-USDC", SIX_HOURS_MS, now)).toBe(true);
  });

  it("regression: 30-minute scanner cadence used to re-fire same DOGE-USDC every scan because day-prefix dedup compared mismatched id shapes", () => {
    // The buggy code did `id.startsWith("DOGE-USDC-2026-05-15")` against an id
    // pattern of `DOGE-USDC-1747900200000`, which never matched. With a 6h
    // cooldown using actual timestamps, a signal fired 30 min ago must
    // block a new fire.
    const now = 1_700_000_000_000;
    const thirty_min_ago = now - 30 * 60 * 1000;
    const records = [mkRec("DOGE-USDC", thirty_min_ago)];
    expect(isOnCooldown(records, "DOGE-USDC", SIX_HOURS_MS, now)).toBe(true);
  });
});
