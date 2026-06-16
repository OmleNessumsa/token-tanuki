/**
 * Paper-trading wiring for the multi-premium PortfolioAllocator (ticket CB-024,
 * epic CB-020, ADR-001). This is the I/O / adapter layer that sits OUTSIDE the
 * pure `allocator.ts`: it fetches/assembles live (paper) `MarketData`,
 * instantiates the trend + funding-carry sleeves, runs the allocator, and maps
 * the resulting `AllocationResult.book` onto a weight-based paper book — exactly
 * the machinery `paper-harvester.ts` uses, generalized to SIGNED legs (spot +
 * perp, long + short) instead of long-only weights.
 *
 * ── RELATION TO paper-harvester.ts ────────────────────────────────────────
 * `paper-harvester.ts` is READ-ONLY (Integration Contract V2). This module does
 * NOT edit it; it MIRRORS its structure (`createEmpty` / `markToMarket` /
 * `rebalanceToTarget` accounting invariant: NAV after = NAV before − cost,
 * remainder held in cash) in a small adapter that understands signed positions.
 * The single behavioral difference is that legs carry a sign (a −w perp leg is a
 * SHORT) and the per-leg key is `(symbol, instrument)` rather than bare symbol,
 * so a delta-neutral spot+perp pair on the same underlying is two distinct book
 * lines that net to ~0 directional exposure.
 *
 * ── PURITY BOUNDARY ───────────────────────────────────────────────────────
 * `allocator.ts` is pure; ALL I/O lives here. This file may touch the network
 * (Blofin client) and disk (state persistence). It does NOT import from
 * `src/backtest/*` (one-way dep rule): it fetches candles/funding via the
 * `src/clients/blofin.ts` client directly and assembles `MarketData` with the
 * PURE helpers in `funding-carry-data.ts` — never via the backtest fetcher.
 *
 * ── NO-LOOK-AHEAD ─────────────────────────────────────────────────────────
 * Like the harvester runner, we drop the still-forming UTC day before building
 * the grid, so the allocator's bar `i = grid.length − 1` decision uses only
 * closed bars and settled funding.
 *
 * Usage (runner script wires argv → these functions):
 *   const md   = await buildPaperMarketData(TREND_UNIVERSE, CARRY_ASSETS, range);
 *   const allo = createAllocator([trendSleeve, fundingSleeve], cfg);
 *   const res  = allo.allocateAt(md, md.grid.length - 1);
 *   const next = rebalanceToBook(state, res.book, priceMap, md.grid.at(-1)*1000);
 */

import { getNativeCandles, getFundingRateHistory } from "../clients/blofin.js";
import type { Candle } from "../analysis/indicators.js";
import {
  assemblePairs,
  type RawPairInput,
} from "./sleeves/funding-carry-data.js";
import {
  createTrendSleeve,
  type TrendSleeveConfig,
} from "./sleeves/trend-sleeve.js";
import {
  createFundingCarrySleeve,
  DEFAULT_FUNDING_CARRY_CONFIG,
  type FundingCarryConfig,
} from "./sleeves/funding-carry-sleeve.js";
import { createAllocator } from "./allocator.js";
import type {
  AllocationResult,
  AllocatorConfig,
  FundingPoint,
  MarketData,
  PortfolioAllocator,
  Sleeve,
  TargetLeg,
} from "./sleeve.js";

const SEC_PER_DAY = 86_400;
const DAY_MS = SEC_PER_DAY * 1000;

// ── Live MarketData assembly (the I/O half) ─────────────────────────────────

/** Inclusive-start / exclusive-end fetch window in unix ms. */
export interface PaperFetchRange {
  fromMs: number;
  toMs: number;
}

/** Default paper window: trailing ~400 closed days (> any sleeve warmup). */
export function defaultPaperRange(now = Date.now()): PaperFetchRange {
  const todayMidnightMs = Math.floor(now / DAY_MS) * DAY_MS; // forming day start
  return { fromMs: todayMidnightMs - 400 * DAY_MS, toMs: todayMidnightMs };
}

/**
 * Fetch closed daily candles for one instrument over `[fromMs, toMs)`, dropping
 * the still-forming day. Oldest-first.
 */
async function fetchClosedDaily(
  instId: string,
  range: PaperFetchRange,
  pageDelayMs: number,
): Promise<Candle[]> {
  const bars: Candle[] = await getNativeCandles(instId, "1D", { limit: 300 });
  const fromSec = Math.floor(range.fromMs / 1000);
  const toSec = Math.floor(range.toMs / 1000);
  const closed = bars
    .filter((b) => b.t >= fromSec && b.t < toSec && b.c > 0)
    .sort((a, b) => a.t - b.t);
  if (pageDelayMs > 0) await new Promise((r) => setTimeout(r, pageDelayMs));
  return closed;
}

/** Funding history for `instId` over the window, as the sleeve's FundingPoint[]. */
async function fetchFunding(
  instId: string,
  range: PaperFetchRange,
  pageDelayMs: number,
): Promise<FundingPoint[]> {
  const entries = await getFundingRateHistory(instId, range.fromMs, pageDelayMs);
  return entries
    .map((e) => ({ tMs: Number(e.fundingTime), rate: Number(e.fundingRate) }))
    .filter((f) => Number.isFinite(f.tMs) && Number.isFinite(f.rate) && f.tMs < range.toMs)
    .sort((a, b) => a.tMs - b.tMs);
}

/**
 * Build the full paper `MarketData` for the allocator: trend-sleeve `assets`
 * and funding-carry `pairs`, all aligned to ONE shared day-grid via the pure
 * `assemblePairs` helper plus a trend-asset re-key onto that same grid.
 *
 * The spot leg of each carry pair is, for this first cert, the PROXY: the same
 * perp instId (per ADR-001's spot-proxy decision). Swapping to a real spot
 * market is a fetcher-only change upstream; this wiring stays the same.
 *
 * @param trendUniverse perp instIds for the trend sleeve (e.g. ["BTC-USDT", …]).
 * @param carryAssets   logical assets for funding-carry (e.g. ["BTC", "ETH"]).
 */
export async function buildPaperMarketData(
  trendUniverse: readonly string[],
  carryAssets: readonly string[],
  range: PaperFetchRange = defaultPaperRange(),
  pageDelayMs = 200,
): Promise<MarketData> {
  // 1. Carry pairs (perp = proxy-spot for the first cert).
  const raws: RawPairInput[] = [];
  for (const asset of carryAssets) {
    const perpInstId = `${asset.toUpperCase()}-USDT`;
    const perpCandles = await fetchClosedDaily(perpInstId, range, pageDelayMs);
    if (perpCandles.length === 0) continue;
    const funding = await fetchFunding(perpInstId, range, pageDelayMs);
    raws.push({
      pair: asset.toUpperCase(),
      spotSymbol: perpInstId, // PROXY: spot ≈ perp for first cert
      perpSymbol: perpInstId,
      spotCandles: perpCandles,
      perpCandles,
      funding,
    });
  }
  const { grid: pairGrid, pairs } = assemblePairs(raws);

  // 2. Trend assets, aligned to the SAME grid (re-stamp closes to day grid).
  const assets = [];
  const trendDaySet = new Set<number>();
  const trendByDay = new Map<string, Map<number, Candle>>();
  for (const instId of trendUniverse) {
    const candles = await fetchClosedDaily(instId, range, pageDelayMs);
    const byDay = new Map<number, Candle>();
    for (const c of candles) {
      const day = Math.floor(c.t / SEC_PER_DAY) * SEC_PER_DAY;
      const prev = byDay.get(day);
      if (prev === undefined || c.t >= prev.t) byDay.set(day, c);
      trendDaySet.add(day);
    }
    trendByDay.set(instId, byDay);
  }

  // 3. Shared grid = union of carry grid + trend days, sorted oldest-first.
  const gridSet = new Set<number>(pairGrid);
  for (const d of trendDaySet) gridSet.add(d);
  const grid = [...gridSet].sort((a, b) => a - b);

  // 4. Re-key trend assets onto the shared grid.
  for (const [instId, byDay] of trendByDay) {
    const aligned: Candle[] = [];
    for (const day of grid) {
      const c = byDay.get(day);
      if (c !== undefined) aligned.push({ t: day, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    }
    if (aligned.length > 0) assets.push({ symbol: instId, candles: aligned });
  }

  return { grid, assets, pairs };
}

/**
 * Convenience: build the standard two-sleeve allocator (certified trend basket
 * + delta-neutral funding-carry) with optional config overrides. The trend
 * universe is pre-declared on the sleeve so `universe()` is populated, but the
 * allocator derives the ACTIVE universe from `targetAt(...).legs` regardless.
 */
export function buildPaperAllocator(opts: {
  trendUniverse: readonly string[];
  trendConfig?: Partial<TrendSleeveConfig>;
  fundingConfig?: FundingCarryConfig;
  allocatorConfig?: Partial<AllocatorConfig>;
}): PortfolioAllocator {
  const trend: Sleeve = createTrendSleeve(opts.trendConfig ?? {}, opts.trendUniverse);
  const funding: Sleeve = createFundingCarrySleeve(
    opts.fundingConfig ?? DEFAULT_FUNDING_CARRY_CONFIG,
  );
  return createAllocator([trend, funding], opts.allocatorConfig ?? {});
}

// ── Signed-leg paper book (mirrors paper-harvester accounting) ──────────────

/** One book line: a position in a specific instrument leg, signed (short < 0). */
export interface BookLegKey {
  symbol: string;
  instrument: "spot" | "perp";
}

/** Stable string key for a (symbol, instrument) book line. */
function legKey(symbol: string, instrument: "spot" | "perp"): string {
  return `${symbol}|${instrument}`;
}

/**
 * Multi-sleeve paper-portfolio state. Generalizes `HarvesterPaperState` to
 * signed per-leg units (a −w perp leg is a short). Mirrors the harvester's
 * cash + units model; NAV = cash + Σ units·price (shorts contribute negative
 * market value, so a delta-neutral pair's net market value is ~0).
 */
export interface AllocatorPaperState {
  startedAt: number;
  initialCash: number;
  cash: number;
  /** legKey → signed units held (short positions are negative). */
  units: Record<string, number>;
  costPerLegRoundTrip: number;
  lastRebalanceDayMs: number;
  navHistory: Array<{ dayMs: number; nav: number }>;
}

/** Fresh, fully-cash paper state. */
export function createEmptyAllocatorState(
  initialCash = 10_000,
  costPerLegRoundTrip = 0.0014,
  startedAt = 0,
): AllocatorPaperState {
  return {
    startedAt,
    initialCash,
    cash: initialCash,
    units: {},
    costPerLegRoundTrip,
    lastRebalanceDayMs: 0,
    navHistory: [],
  };
}

/** NAV = cash + Σ units·price (signed; missing price ⇒ that leg counts as 0). */
export function markToMarket(
  state: AllocatorPaperState,
  prices: Record<string, number>,
): number {
  let nav = state.cash;
  for (const [key, u] of Object.entries(state.units)) {
    const sym = key.split("|")[0]!;
    const p = prices[sym];
    if (p !== undefined && p > 0) nav += u * p;
  }
  return nav;
}

/**
 * Collapse an allocator `book` (signed legs, possibly several per instrument
 * leg after merge) into target SIGNED weights per `(symbol, instrument)` line.
 * Delta-neutral pairing is preserved implicitly: a +w spot line and −w perp
 * line remain two separate, oppositely-signed targets.
 */
export function bookToLegWeights(book: readonly TargetLeg[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const leg of book) {
    const k = legKey(leg.symbol, leg.instrument);
    out[k] = (out[k] ?? 0) + leg.weight;
  }
  return out;
}

/**
 * Rebalance the signed paper book to the allocator's target legs at `prices`.
 * PURE accounting that mirrors `paper-harvester.rebalanceToTarget`'s invariant:
 * NAV after = NAV before − totalCost; the un-deployed remainder stays in cash.
 * Cost is charged per leg on traded notional (|Δunits|·price), identical to the
 * harvester — shorting and covering both incur the per-leg round-trip cost.
 *
 * @param prices instrument-symbol → close (one price per underlying; a pair's
 *   spot and perp proxy share the same symbol, hence the same price ⇒ the pair
 *   nets to ~0 directional market value, as intended).
 */
export function rebalanceToBook(
  state: AllocatorPaperState,
  book: readonly TargetLeg[],
  prices: Record<string, number>,
  dayMs: number,
): { state: AllocatorPaperState; navBefore: number; navAfter: number; totalCost: number; turnover: number } {
  const navBefore = markToMarket(state, prices);
  const targets = bookToLegWeights(book);
  const newUnits: Record<string, number> = { ...state.units };
  let cash = state.cash;
  let totalCost = 0;
  let tradedNotional = 0;

  // Union of currently-held legs and target legs.
  const keys = new Set<string>([...Object.keys(state.units), ...Object.keys(targets)]);
  for (const key of keys) {
    const sym = key.split("|")[0]!;
    const p = prices[sym];
    if (p === undefined || p <= 0) continue;
    const cur = state.units[key] ?? 0;
    const targetUnits = (navBefore * (targets[key] ?? 0)) / p;
    const deltaUnits = targetUnits - cur;
    const notional = Math.abs(deltaUnits * p);
    if (notional < 1e-9) {
      newUnits[key] = targetUnits;
      continue;
    }
    const cost = notional * state.costPerLegRoundTrip;
    cash -= deltaUnits * p; // buy lowers cash, sell/short raises it
    cash -= cost;
    newUnits[key] = targetUnits;
    tradedNotional += notional;
    totalCost += cost;
  }

  const newState: AllocatorPaperState = {
    ...state,
    cash,
    units: newUnits,
    lastRebalanceDayMs: dayMs,
  };
  const navAfter = markToMarket(newState, prices);
  newState.navHistory = [...state.navHistory, { dayMs, nav: navAfter }];
  return {
    state: newState,
    navBefore,
    navAfter,
    totalCost,
    turnover: navBefore > 0 ? tradedNotional / navBefore : 0,
  };
}

/**
 * Extract a `symbol → close` price map at the latest bar of a `MarketData`
 * snapshot — the prices the allocator's bar-i book trades at. Used by the
 * runner to feed `rebalanceToBook`.
 */
export function latestPrices(data: MarketData): Record<string, number> {
  const i = data.grid.length - 1;
  if (i < 0) return {};
  const day = data.grid[i]!;
  const out: Record<string, number> = {};
  const take = (symbol: string, candles: readonly Candle[]) => {
    for (let k = candles.length - 1; k >= 0; k--) {
      if (candles[k]!.t === day && candles[k]!.c > 0) {
        out[symbol] = candles[k]!.c;
        return;
      }
    }
  };
  for (const a of data.assets) take(a.symbol, a.candles);
  for (const p of data.pairs) {
    take(p.spot.symbol, p.spot.candles);
    take(p.perp.symbol, p.perp.candles);
  }
  return out;
}

/**
 * One-shot paper step: build live MarketData, run the allocator at the latest
 * closed bar, rebalance the paper book, and return the new state + allocation
 * diagnostics. This is the function a daily runner script invokes. Idempotent
 * on same-day reruns is the runner's responsibility (compare `dayMs` to
 * `state.lastRebalanceDayMs`), mirroring the harvester runner.
 */
export async function stepPaperAllocator(opts: {
  state: AllocatorPaperState;
  trendUniverse: readonly string[];
  carryAssets: readonly string[];
  trendConfig?: Partial<TrendSleeveConfig>;
  fundingConfig?: FundingCarryConfig;
  allocatorConfig?: Partial<AllocatorConfig>;
  range?: PaperFetchRange;
}): Promise<{
  state: AllocatorPaperState;
  result: AllocationResult;
  prices: Record<string, number>;
  dayMs: number;
  navBefore: number;
  navAfter: number;
  totalCost: number;
  turnover: number;
}> {
  const data = await buildPaperMarketData(
    opts.trendUniverse,
    opts.carryAssets,
    opts.range ?? defaultPaperRange(),
  );
  const allocator = buildPaperAllocator({
    trendUniverse: opts.trendUniverse,
    trendConfig: opts.trendConfig,
    fundingConfig: opts.fundingConfig,
    allocatorConfig: opts.allocatorConfig,
  });
  const i = data.grid.length - 1;
  const result = allocator.allocateAt(data, i);
  const prices = latestPrices(data);
  const dayMs = (data.grid[i] ?? 0) * 1000;
  const reb = rebalanceToBook(opts.state, result.book, prices, dayMs);
  return {
    state: reb.state,
    result,
    prices,
    dayMs,
    navBefore: reb.navBefore,
    navAfter: reb.navAfter,
    totalCost: reb.totalCost,
    turnover: reb.turnover,
  };
}
