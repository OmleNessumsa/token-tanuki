/**
 * Shared bulk-fetch helpers for probe scripts (CB-010).
 *
 * Encodes the Blofin operational lessons from 2026-06-12 so probes stop
 * re-learning them:
 * - The rate limiter silently truncates: errors surface as empty batches.
 *   Every page fetch retries with exponential backoff before an empty
 *   result is accepted as end-of-history.
 * - Pagination is `after=<ms>` → older records, newest-first per page.
 * - Throttle ~3 req/s on bulk paths; the penalty box persists minutes
 *   after a heavy run.
 *
 * PROBE-ONLY module: nothing in src/ may import from scripts/.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getNativeCandles, type BlofinBar } from "../../src/clients/blofin.js";
import type { Candle } from "../../src/analysis/indicators.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CACHE_DIR = path.join(homedir(), ".cryptotrader-data", "bulk-cache");

interface CacheFile {
  fromMs: number;
  toMs: number;
  candles: Candle[];
}

async function readCache(instId: string, bar: BlofinBar): Promise<CacheFile | null> {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${instId}.${bar}.json`), "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

async function writeCache(instId: string, bar: BlofinBar, cf: CacheFile): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, `${instId}.${bar}.json`), JSON.stringify(cf));
}

export const BAR_MS: Partial<Record<BlofinBar, number>> = {
  "5m": 5 * 60_000,
  "1H": 3_600_000,
  "4H": 4 * 3_600_000,
  "1D": 24 * 3_600_000,
};

/**
 * Paginate candles of any bar size back from `toMs` until `fromMs`.
 * Oldest-first, deduplicated, clipped to [fromMs, toMs). Empty batches are
 * retried 3× with 1s/3s/9s backoff before being treated as end-of-history
 * (a listing boundary inside the window is the only legitimate cause).
 */
export async function fetchBars(
  instId: string,
  bar: BlofinBar,
  fromMs: number,
  toMs: number,
  pageDelayMs = 300,
): Promise<Candle[]> {
  // Scratch disk cache (~/.cryptotrader-data/bulk-cache/) — probe runs in
  // one session re-request identical (instId, bar, window) sets; a cache
  // hit saves ~10 min of throttled refetching per 1H probe. A cached range
  // that covers the request (one-bar tolerance at the recent edge) is
  // served from disk; anything else refetches and overwrites.
  const barMs = BAR_MS[bar] ?? 0;
  const cached = await readCache(instId, bar);
  if (cached && cached.fromMs <= fromMs && cached.toMs >= toMs - 2 * barMs) {
    return cached.candles.filter((c) => c.t * 1000 >= fromMs && c.t * 1000 < toMs);
  }
  const all: Candle[] = [];
  let cursor = toMs;
  for (let page = 0; page < 60; page++) {
    let batch: Candle[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(1000 * 3 ** (attempt - 1));
      batch = await getNativeCandles(instId, bar, { after: cursor, limit: 1440 });
      if (batch.length > 0) break;
    }
    if (batch.length === 0) break;
    all.push(...batch);
    const oldestMs = batch[0]!.t * 1000;
    if (oldestMs <= fromMs) break;
    cursor = oldestMs;
    await sleep(pageDelayMs);
  }
  const seen = new Set<number>();
  const result = all
    .filter((c) => c.t * 1000 >= fromMs && c.t * 1000 < toMs)
    .filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)))
    .sort((a, b) => a.t - b.t);
  await writeCache(instId, bar, { fromMs, toMs, candles: result });
  return result;
}

/**
 * Top-N USDT perps by 24h quote volume (today's ranking — callers must
 * treat this as survivorship-flavored and resolve membership per date
 * where it matters). Retries through rate-limit HTML pages.
 */
export async function fetchTopUsdtPerps(n: number): Promise<string[]> {
  interface TickerRow {
    instId: string;
    last: string;
    volCurrency24h?: string;
    volCurrencyQuote24h?: string;
  }
  let data: TickerRow[] | null = null;
  for (let attempt = 0; attempt < 6 && data === null; attempt++) {
    if (attempt > 0) await sleep(2000 * 3 ** (attempt - 1));
    try {
      const res = await fetch("https://openapi.blofin.com/api/v1/market/tickers");
      const parsed = (await res.json()) as { code: string; data: TickerRow[] };
      if (parsed.code === "0") data = parsed.data;
    } catch {
      // HTML rate-limit page or network hiccup — retry
    }
  }
  if (!data) throw new Error("tickers fetch failed after 6 attempts");
  return data
    .filter((t) => t.instId.endsWith("-USDT"))
    .map((t) => ({
      instId: t.instId,
      qv: t.volCurrencyQuote24h !== undefined
        ? Number(t.volCurrencyQuote24h)
        : Number(t.volCurrency24h ?? 0) * Number(t.last ?? 0),
    }))
    .filter((t) => Number.isFinite(t.qv) && t.qv > 0)
    .sort((a, b) => b.qv - a.qv)
    .slice(0, n)
    .map((t) => t.instId);
}

/** Mean, sample sd, and t-stat of a series. */
export function meanT(xs: readonly number[]): { mean: number; t: number; n: number } {
  const n = xs.length;
  if (n < 2) return { mean: n ? xs[0]! : 0, t: 0, n };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  return { mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, n };
}

function rank(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k]![1]] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation. Returns 0 for n < 3 or degenerate input. */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length < 3) return 0;
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let k = 0; k < n; k++) {
    const dx = rx[k]! - mx;
    const dy = ry[k]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}
