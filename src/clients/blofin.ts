/**
 * Blofin Open API — public market data client.
 * Base: https://openapi.blofin.com
 * No API key needed for these public endpoints.
 *
 * Symbols use dash format with USDT quote: "BTC-USDT" (perpetual swap),
 * not "BTCUSDT" and not "BTC_USDT".
 *
 * Docs: https://docs.blofin.com/index.html
 *
 * Response envelope: every endpoint returns `{ code: "0", msg: "", data: ... }`
 * where code "0" = success. Any other code surfaces as an error in our helpers.
 */

import { fetchJson } from "../http.js";
import type { Candle } from "../analysis/indicators.js";

const BASE = "https://openapi.blofin.com";

/** Native Blofin bar identifiers (mixed case is intentional — that's the API). */
export type BlofinBar =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1H"
  | "2H"
  | "4H"
  | "6H"
  | "8H"
  | "12H"
  | "1D"
  | "3D"
  | "1W"
  | "1M";

interface Envelope<T> {
  code: string;
  msg?: string;
  data: T;
}

export interface BlofinInstrument {
  instId: string;            // e.g. "BTC-USDT"
  baseCurrency: string;
  quoteCurrency: string;
  contractValue: string;     // per-contract base-asset multiplier
  minSize: string;
  maxLeverage: string;
  instType: string;          // "SWAP" for perpetuals
  state: string;             // "live" when tradable
}

export interface BlofinTicker {
  instId: string;
  last: string;
  askPrice: string;
  bidPrice: string;
  high24h: string;
  low24h: string;
  open24h?: string;          // 24h ago open — needed to compute riseFallRate
  vol24h: string;            // contracts
  volCurrency24h?: string;   // base-asset volume
  volCurrencyQuote24h?: string; // quote (USDT) volume — preferred for volume24Quote
  ts: string;                // ms
}

export interface BlofinFundingRate {
  instId: string;
  fundingRate: string;       // per-cycle rate (e.g. "0.000332" = 0.0332% per 8h)
  fundingTime: string;       // next settlement, ms
}

/**
 * Candle row: [ts, open, high, low, close, vol, volCurrency, volCurrencyQuote, confirm].
 * Times are strings of unix ms, "confirm" is "1" when the bar has closed.
 */
type CandleRow = readonly [string, string, string, string, string, string, string, string, string];

const num = (s: string | undefined | null): number => {
  if (s == null) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

async function getEnvelope<T>(url: string): Promise<T | null> {
  try {
    const env = await fetchJson<Envelope<T>>(url);
    if (env.code !== "0") return null;
    return env.data;
  } catch {
    return null;
  }
}

/**
 * Pull instrument list. Filters to live perpetual swaps only — `instType==="SWAP"`
 * and `state==="live"`. Other instrument types (futures with expiry, options) are
 * dropped since the analysis pipeline assumes perpetuals.
 */
export async function getInstruments(): Promise<BlofinInstrument[]> {
  const data = await getEnvelope<BlofinInstrument[]>(`${BASE}/api/v1/market/instruments`);
  if (!data) return [];
  return data.filter((i) => i.instType === "SWAP" && i.state === "live");
}

/**
 * Optional pagination cursor for `getNativeCandles`. Per Blofin's
 * `/api/v1/market/candles` docs:
 *   - `before` (unix ms): return bars with timestamp **newer** than this value
 *     (i.e. forward-pagination — extending the cache toward the present).
 *   - `after`  (unix ms): return bars with timestamp **older** than this value
 *     (i.e. backward-pagination — backfilling history). This is the standard
 *     OKX-derived semantics that Blofin inherits.
 *   - `limit`: max bars per response. Hard-cap is 1440 (Blofin docs).
 *
 * Both cursors are EXCLUSIVE on the Blofin side; callers passing `last.t*1000`
 * as `before` will get bars strictly newer than `last`, no duplicate.
 */
export interface BlofinCandleOpts {
  before?: number;
  after?: number;
  limit?: number;
}

/**
 * Pull candles for one instrument. Blofin returns newest-first; we reverse to
 * oldest-first to match the repo-wide convention. We take quote volume (index 7,
 * USDT-denominated) so volumes are apples-to-apples with MEXC's amount24.
 *
 * Two call styles, both supported (backward-compatible):
 *   - Legacy: `getNativeCandles(instId, bar, limit?)` — old call sites continue
 *     to work; `limit` defaults to 500.
 *   - Paginated: `getNativeCandles(instId, bar, { before?, after?, limit? })`
 *     — used by the backtest data-fetcher to walk windows > 1440 bars.
 *
 * Limit is always clamped to [1, 1440].
 */
export async function getNativeCandles(
  instId: string,
  bar: BlofinBar,
  limitOrOpts: number | BlofinCandleOpts = 500,
): Promise<Candle[]> {
  const opts: BlofinCandleOpts =
    typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts;
  const capped = Math.min(Math.max(1, opts.limit ?? 500), 1440);

  const params = new URLSearchParams();
  params.set("instId", instId);
  params.set("bar", bar);
  params.set("limit", String(capped));
  if (opts.before !== undefined && Number.isFinite(opts.before)) {
    params.set("before", String(Math.floor(opts.before)));
  }
  if (opts.after !== undefined && Number.isFinite(opts.after)) {
    params.set("after", String(Math.floor(opts.after)));
  }

  const url = `${BASE}/api/v1/market/candles?${params.toString()}`;
  const rows = await getEnvelope<CandleRow[]>(url);
  if (!rows) return [];
  // Newest-first → reverse to oldest-first.
  return rows
    .slice()
    .reverse()
    .map((r) => ({
      t: Math.floor(num(r[0]) / 1000), // ms → seconds, matching MEXC/Coinbase candles
      o: num(r[1]),
      h: num(r[2]),
      l: num(r[3]),
      c: num(r[4]),
      v: num(r[7]),                    // volCurrencyQuote (USDT)
    }));
}

/**
 * Single-ticker fetch. Returns null if the symbol is unknown or the API errored.
 *
 * Blofin doesn't expose a 24h % change field directly, so we compute it from
 * (last - open24h) / open24h when open24h is present. If the API skips open24h
 * (rare), riseFallRate falls back to 0 — the analysis layer treats this as
 * "no signal" rather than blowing up.
 */
export async function getTicker(instId: string): Promise<BlofinTicker | null> {
  const url = `${BASE}/api/v1/market/tickers?instId=${encodeURIComponent(instId)}`;
  const data = await getEnvelope<BlofinTicker[]>(url);
  if (!data || data.length === 0) return null;
  return data[0] ?? null;
}

export async function getFundingRate(instId: string): Promise<BlofinFundingRate | null> {
  const url = `${BASE}/api/v1/market/funding-rate?instId=${encodeURIComponent(instId)}`;
  const data = await getEnvelope<BlofinFundingRate[]>(url);
  if (!data || data.length === 0) return null;
  return data[0] ?? null;
}

// --- Symbol cache + canonical resolver ---

let cachedSymbols: Set<string> | null = null;
let cachedAt = 0;
const SYMBOLS_TTL_MS = 60 * 60 * 1000;

async function refreshSymbolCache(): Promise<void> {
  if (cachedSymbols && Date.now() - cachedAt < SYMBOLS_TTL_MS) return;
  const insts = await getInstruments();
  cachedSymbols = new Set(insts.map((i) => i.instId));
  cachedAt = Date.now();
}

export async function symbolExists(instId: string): Promise<boolean> {
  await refreshSymbolCache();
  return cachedSymbols?.has(instId) ?? false;
}

/**
 * Known asset → canonical-symbol overrides. Use when the common ticker
 * diverges from Blofin's listed pair (e.g. ticker rebrands).
 */
const PERP_ALIASES: Record<string, string> = {
  // Polygon rebrand — Blofin lists POL, not MATIC.
  MATIC: "POL",
};

/**
 * Resolve a bare asset ticker (e.g. "BTC") to its canonical Blofin perp
 * symbol ("BTC-USDT"). Tries USDT quote first (the universal perp quote on
 * Blofin), falls back to USD if USDT isn't listed.
 */
export async function findCanonicalPerp(asset: string): Promise<string | null> {
  const upper = asset.toUpperCase();
  const aliased = PERP_ALIASES[upper] ?? upper;
  const candidates = [`${aliased}-USDT`, `${aliased}-USD`];
  for (const c of candidates) {
    if (await symbolExists(c)) return c;
  }
  return null;
}

/** Test helper — clears the 1h symbol cache so unit tests can rebuild it. */
export function _resetSymbolCache(): void {
  cachedSymbols = null;
  cachedAt = 0;
}

/**
 * Blofin perps typically settle funding every 8h. The funding-rate endpoint
 * doesn't return the cycle length directly, so we hardcode 8h here. If Blofin
 * ever ships per-instrument cycle lengths, swap this for the API value.
 */
export const BLOFIN_FUNDING_CYCLE_HOURS = 8;
