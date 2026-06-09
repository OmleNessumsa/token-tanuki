/**
 * data-fetcher.ts — persistent 5m OHLCV cache with paginated Blofin fetch.
 *
 * From BACKTEST_V2_ARCHITECTURE.md §data-fetcher.ts:
 *   - `fetchSeriesCached(instId, range, opts?)` returns a `CachedSeries`.
 *   - `loadCachedSeries(instId)` is a pure load — returns null on cache miss.
 *   - `cacheDir()` resolves the cache directory; honors `$CRYPTOTRADER_STATE_DIR`,
 *     defaults to `~/.cryptotrader-data/blofin-5m/`.
 *
 * Invariants asserted here:
 *   - Round-trip: write 100 bars → reload → byte-equal.
 *   - Cache miss → null (no throw).
 *   - Partial fetch only requests the gap, not the cached prefix.
 *   - Empty range → no network call, empty candles array.
 *   - Most-recent-bar drop: candles whose close-time is within the last 30s of
 *     `Date.now()` are stripped (incomplete bar safety).
 *   - cacheDir() honors $CRYPTOTRADER_STATE_DIR.
 *
 * Rate-limit timing is left for a TODO/skip — see KNOWN_GAPS in tester-morty's
 * return report. Verifying rps-spaced calls with vi.useFakeTimers reliably is
 * fiddly when the implementation uses Date.now + a sleep promise; the test
 * surface area is high without strong correctness payoff. We assert the
 * `rateLimitRps` option is *accepted* by the function (no throw) and rely on
 * integration smoke for real-network timing.
 */

import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Blofin client mock. NOTE: ESM `vi.mock` is hoisted; we use a factory and
// a module-level handle so each test can swap the return value.
const mockGetNativeCandles =
  vi.fn<
    Parameters<typeof import("../../src/clients/blofin.js")["getNativeCandles"]>,
    ReturnType<typeof import("../../src/clients/blofin.js")["getNativeCandles"]>
  >();

vi.mock("../../src/clients/blofin.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/clients/blofin.js")>(
      "../../src/clients/blofin.js",
    );
  return {
    ...actual,
    getNativeCandles: (...args: unknown[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockGetNativeCandles as any)(...args),
  };
});

// Import AFTER the mock declaration so module wiring uses the mock.
// These imports MAY fail until backend-morty's PR #2 lands `data-fetcher.ts`.
import {
  fetchSeriesCached,
  loadCachedSeries,
  cacheDir,
  type CachedSeries,
} from "../../src/backtest/data-fetcher.js";
import type { Candle } from "../../src/analysis/indicators.js";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const BAR_MS = 5 * 60 * 1000;
const BAR_SECS = 5 * 60;
// Bar-aligned anchor (multiple of BAR_MS) so the fetcher's `alignedFromMs =
// floor(fromMs / BAR_MS) * BAR_MS` is identity. If we use a non-aligned
// anchor, the fetcher rounds DOWN and then sees the cache starting AFTER the
// aligned start, which triggers a spurious prefix-fetch call that pollutes
// the cursor-assertion math.
const T0_MS = 1_700_000_100_000;

function synthBars(startMs: number, count: number, basePrice = 100): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const price = basePrice + i * 0.5;
    bars.push({
      t: Math.floor((startMs + i * BAR_MS) / 1000),
      o: price,
      h: price + 0.3,
      l: price - 0.2,
      c: price + 0.1,
      v: 1000 + i,
    });
  }
  return bars;
}

let tmpStateDir: string;

beforeEach(() => {
  tmpStateDir = mkdtempSync(join(tmpdir(), "btv2-fetcher-"));
  vi.stubEnv("CRYPTOTRADER_STATE_DIR", tmpStateDir);
  mockGetNativeCandles.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    rmSync(tmpStateDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; macOS tmp can be slow.
  }
});

// ---------------------------------------------------------------------------
// cacheDir().
// ---------------------------------------------------------------------------

describe("cacheDir() — env override", () => {
  it("returns a path under $CRYPTOTRADER_STATE_DIR when the env var is set", () => {
    const dir = cacheDir();
    expect(dir.startsWith(tmpStateDir)).toBe(true);
  });

  it("path ends with the blofin-5m segment", () => {
    const dir = cacheDir();
    expect(dir).toMatch(/blofin-5m\/?$/);
  });
});

// ---------------------------------------------------------------------------
// loadCachedSeries — cache miss.
// ---------------------------------------------------------------------------

describe("loadCachedSeries — cache miss", () => {
  it("returns null for a never-fetched symbol, does not throw", async () => {
    const result = await loadCachedSeries("DOES-NOT-EXIST-USDT");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: fetchSeriesCached → loadCachedSeries → deep-equal.
// ---------------------------------------------------------------------------

describe("fetchSeriesCached → loadCachedSeries round-trip", () => {
  it("writes 100 bars, reloads with identical bytes", async () => {
    const bars = synthBars(T0_MS, 100);
    mockGetNativeCandles.mockResolvedValue(bars);

    const fetched = await fetchSeriesCached("BTC-USDT", {
      fromMs: T0_MS,
      toMs: T0_MS + 100 * BAR_MS,
    });

    const reloaded = await loadCachedSeries("BTC-USDT");
    expect(reloaded).not.toBeNull();
    expect(reloaded!.instId).toBe("BTC-USDT");
    expect(reloaded!.bar).toBe("5m");
    // Deep-equal on candles array; reloading from disk must be byte-stable.
    expect(reloaded!.candles).toEqual(fetched.candles);
    expect(reloaded!.candles.length).toBe(100);
  });

  it("candles round-trip preserves OHLCV exactly", async () => {
    const bars = synthBars(T0_MS, 50, 42_000);
    mockGetNativeCandles.mockResolvedValue(bars);

    await fetchSeriesCached("BTC-USDT", {
      fromMs: T0_MS,
      toMs: T0_MS + 50 * BAR_MS,
    });
    const reloaded = await loadCachedSeries("BTC-USDT");
    expect(reloaded!.candles[0]).toEqual(bars[0]);
    expect(reloaded!.candles[49]).toEqual(bars[49]);
  });
});

// ---------------------------------------------------------------------------
// Partial fetch — no re-fetch of already-cached bars.
// ---------------------------------------------------------------------------

describe("fetchSeriesCached — partial fetch", () => {
  it("with cache covering bars [0..50), requesting [0..100) only fetches the [50..100) tail", async () => {
    // Seed cache with bars [0..50) via a first call.
    const firstHalf = synthBars(T0_MS, 50);
    mockGetNativeCandles.mockResolvedValueOnce(firstHalf);
    await fetchSeriesCached("ETH-USDT", {
      fromMs: T0_MS,
      toMs: T0_MS + 50 * BAR_MS,
    });

    // Now ask for [0..100). Implementation should only request the missing
    // [50..100) slice.
    mockGetNativeCandles.mockReset();
    const secondHalf = synthBars(T0_MS + 50 * BAR_MS, 50);
    mockGetNativeCandles.mockResolvedValue(secondHalf);

    const result = await fetchSeriesCached("ETH-USDT", {
      fromMs: T0_MS,
      toMs: T0_MS + 100 * BAR_MS,
    });

    expect(result.candles.length).toBe(100);
    expect(mockGetNativeCandles).toHaveBeenCalled();

    // Contract: the fetcher MUST NOT request bars that are already cached.
    // Implementation detail: Blofin's `before` cursor is EXCLUSIVE on the
    // server side ("return bars strictly newer than `before`"), so callers
    // typically pass `cachedLastCloseMs - BAR_MS` as the cursor to get the
    // next bar onward without re-fetching the last cached one.
    //
    // The invariant we assert: every call's cursor anchor is positioned at
    // or after the cached BAR-START boundary (`T0_MS + 49*BAR_MS`, i.e. one
    // bar back from the cache's exclusive end). Anything further back would
    // re-fetch cached bars.
    const cachedLastBarStartMs = T0_MS + 49 * BAR_MS;
    for (const call of mockGetNativeCandles.mock.calls) {
      const [, , opts] = call as [string, string, unknown];
      if (typeof opts === "object" && opts !== null) {
        const o = opts as { before?: number; after?: number };
        if (o.before !== undefined) {
          expect(o.before).toBeGreaterThanOrEqual(cachedLastBarStartMs);
        }
        if (o.after !== undefined) {
          // `after` is backward-pagination; if used to fill a forward gap
          // the cursor must anchor at or past the requested `toMs`.
          expect(o.after).toBeGreaterThanOrEqual(T0_MS + 50 * BAR_MS);
        }
      }
    }
  });

  it("returns the full union of cached + freshly-fetched bars", async () => {
    const firstHalf = synthBars(T0_MS, 50);
    mockGetNativeCandles.mockResolvedValueOnce(firstHalf);
    await fetchSeriesCached("ETH-USDT", {
      fromMs: T0_MS,
      toMs: T0_MS + 50 * BAR_MS,
    });

    const secondHalf = synthBars(T0_MS + 50 * BAR_MS, 50);
    mockGetNativeCandles.mockReset();
    mockGetNativeCandles.mockResolvedValue(secondHalf);

    const result = await fetchSeriesCached("ETH-USDT", {
      fromMs: T0_MS,
      toMs: T0_MS + 100 * BAR_MS,
    });

    // First cached + freshly-fetched second half = continuous 100 bars.
    expect(result.candles.length).toBe(100);
    expect(result.candles[0]!.t).toBe(Math.floor(T0_MS / 1000));
    expect(result.candles[99]!.t).toBe(
      Math.floor((T0_MS + 99 * BAR_MS) / 1000),
    );
  });
});

// ---------------------------------------------------------------------------
// Empty range — no network call.
// ---------------------------------------------------------------------------

describe("fetchSeriesCached — empty range", () => {
  it("returns an empty CachedSeries when fromMs === toMs, no network call", async () => {
    mockGetNativeCandles.mockResolvedValue([]); // belt-and-suspenders

    const result = await fetchSeriesCached("EMPTY-USDT", {
      fromMs: T0_MS,
      toMs: T0_MS,
    });

    expect(result.candles).toEqual([]);
    expect(result.instId).toBe("EMPTY-USDT");
    expect(result.bar).toBe("5m");
    expect(mockGetNativeCandles).not.toHaveBeenCalled();
  });

  it("returns empty when toMs < fromMs (defensive)", async () => {
    const result = await fetchSeriesCached("EMPTY-USDT", {
      fromMs: T0_MS + BAR_MS,
      toMs: T0_MS,
    });
    expect(result.candles).toEqual([]);
    expect(mockGetNativeCandles).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Drop incomplete current bar (close-time within 30s of Date.now()).
// ---------------------------------------------------------------------------

describe("fetchSeriesCached — drop incomplete current bar", () => {
  it("strips a candle whose close-time exceeds Date.now() - 30s", async () => {
    // Pin "now" to a known value, then construct a series whose final bar
    // closes 5s before now (i.e. within the 30s safety window → must be dropped).
    const NOW = T0_MS + 1000 * BAR_MS;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    // Build 5 bars; the LAST bar's close-time = bar.t*1000 + 5*60*1000.
    // Place final bar so that close-time = NOW - 5_000 → inside the 30s window.
    const finalCloseMs = NOW - 5_000;
    const finalOpenMs = finalCloseMs - BAR_MS;
    const startMs = finalOpenMs - 4 * BAR_MS;

    const bars = synthBars(startMs, 5);
    mockGetNativeCandles.mockResolvedValue(bars);

    const result = await fetchSeriesCached("FRESH-USDT", {
      fromMs: startMs,
      toMs: NOW + BAR_MS, // request includes the bar in question
    });

    // The final bar (index 4) closes inside the 30s window → must be absent.
    const closeMsValues = result.candles.map((c) => c.t * 1000 + BAR_MS);
    for (const closeMs of closeMsValues) {
      expect(closeMs).toBeLessThanOrEqual(NOW - 30_000);
    }
    expect(result.candles.length).toBeLessThan(5);

    vi.useRealTimers();
  });

  it("keeps bars whose close-time is comfortably in the past", async () => {
    const NOW = T0_MS + 1000 * BAR_MS;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    // 5 bars, the final closing 10 minutes before NOW (well outside 30s).
    const finalCloseMs = NOW - 10 * 60 * 1000;
    const finalOpenMs = finalCloseMs - BAR_MS;
    const startMs = finalOpenMs - 4 * BAR_MS;
    const bars = synthBars(startMs, 5);
    mockGetNativeCandles.mockResolvedValue(bars);

    const result = await fetchSeriesCached("OLD-USDT", {
      fromMs: startMs,
      toMs: NOW,
    });

    expect(result.candles.length).toBe(5);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Rate-limit option is accepted (smoke — see top-of-file note for skip reason).
// ---------------------------------------------------------------------------

describe("fetchSeriesCached — rateLimitRps option", () => {
  it("accepts a custom rateLimitRps without throwing", async () => {
    mockGetNativeCandles.mockResolvedValue(synthBars(T0_MS, 10));
    await expect(
      fetchSeriesCached(
        "RATE-USDT",
        { fromMs: T0_MS, toMs: T0_MS + 10 * BAR_MS },
        { rateLimitRps: 100 },
      ),
    ).resolves.toBeTruthy();
  });

  // NOTE: explicit timing verification (two consecutive calls must wait
  // 1000/rateLimitRps ms between them) is intentionally skipped here. The
  // common implementations (`setTimeout` + `Date.now()` rolling window) don't
  // play cleanly with `vi.useFakeTimers` without also advancing timers from
  // inside the assertion, which couples the test to implementation details.
  // Integration smoke (PR #3-4) catches real-network throttle behavior.
});

// ---------------------------------------------------------------------------
// CachedSeries shape sanity.
// ---------------------------------------------------------------------------

describe("CachedSeries — shape", () => {
  it("exposes instId, bar='5m', candles, coverage", async () => {
    const bars = synthBars(T0_MS, 20);
    mockGetNativeCandles.mockResolvedValue(bars);

    const result: CachedSeries = await fetchSeriesCached("SHAPE-USDT", {
      fromMs: T0_MS,
      toMs: T0_MS + 20 * BAR_MS,
    });

    expect(result.instId).toBe("SHAPE-USDT");
    expect(result.bar).toBe("5m");
    expect(Array.isArray(result.candles)).toBe(true);
    expect(result.coverage).toBeDefined();
    // coverage.fromMs should reflect the earliest candle's open time (t*1000).
    expect(result.coverage.fromMs).toBe(bars[0]!.t * 1000);
    // coverage.toMs should reflect the latest candle's close time
    // (last.t*1000 + 5*60*1000).
    expect(result.coverage.toMs).toBe(bars[19]!.t * 1000 + BAR_MS);
  });
});
