/**
 * Paper portfolio state management for the Claude paper-trader.
 *
 * Stores everything in $CRYPTOTRADER_STATE_DIR/paper-portfolio.json.
 * Append-only history of trades + current open positions + cash balance.
 *
 * Position lifecycle:
 *   open → (optional scale-outs at TP1/TP2) → close at TP3/stop/horizon/discretion
 *
 * Sizing: each position is opened with `notionalUsd` (target $50 notional)
 * which is the FULL position size if held. Scale-outs reduce
 * `remainingFraction` (1.0 → 0.5 after TP1 → 0.2 after TP2 → 0.0).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.CRYPTOTRADER_STATE_DIR ?? join(homedir(), ".cryptotrader");
const FILE = join(STATE_DIR, "paper-portfolio.json");

export type ScaleOutReason = "tp1" | "tp2" | "tp3" | "stop" | "horizon" | "discretion";

export interface ScaleOut {
  ts: number;
  price: number;
  /** Fraction of original notional closed in this slice (0.0–1.0). */
  fraction: number;
  reason: ScaleOutReason;
  /** Realized R for this slice = (exitPrice - entryPrice) / (entryPrice - initialStop). */
  rMultiple: number;
  /** Realized PnL in USD on the leveraged paper position. */
  pnlUsd: number;
}

export interface PaperPosition {
  id: string;
  signalId: string;            // ties back to signal-log entry
  symbol: string;              // "ZEC_USDT" (MEXC) or "BTC-USDC" (Coinbase)
  asset: string;               // "ZEC"
  /** Exchange identifier. Missing = "mexc-futures" for back-compat. */
  exchange?: string;
  /** "futures" or "spot". Drives fee model + pnl math. Defaults to "futures". */
  mode?: "futures" | "spot";
  side: "LONG";
  openTs: number;
  entryPrice: number;
  /** Total notional at open (in USD/USDC). */
  notionalUsd: number;
  /** Leverage at open (default 20× for MEXC, 1× for spot). PnL = move% × notional × leverage. */
  leverage: number;
  /** Original SL price as suggested by trade plan. */
  initialStop: number;
  /** Stop after potential trailing (BE after TP1, TP1 after TP2). */
  currentStop: number;
  tp1Price: number;
  tp2Price: number;
  tp3Price: number;
  /** Fraction of original notional still open (1.0 → 0.0). */
  remainingFraction: number;
  scaleOuts: ScaleOut[];
  lastChecked: number;
}

export interface PaperTrade {
  id: string;
  signalId: string;
  symbol: string;
  asset: string;
  exchange?: string;
  mode?: "futures" | "spot";
  side: "LONG";
  openTs: number;
  closedTs: number;
  entryPrice: number;
  notionalUsd: number;
  leverage: number;
  /** Composite reason — what fully closed it ("tp3" / "stop" / "horizon" / "discretion"). */
  finalExitReason: ScaleOutReason;
  scaleOuts: ScaleOut[];
  /** Notional-weighted R-multiple across scale-outs. */
  totalRMultiple: number;
  /** Sum of pnlUsd across scale-outs (after fees on spot). */
  totalPnlUsd: number;
  /** Total fees deducted across all scale-outs (USD). 0 on legacy MEXC records. */
  totalFeesUsd?: number;
}

export interface PaperPortfolio {
  startedAt: number;
  initialCash: number;
  /** Cash + realized P&L (no unrealized). */
  cash: number;
  openPositions: PaperPosition[];
  closedTrades: PaperTrade[];
  /** Signal IDs we've already opened on (prevents double-fire). */
  alreadyTradedSignalIds: string[];
  /** Last daily summary date (YYYY-MM-DD UTC) so we don't double-send. */
  lastDailySummary: string | null;
}

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

export function createEmpty(initialCash = 1000): PaperPortfolio {
  return {
    startedAt: Date.now(),
    initialCash,
    cash: initialCash,
    openPositions: [],
    closedTrades: [],
    alreadyTradedSignalIds: [],
    lastDailySummary: null,
  };
}

export function loadPortfolio(): PaperPortfolio {
  if (!existsSync(FILE)) return createEmpty();
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as PaperPortfolio;
  } catch {
    return createEmpty();
  }
}

export function savePortfolio(p: PaperPortfolio): void {
  ensureDir();
  writeFileSync(FILE, JSON.stringify(p, null, 2));
}

/**
 * Compute realized PnL in USD for a leveraged paper position slice.
 * pnl = (exitPrice - entryPrice) / entryPrice × notional × leverage × fraction
 *
 * NOTE: this is GROSS pnl. Use `feesForSlice` to apportion round-trip fees
 * and subtract them for net realized P&L on spot exchanges.
 */
export function computeSlicePnl(entry: number, exit: number, notional: number, leverage: number, fraction: number): number {
  const movePct = (exit - entry) / entry;
  return movePct * notional * leverage * fraction;
}

/**
 * Round-trip fee on the closed fraction. Each side (open + close) charges
 * `takerFeePct%` of the dollar-notional traded on that side; close-side
 * notional is approximated by `entry × fraction × notional / entry = notional × fraction`.
 *
 * Spot Coinbase taker is typically 0.5%/side; MEXC futures is ~0.04%/side.
 * Pass 0 to ignore fees (e.g. backwards-compatible MEXC paper runs that
 * never modeled fees).
 */
export function feesForSlice(notional: number, fraction: number, takerFeePctPerSide: number): number {
  return (takerFeePctPerSide / 100) * notional * fraction * 2;
}

/**
 * Default per-side taker fee % per exchange.
 *
 * Coinbase Advanced Trade Intro 1 tier (<$10k 30-day volume, where this
 * tenant lives): 1.20% taker per side. Earlier 0.50% estimate was the
 * legacy Coinbase Pro schedule and understated real cost by ~2x.
 * Maker fee at the same tier is 0.60% — switching execution to post-only
 * limit orders is on the roadmap (sprint B).
 *
 * Source verified 2026-05-15:
 *   help.coinbase.com/.../advanced-trade-fees
 */
export function defaultTakerFeePct(exchange: string | undefined): number {
  if (exchange === "coinbase-spot") return 1.2;
  if (exchange === "mexc-futures") return 0.0; // legacy paper-trader didn't model fees
  return 0.0;
}

/** R = realized price move / initial price risk. Side-agnostic for LONG. */
export function computeR(entry: number, exit: number, initialStop: number): number {
  const risk = entry - initialStop;
  if (risk <= 0) return 0;
  return (exit - entry) / risk;
}

export const PAPER_PORTFOLIO_PATH = FILE;
