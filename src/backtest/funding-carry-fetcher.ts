/**
 * Sleeve-B (delta-neutral funding-carry) data fetcher. CB-023.
 *
 * The ONLY new I/O module for Sleeve B: it fetches perp candles, the
 * proxy-spot candles, and the settled funding history via the Blofin client,
 * then hands raw arrays to the PURE assembler in
 * `src/strategy/sleeves/funding-carry-data.ts`. Nothing downstream of the
 * assembler touches the network.
 *
 * ── SPOT-LEG PROXY (Elmo's decision, CB-023) ─────────────────────────────
 * Blofin's stack here is perp-centric — there is no real spot market wired in.
 * For this first OOS cert the LONG-SPOT leg is APPROXIMATED by a second
 * perp/index series. `resolveProxySpot` is the single place that approximation
 * lives:
 *   - Default proxy = the SAME perp instrument as the short leg. The basis
 *     (perp − proxySpot) is then ~0 with ~0 drift, which models a clean,
 *     fully-hedged delta-neutral carry capture. This is the honest first-cut:
 *     it isolates the funding cash flow with minimal basis noise, and it is
 *     deliberately conservative on the upside (no synthetic basis alpha).
 *   - A future ticket swaps `resolveProxySpot` to return a real Blofin spot
 *     instId (or a distinct index perp) — NOTHING else in Sleeve B changes,
 *     because the sleeve only ever reads `pair.spot` / `pair.perp` closes and
 *     tags the long leg `instrument: "spot"`.
 * Grep marker for the later real-spot ticket: `PROXY_SPOT_SWAP_POINT`.
 *
 * Bars: Sleeve B runs on the same daily grid as the trend sleeve, so we fetch
 * `1D` candles (not the 5m universe-scan bars). Funding history is the settled
 * 8h-cycle series from `getFundingRateHistory`.
 */

import type { Candle } from "../analysis/indicators.js";
import type { FundingPoint } from "../strategy/sleeve.js";
import {
  getFundingRateHistory,
  getNativeCandles,
  findCanonicalPerp,
  type BlofinBar,
} from "../clients/blofin.js";
import {
  assemblePairs,
  type RawPairInput,
} from "../strategy/sleeves/funding-carry-data.js";

const DAY_MS = 86_400_000;
/** Blofin caps each candles call at 1440 bars; daily bars rarely need paging. */
const BLOFIN_LIMIT_MAX = 1440;
const DAILY_BAR: BlofinBar = "1D";

export interface FundingCarryFetchRange {
  /** Inclusive start, unix ms. */
  fromMs: number;
  /** Exclusive end, unix ms. */
  toMs: number;
}

export interface FundingCarryFetchOpts {
  /** Per-request delay (ms) to stay under Blofin rate limits. Default 250. */
  pageDelayMs?: number;
}

/**
 * PROXY_SPOT_SWAP_POINT — the single approximation locus for the spot leg.
 *
 * Given a logical asset (e.g. "BTC") and its resolved perp instId, return the
 * instId to use for the LONG-SPOT (proxy) leg. Today: the same perp (clean,
 * basis≈0 hedge). A later real-spot ticket changes ONLY this function to return
 * the asset's Blofin spot instId, e.g. via a `findCanonicalSpot(asset)` helper.
 */
function resolveProxySpot(_asset: string, perpInstId: string): string {
  // First-cert proxy: long-spot ≈ same perp instrument as the short leg.
  return perpInstId;
}

/**
 * Fetch oldest-first daily candles for `instId` covering `[fromMs, toMs)`,
 * paging backward with Blofin's `after` cursor when the window exceeds the
 * per-call cap. Daily windows are usually small enough for one call.
 */
async function fetchDailyCandles(
  instId: string,
  fromMs: number,
  toMs: number,
  pageDelayMs: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursorMs = toMs;
  const maxPages =
    Math.max(1, Math.ceil((toMs - fromMs) / (BLOFIN_LIMIT_MAX * DAY_MS))) * 2 + 2;

  for (let page = 0; page < maxPages; page++) {
    const batch = await getNativeCandles(instId, DAILY_BAR, {
      after: cursorMs,
      limit: BLOFIN_LIMIT_MAX,
    });
    if (batch.length === 0) break;
    for (const c of batch) {
      const ms = c.t * 1000;
      if (ms >= fromMs && ms < toMs) out.push(c);
    }
    const oldest = batch[0]!; // oldest-first after client reverse
    if (batch.length < BLOFIN_LIMIT_MAX) break;
    if (oldest.t * 1000 <= fromMs) break;
    cursorMs = oldest.t * 1000;
    if (pageDelayMs > 0) await new Promise((r) => setTimeout(r, pageDelayMs));
  }

  // De-dupe + sort oldest-first.
  const seen = new Set<number>();
  return out
    .filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)))
    .sort((a, b) => a.t - b.t);
}

/** Convert settled funding-history entries to the sleeve's `FundingPoint[]`. */
function toFundingPoints(
  entries: ReadonlyArray<{ fundingRate: string; fundingTime: string }>,
): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (const e of entries) {
    const tMs = Number(e.fundingTime);
    const rate = Number(e.fundingRate);
    if (Number.isFinite(tMs) && Number.isFinite(rate)) out.push({ tMs, rate });
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

/**
 * Fetch one pair's raw inputs (perp candles, proxy-spot candles, funding) for
 * `asset` over `range`. Resolves the canonical perp first; returns null if the
 * asset isn't listed on Blofin.
 */
export async function fetchRawPair(
  asset: string,
  range: FundingCarryFetchRange,
  opts: FundingCarryFetchOpts = {},
): Promise<RawPairInput | null> {
  const pageDelayMs = opts.pageDelayMs ?? 250;
  const perpInstId = await findCanonicalPerp(asset);
  if (perpInstId === null) return null;
  const spotInstId = resolveProxySpot(asset, perpInstId); // PROXY_SPOT_SWAP_POINT

  const perpCandles = await fetchDailyCandles(perpInstId, range.fromMs, range.toMs, pageDelayMs);
  // When the proxy spot IS the perp, reuse the same candles instead of a second
  // network round-trip. A real-spot swap (distinct instId) re-fetches.
  const spotCandles =
    spotInstId === perpInstId
      ? perpCandles
      : await fetchDailyCandles(spotInstId, range.fromMs, range.toMs, pageDelayMs);

  const fundingEntries = await getFundingRateHistory(perpInstId, range.fromMs, pageDelayMs);
  const funding = toFundingPoints(
    fundingEntries.filter((e) => Number(e.fundingTime) < range.toMs),
  );

  return {
    pair: asset.toUpperCase(),
    spotSymbol: spotInstId,
    perpSymbol: perpInstId,
    spotCandles,
    perpCandles,
    funding,
  };
}

/**
 * Fetch + assemble the full Sleeve-B market input for a set of assets, aligned
 * onto one shared day-grid. Returns the grid plus `FundingPairData[]` ready to
 * drop into `MarketData.pairs`. Assets that don't resolve on Blofin are skipped.
 */
export async function fetchFundingCarryData(
  assets: readonly string[],
  range: FundingCarryFetchRange,
  opts: FundingCarryFetchOpts = {},
): Promise<{ grid: number[]; pairs: ReturnType<typeof assemblePairs>["pairs"] }> {
  const raws: RawPairInput[] = [];
  for (const asset of assets) {
    const raw = await fetchRawPair(asset, range, opts);
    if (raw !== null) raws.push(raw);
  }
  return assemblePairs(raws);
}
