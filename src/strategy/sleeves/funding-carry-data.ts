/**
 * Pure assembly of `FundingPairData` for Sleeve B (delta-neutral
 * funding-carry). CB-023.
 *
 * Aligns spot candles + perp candles + settled funding history onto a shared
 * day-grid (unix seconds, oldest-first) so the funding-carry sleeve speaks the
 * same bar index `i` as every other sleeve and the allocator.
 *
 * ── PURE MODULE ──────────────────────────────────────────────────────────
 * No I/O, no clocks, no randomness. Network/filesystem work for Sleeve B lives
 * ONLY in `src/backtest/funding-carry-fetcher.ts`, which feeds the raw candle +
 * funding arrays into the assembler here. This module does NOT import from
 * `src/backtest/*` (one-way dependency rule, ADR-001 §6).
 *
 * ── SPOT-LEG PROXY (Elmo's decision, CB-023) ─────────────────────────────
 * The "spot" leg in this first OOS cert is a PROXY: a second perp/index series
 * standing in for a real Blofin spot market, which doesn't exist in this
 * perp-centric stack yet. The proxy lives upstream in the fetcher (it picks
 * what fills `spot.candles`); this assembler is agnostic to whether the spot
 * series is a real spot market or a perp proxy. When a later ticket wires real
 * spot execution, swap the source in the fetcher — this file needs no change.
 *
 * ── NO-LOOK-AHEAD ────────────────────────────────────────────────────────
 * The output `FundingPairData` carries full oldest-first series; the SLEEVE is
 * responsible for reading only data through bar `i`. The basis (perp − spot) is
 * NOT precomputed here — it is derived inside the sleeve at bar `i` from the two
 * aligned close series, so no future basis can leak in.
 */

import type { Candle } from "../../analysis/indicators.js";
import type {
  AssetCandles,
  FundingPairData,
  FundingPoint,
} from "../sleeve.js";

/** Raw, unaligned inputs for one pair as produced by the fetcher. */
export interface RawPairInput {
  /** Logical pair id, e.g. "BTC". */
  pair: string;
  /** Spot (or proxy-spot) instrument id, e.g. "BTC-USDT". */
  spotSymbol: string;
  /** Perp instrument id, e.g. "BTC-USDT" (Blofin perp swap). */
  perpSymbol: string;
  /** Oldest-first spot/proxy candles (unix-second `t`). */
  spotCandles: readonly Candle[];
  /** Oldest-first perp candles (unix-second `t`). */
  perpCandles: readonly Candle[];
  /** Settled funding history for the perp leg (settlement ms + signed rate). */
  funding: readonly FundingPoint[];
}

/**
 * Snap a unix-second timestamp down to the start of its UTC day. The portfolio
 * grid is a day-grid (mirrors harvester.ts), so spot/perp candles are bucketed
 * to UTC-day stamps to align cleanly even if the two venues' bar opens differ
 * by sub-day amounts.
 */
const SEC_PER_DAY = 86_400;
function toDayStamp(tSec: number): number {
  return Math.floor(tSec / SEC_PER_DAY) * SEC_PER_DAY;
}

/**
 * Bucket an oldest-first candle series onto UTC-day stamps, keeping the LAST
 * (latest-in-day) candle per day as that day's representative close. Returns a
 * map dayStamp → Candle. Drops candles with non-positive close.
 */
function bucketByDay(candles: readonly Candle[]): Map<number, Candle> {
  const out = new Map<number, Candle>();
  for (const c of candles) {
    if (!(c.c > 0)) continue;
    const day = toDayStamp(c.t);
    const prev = out.get(day);
    // Keep the latest candle within the day (largest original `t`).
    if (prev === undefined || c.t >= prev.t) out.set(day, c);
  }
  return out;
}

/**
 * Re-key a per-day candle map onto the shared grid, producing an oldest-first
 * `AssetCandles` whose `candles[k]` corresponds to `grid[k]` when present.
 * Days with no candle for this symbol are simply omitted (the sleeve aligns by
 * timestamp, not by array position, and treats gaps as "no data at i").
 */
function toAlignedAsset(
  symbol: string,
  byDay: Map<number, Candle>,
  grid: readonly number[],
): AssetCandles {
  const candles: Candle[] = [];
  for (const day of grid) {
    const c = byDay.get(day);
    if (c !== undefined) {
      // Re-stamp to the day grid so spot.t === perp.t === grid[k].
      candles.push({ t: day, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    }
  }
  return { symbol, candles };
}

/**
 * Assemble one `FundingPairData` from raw fetcher output, aligned to `grid`.
 * Funding is sorted oldest-first and de-duplicated on settlement time. The
 * sleeve later filters funding to settlements with `tMs <= grid[i]`.
 */
export function assemblePair(
  raw: RawPairInput,
  grid: readonly number[],
): FundingPairData {
  const spot = toAlignedAsset(raw.spotSymbol, bucketByDay(raw.spotCandles), grid);
  const perp = toAlignedAsset(raw.perpSymbol, bucketByDay(raw.perpCandles), grid);
  const funding = dedupeFunding(raw.funding);
  return { pair: raw.pair, spot, perp, funding };
}

/** Sort funding oldest-first and drop duplicate settlement timestamps. */
function dedupeFunding(funding: readonly FundingPoint[]): FundingPoint[] {
  const sorted = [...funding]
    .filter((f) => Number.isFinite(f.tMs) && Number.isFinite(f.rate))
    .sort((a, b) => a.tMs - b.tMs);
  const out: FundingPoint[] = [];
  let lastT = -Infinity;
  for (const f of sorted) {
    if (f.tMs === lastT) continue;
    out.push(f);
    lastT = f.tMs;
  }
  return out;
}

/**
 * Build the union day-grid (unix seconds, oldest-first) from a set of raw pair
 * inputs. A day is on the grid if AT LEAST ONE pair has both a spot and a perp
 * candle on it — i.e. the day is tradeable for at least one delta-neutral unit.
 * This mirrors harvester.ts's union-of-observed-days grid construction.
 */
export function buildPairGrid(raws: readonly RawPairInput[]): number[] {
  const days = new Set<number>();
  for (const raw of raws) {
    const spotDays = new Set<number>();
    for (const c of raw.spotCandles) if (c.c > 0) spotDays.add(toDayStamp(c.t));
    for (const c of raw.perpCandles) {
      if (!(c.c > 0)) continue;
      const day = toDayStamp(c.t);
      if (spotDays.has(day)) days.add(day);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Convenience: assemble a full set of pairs onto one shared grid. Returns the
 * grid plus the aligned `FundingPairData[]`, ready to drop into `MarketData`.
 */
export function assemblePairs(raws: readonly RawPairInput[]): {
  grid: number[];
  pairs: FundingPairData[];
} {
  const grid = buildPairGrid(raws);
  const pairs = raws.map((raw) => assemblePair(raw, grid));
  return { grid, pairs };
}
