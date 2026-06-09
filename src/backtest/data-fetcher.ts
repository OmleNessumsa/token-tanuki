/**
 * Paginated 5m OHLCV fetch from Blofin with persistent JSONL.gz cache and
 * resume support.
 *
 * One file per `instId` at `<cacheDir>/<instId>.5m.jsonl.gz`. Cache is
 * append-friendly via concat-gzip — a crashed run leaves a consistent partial
 * file. No TTL (historical 5m bars are immutable on Blofin); no checksums
 * (corruption → re-fetch from scratch).
 *
 * The fetcher is the ONLY module in `src/backtest/` that touches the network
 * or the filesystem. Everything downstream (universe, walk-forward, metrics)
 * receives pre-fetched `CachedSeries` and is pure.
 *
 * Companion docs:
 * - docs/BACKTEST_HARNESS_V2_PRD.md §4
 * - docs/BACKTEST_V2_ARCHITECTURE.md §data-fetcher.ts, §Caching Layer
 */

import { promises as fs } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { homedir } from "node:os";
import path from "node:path";

import type { Candle } from "../analysis/indicators.js";
import { getNativeCandles } from "../clients/blofin.js";

const BAR_MS = 5 * 60 * 1000; // 5 minutes in ms
const BAR_SEC = 5 * 60;       // 5 minutes in seconds
/** 24h trailing window for the universe scan = 288 bars. Re-exported for callers. */
export const BARS_PER_24H = 288;
/** Blofin caps each candles call at 1440 bars. */
const BLOFIN_LIMIT_MAX = 1440;
/** Default rate limit for paginated fetches. */
const DEFAULT_RATE_LIMIT_RPS = 5;
/** Don't trust bars whose close is within this window of "now" — Blofin may
 *  still be aggregating the current bar. */
const INCOMPLETE_BAR_GUARD_MS = 30_000;

export interface FetchRange {
  /** Inclusive start, unix ms. */
  fromMs: number;
  /** Exclusive end, unix ms. */
  toMs: number;
}

export interface CachedSeries {
  instId: string;
  bar: "5m";
  /** Oldest-first, deduplicated. `t` is unix seconds (matches `Candle`). */
  candles: Candle[];
  /** `[first.t*1000, last.t*1000 + BAR_MS)`. Empty series → `{ fromMs: 0, toMs: 0 }`. */
  coverage: FetchRange;
}

/**
 * Resolve the cache directory.
 * - If `$CRYPTOTRADER_STATE_DIR` is set, cache lands at `$CRYPTOTRADER_STATE_DIR/blofin-5m/`.
 * - Otherwise: `~/.cryptotrader-data/blofin-5m/`.
 */
export function cacheDir(): string {
  const stateDir = process.env["CRYPTOTRADER_STATE_DIR"];
  if (stateDir && stateDir.length > 0) {
    return path.join(stateDir, "blofin-5m");
  }
  return path.join(homedir(), ".cryptotrader-data", "blofin-5m");
}

function cacheFilePath(instId: string): string {
  return path.join(cacheDir(), `${instId}.5m.jsonl.gz`);
}

function isValidCandle(c: unknown): c is Candle {
  if (!c || typeof c !== "object") return false;
  const k = c as Record<string, unknown>;
  return (
    typeof k["t"] === "number" && Number.isFinite(k["t"]) &&
    typeof k["o"] === "number" && Number.isFinite(k["o"]) &&
    typeof k["h"] === "number" && Number.isFinite(k["h"]) &&
    typeof k["l"] === "number" && Number.isFinite(k["l"]) &&
    typeof k["c"] === "number" && Number.isFinite(k["c"]) &&
    typeof k["v"] === "number" && Number.isFinite(k["v"])
  );
}

/**
 * Decode a JSONL.gz buffer into a sorted, deduplicated `Candle[]`.
 * Concat-gzip safe: `gunzipSync` decompresses all chunks concatenated together.
 */
function decodeJsonlGz(buf: Buffer): Candle[] {
  if (buf.length === 0) return [];
  const text = gunzipSync(buf).toString("utf8");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  const out: Candle[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Corrupt line — bail and treat the whole file as corrupted.
      throw new Error("corrupt-jsonl-line");
    }
    if (!isValidCandle(parsed)) throw new Error("corrupt-candle-row");
    out.push(parsed);
  }
  // Sort + dedupe on `t`.
  return dedupeSorted(out);
}

function dedupeSorted(candles: readonly Candle[]): Candle[] {
  if (candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  let lastT = -Infinity;
  for (const c of sorted) {
    if (c.t === lastT) continue; // dedupe
    out.push(c);
    lastT = c.t;
  }
  return out;
}

function toCachedSeries(instId: string, candles: Candle[]): CachedSeries {
  if (candles.length === 0) {
    return { instId, bar: "5m", candles: [], coverage: { fromMs: 0, toMs: 0 } };
  }
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  return {
    instId,
    bar: "5m",
    candles,
    coverage: { fromMs: first.t * 1000, toMs: last.t * 1000 + BAR_MS },
  };
}

/**
 * Pure load (no network). Returns null if no cache file exists.
 * Corrupted files → returns null (caller will re-fetch from scratch).
 */
export async function loadCachedSeries(instId: string): Promise<CachedSeries | null> {
  const filePath = cacheFilePath(instId);
  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // For any other read error, treat as missing cache.
    return null;
  }
  try {
    const candles = decodeJsonlGz(buf);
    return toCachedSeries(instId, candles);
  } catch {
    // Corrupted gzip / JSON → unlink and report null.
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore
    }
    return null;
  }
}

/** Ensure the cache directory exists. Idempotent. */
async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true });
}

/**
 * Append a batch of candles to the cache file as a fresh gzip chunk.
 * Concat-gzip: gzip(a) || gzip(b) is itself a valid gzip stream that
 * decompresses to a || b. This lets us crash-safely append without rewriting.
 */
async function appendCandlesToCache(instId: string, candles: readonly Candle[]): Promise<void> {
  if (candles.length === 0) return;
  await ensureCacheDir();
  const filePath = cacheFilePath(instId);
  const jsonl = candles.map((c) => JSON.stringify(c)).join("\n") + "\n";
  const gz = gzipSync(Buffer.from(jsonl, "utf8"));
  await fs.appendFile(filePath, gz);
}

/**
 * Overwrite the cache file with a single fresh gzip chunk containing the full
 * deduplicated series. Used after dedupe/sort to keep the file small.
 */
async function rewriteCache(instId: string, candles: readonly Candle[]): Promise<void> {
  await ensureCacheDir();
  const filePath = cacheFilePath(instId);
  if (candles.length === 0) {
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore
    }
    return;
  }
  const jsonl = candles.map((c) => JSON.stringify(c)).join("\n") + "\n";
  const gz = gzipSync(Buffer.from(jsonl, "utf8"));
  await fs.writeFile(filePath, gz);
}

/**
 * Drop bars whose close-time is within `INCOMPLETE_BAR_GUARD_MS` of "now".
 * Blofin may still be aggregating the most recent bar.
 */
function dropIncompleteTail(candles: readonly Candle[], nowMs: number): Candle[] {
  const cutoff = nowMs - INCOMPLETE_BAR_GUARD_MS;
  const out: Candle[] = [];
  for (const c of candles) {
    const closeMs = c.t * 1000 + BAR_MS;
    if (closeMs > cutoff) break; // candles are oldest-first; rest of tail is also incomplete
    out.push(c);
  }
  return out;
}

/**
 * Lightweight token-bucket rate limiter. We keep a single shared bucket per
 * process — fine for the backtest CLI's single-threaded fetch loop.
 */
class RateLimiter {
  private nextAvailableMs = 0;
  constructor(private readonly rps: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    if (now >= this.nextAvailableMs) {
      this.nextAvailableMs = now + Math.ceil(1000 / this.rps);
      return;
    }
    const delay = this.nextAvailableMs - now;
    this.nextAvailableMs += Math.ceil(1000 / this.rps);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Fetch a contiguous backward slice (older bars) using Blofin's `after=<ms>`
 * cursor. Returns all candles strictly older than `untilMs` (exclusive end),
 * down to (but not strictly bounded by) `fromMs` — caller filters.
 *
 * Paginates one page at a time; bails when the API returns fewer bars than
 * requested OR when the oldest returned bar is already older than `fromMs`.
 */
async function fetchBackward(
  instId: string,
  fromMs: number,
  untilMs: number,
  rateLimiter: RateLimiter,
  signal: AbortSignal | undefined,
  onBatch: (batch: Candle[]) => Promise<void>,
): Promise<void> {
  let cursorMs = untilMs;
  // Safety cap to avoid runaway loops if Blofin returns weird data.
  // (toMs - fromMs) / BAR_MS gives the theoretical max bars; one page per
  // BLOFIN_LIMIT_MAX bars. Multiply by 2 for safety.
  const maxPages = Math.max(1, Math.ceil((untilMs - fromMs) / (BLOFIN_LIMIT_MAX * BAR_MS))) * 2 + 4;

  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) throw new Error("aborted");
    await rateLimiter.wait();
    const batch = await getNativeCandles(instId, "5m", {
      after: cursorMs,
      limit: BLOFIN_LIMIT_MAX,
    });
    if (batch.length === 0) return;
    // Filter to the requested range and to bars older than the cursor.
    const filtered = batch.filter(
      (c) => c.t * 1000 + BAR_MS <= cursorMs && c.t * 1000 >= fromMs,
    );
    if (filtered.length > 0) {
      await onBatch(filtered);
    }
    // Advance cursor to the oldest bar's open time. If we got fewer than the
    // limit, the API has no more data to the left — stop.
    const oldest = batch[0]!; // oldest-first after reverse in client
    if (batch.length < BLOFIN_LIMIT_MAX) return;
    if (oldest.t * 1000 <= fromMs) return;
    // Move cursor strictly before this batch's oldest bar.
    cursorMs = oldest.t * 1000;
  }
}

/**
 * Fetch a contiguous forward slice (newer bars) using Blofin's `before=<ms>`
 * cursor. Returns all candles strictly newer than `sinceMs`, up to (but not
 * strictly bounded by) `toMs` — caller filters.
 *
 * Blofin's `before` returns the most recent N bars whose ts > before. To walk
 * forward, we keep advancing `before` to the newest bar we've seen until the
 * batch is empty or we've crossed `toMs`.
 */
async function fetchForward(
  instId: string,
  sinceMs: number,
  toMs: number,
  rateLimiter: RateLimiter,
  signal: AbortSignal | undefined,
  onBatch: (batch: Candle[]) => Promise<void>,
): Promise<void> {
  let cursorMs = sinceMs;
  const maxPages = Math.max(1, Math.ceil((toMs - sinceMs) / (BLOFIN_LIMIT_MAX * BAR_MS))) * 2 + 4;

  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) throw new Error("aborted");
    await rateLimiter.wait();
    const batch = await getNativeCandles(instId, "5m", {
      before: cursorMs,
      limit: BLOFIN_LIMIT_MAX,
    });
    if (batch.length === 0) return;
    const filtered = batch.filter(
      (c) => c.t * 1000 > cursorMs && c.t * 1000 + BAR_MS <= toMs,
    );
    if (filtered.length > 0) {
      await onBatch(filtered);
    }
    const newest = batch[batch.length - 1]!;
    if (batch.length < BLOFIN_LIMIT_MAX) return;
    if (newest.t * 1000 + BAR_MS >= toMs) return;
    if (newest.t * 1000 <= cursorMs) return; // no progress — bail
    cursorMs = newest.t * 1000;
  }
}

/**
 * Fetch the 5m series for `instId` covering `[range.fromMs, range.toMs)`.
 *
 * Flow:
 *   1. Load existing cache (if any).
 *   2. Determine missing prefix `[fromMs, cache.firstTs)` and suffix `[cache.lastTsClose, toMs)`.
 *   3. Issue paginated Blofin calls to fill each gap, appending each batch
 *      to the gzip file as it arrives (crash-safe).
 *   4. Reload, dedupe, drop incomplete tail, return.
 */
export async function fetchSeriesCached(
  instId: string,
  range: FetchRange,
  opts?: { rateLimitRps?: number; signal?: AbortSignal },
): Promise<CachedSeries> {
  if (!(range.toMs > range.fromMs)) {
    return { instId, bar: "5m", candles: [], coverage: { fromMs: 0, toMs: 0 } };
  }
  const rps = Math.max(1, opts?.rateLimitRps ?? DEFAULT_RATE_LIMIT_RPS);
  const limiter = new RateLimiter(rps);
  const signal = opts?.signal;

  let cached = await loadCachedSeries(instId);

  // Snap fromMs to the start of a 5m bar to make gap math precise.
  const alignedFromMs = Math.floor(range.fromMs / BAR_MS) * BAR_MS;
  const alignedToMs = Math.ceil(range.toMs / BAR_MS) * BAR_MS;

  // Missing prefix: cached either doesn't exist or starts after alignedFromMs.
  const cachedFirstMs = cached && cached.candles.length > 0
    ? cached.candles[0]!.t * 1000
    : Infinity;
  const cachedLastCloseMs = cached && cached.candles.length > 0
    ? cached.candles[cached.candles.length - 1]!.t * 1000 + BAR_MS
    : -Infinity;

  if (cachedFirstMs > alignedFromMs) {
    const gapTo = Number.isFinite(cachedFirstMs) ? cachedFirstMs : alignedToMs;
    await fetchBackward(instId, alignedFromMs, gapTo, limiter, signal, async (batch) => {
      await appendCandlesToCache(instId, batch);
    });
  }

  if (cachedLastCloseMs < alignedToMs) {
    const gapFrom = Number.isFinite(cachedLastCloseMs) && cachedLastCloseMs > 0
      ? cachedLastCloseMs - BAR_MS // cursorMs is exclusive; step back one bar so `before` returns it
      : alignedFromMs - BAR_MS;
    // Only attempt forward fetch if we already covered the prefix above OR
    // there's a real gap to the right of the cache.
    if (cachedLastCloseMs >= alignedFromMs || cachedFirstMs === Infinity) {
      // If no cache yet, the backward fetch above already covered everything;
      // skip the forward leg to avoid duplicate work.
      if (cachedFirstMs !== Infinity) {
        await fetchForward(instId, gapFrom, alignedToMs, limiter, signal, async (batch) => {
          await appendCandlesToCache(instId, batch);
        });
      }
    }
  }

  // Reload + dedupe + sort. Rewrite the file as a single gzip chunk so
  // subsequent loads are fast.
  cached = await loadCachedSeries(instId);
  if (!cached) {
    return { instId, bar: "5m", candles: [], coverage: { fromMs: 0, toMs: 0 } };
  }
  const trimmed = dropIncompleteTail(cached.candles, Date.now());
  // Persist the cleaned, deduplicated form (idempotent — `loadCachedSeries`
  // already dedupes in memory).
  if (trimmed.length !== cached.candles.length) {
    await rewriteCache(instId, trimmed);
  } else if (cached.candles.length > 0) {
    // Opportunistic compaction: if the file grew via many concat-gz chunks,
    // rewrite it as a single chunk. Cheap heuristic — always rewrite on a
    // non-empty cache; the cost is negligible vs. the network work just done.
    await rewriteCache(instId, trimmed);
  }

  // Return the window the caller asked for.
  const inWindow = trimmed.filter(
    (c) => c.t * 1000 >= range.fromMs && c.t * 1000 < range.toMs,
  );
  return toCachedSeries(instId, inWindow);
}

// Public surface ends here. Internal helpers (decoding, rate limiter, etc.)
// stay module-private per INTEGRATION_CONTRACT.md. If tester-morty needs them,
// they can be promoted via integration-morty review.
//
// `BAR_SEC` is intentionally kept (potential future use by callers walking
// fold boundaries by bar count). Suppress unused-var noise here:
void BAR_SEC;
