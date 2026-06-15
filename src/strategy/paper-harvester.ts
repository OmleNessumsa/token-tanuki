/**
 * Paper-trading engine for the beta harvester (Fase 3, CB-019).
 *
 * Weight-based portfolio state (cash + per-symbol units), NOT the discrete
 * trade/stop/R model in src/paper-portfolio.ts — a continuously-rebalanced
 * allocation strategy needs allocation machinery. The live signal is the
 * CERTIFIED `targetWeights` from src/strategy/harvester.ts; this module only
 * holds state and applies rebalances. No exchange orders, no real capital.
 *
 * The state transitions (markToMarket, rebalanceToTarget) are PURE; only
 * load/save touch disk. State lives at
 * $CRYPTOTRADER_STATE_DIR/harvester-paper.json (or ~/.cryptotrader/).
 *
 * Accounting invariant (tested): a rebalance reduces NAV by EXACTLY the
 * trading cost; weights below 1.0 leave the remainder in cash (de-risk to
 * cash, matching the strategy's drawdown-control intent).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarvesterConfig } from "./harvester.js";
import { DEFAULT_HARVESTER_CONFIG } from "./harvester.js";

const STATE_DIR = process.env["CRYPTOTRADER_STATE_DIR"] ?? join(homedir(), ".cryptotrader");
const FILE = join(STATE_DIR, "harvester-paper.json");
export const HARVESTER_PAPER_PATH = FILE;

export interface PaperTradeLeg {
  symbol: string;
  deltaUnits: number;
  price: number;
  cost: number;
}

export interface RebalanceRecord {
  dayMs: number;
  navBefore: number;
  navAfter: number;
  totalCost: number;
  turnover: number;
  targetWeights: Record<string, number>;
  trades: PaperTradeLeg[];
}

export interface NavPoint {
  dayMs: number;
  nav: number;
  /** Benchmark price (buy-hold BTC) for comparison. */
  benchPrice: number;
}

export interface HarvesterPaperState {
  startedAt: number;
  initialCash: number;
  cash: number;
  units: Record<string, number>;
  universe: string[];
  config: HarvesterConfig;
  /** Signal-bar day (ms) used for the last rebalance; guards same-day reruns. */
  lastRebalanceDayMs: number;
  navHistory: NavPoint[];
  rebalanceLog: RebalanceRecord[];
  /** Benchmark units: BTC bought-and-held with initialCash at inception. */
  benchUnits: number;
}

export function createEmpty(
  universe: string[],
  initialCash = 10_000,
  config: HarvesterConfig = DEFAULT_HARVESTER_CONFIG,
  startedAt = 0,
): HarvesterPaperState {
  return {
    startedAt,
    initialCash,
    cash: initialCash,
    units: {},
    universe,
    config,
    lastRebalanceDayMs: 0,
    navHistory: [],
    rebalanceLog: [],
    benchUnits: 0,
  };
}

/** Net asset value = cash + Σ units·price. Missing prices count the position as 0. */
export function markToMarket(state: HarvesterPaperState, prices: Record<string, number>): number {
  let nav = state.cash;
  for (const [sym, u] of Object.entries(state.units)) {
    const p = prices[sym];
    if (p !== undefined) nav += u * p;
  }
  return nav;
}

/**
 * Rebalance the book to `target` weights at `prices`. Pure — returns the new
 * state and the trade record. Cost is charged per leg on the traded notional;
 * NAV after = NAV before − totalCost (invariant). benchPrice is the buy-hold
 * BTC reference recorded for the equity comparison.
 */
export function rebalanceToTarget(
  state: HarvesterPaperState,
  target: Record<string, number>,
  prices: Record<string, number>,
  dayMs: number,
  benchSymbol = "BTC-USDT",
): { state: HarvesterPaperState; record: RebalanceRecord } {
  const navBefore = markToMarket(state, prices);
  const newUnits: Record<string, number> = { ...state.units };
  const trades: PaperTradeLeg[] = [];
  let totalCost = 0;
  let tradedNotional = 0;
  let cash = state.cash;

  for (const sym of state.universe) {
    const p = prices[sym];
    if (p === undefined || p <= 0) continue;
    const cur = state.units[sym] ?? 0;
    const targetDollar = navBefore * (target[sym] ?? 0);
    const targetUnits = targetDollar / p;
    const deltaUnits = targetUnits - cur;
    if (Math.abs(deltaUnits * p) < 1e-9) continue;
    const notional = Math.abs(deltaUnits * p);
    const cost = notional * state.config.costPerLegRoundTrip;
    cash -= deltaUnits * p; // buy lowers cash, sell raises it
    cash -= cost;
    newUnits[sym] = targetUnits;
    tradedNotional += notional;
    totalCost += cost;
    trades.push({ symbol: sym, deltaUnits, price: p, cost });
  }

  const newState: HarvesterPaperState = { ...state, cash, units: newUnits, lastRebalanceDayMs: dayMs };
  const navAfter = markToMarket(newState, prices);

  // Seed buy-hold benchmark units on the first rebalance.
  if (newState.benchUnits === 0 && prices[benchSymbol]) {
    newState.benchUnits = state.initialCash / prices[benchSymbol]!;
  }

  const record: RebalanceRecord = {
    dayMs,
    navBefore,
    navAfter,
    totalCost,
    turnover: navBefore > 0 ? tradedNotional / navBefore : 0,
    targetWeights: target,
    trades,
  };
  newState.rebalanceLog = [...state.rebalanceLog, record];
  newState.navHistory = [
    ...state.navHistory,
    { dayMs, nav: navAfter, benchPrice: prices[benchSymbol] ?? state.navHistory.at(-1)?.benchPrice ?? 0 },
  ];
  return { state: newState, record };
}

/** Current portfolio weights (by market value) for reporting. */
export function currentWeights(state: HarvesterPaperState, prices: Record<string, number>): Record<string, number> {
  const nav = markToMarket(state, prices);
  const out: Record<string, number> = {};
  if (nav <= 0) return out;
  for (const [sym, u] of Object.entries(state.units)) {
    const p = prices[sym];
    if (p !== undefined && u !== 0) out[sym] = (u * p) / nav;
  }
  return out;
}

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

export function loadState(): HarvesterPaperState | null {
  if (!existsSync(FILE)) return null;
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as HarvesterPaperState;
  } catch {
    return null;
  }
}

export function saveState(state: HarvesterPaperState): void {
  ensureDir();
  writeFileSync(FILE, JSON.stringify(state, null, 2));
}
