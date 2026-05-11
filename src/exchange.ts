/**
 * ExchangeAdapter — exchange-agnostic interface for the cryptotrader pipeline.
 *
 * The analysis engine (src/analysis/*) is exchange-independent. This interface
 * isolates exchange-specific I/O so MEXC futures, Coinbase spot, and any future
 * exchange can plug in without touching the indicator/pattern/scoring code.
 *
 * Spot adapters return `undefined` for futures-only fields and omit optional
 * futures methods (funding, OI). Account/order methods are optional until S4.
 */

import type { Candle } from "./analysis/indicators.js";

export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "8h" | "1d" | "1w";

/**
 * Normalized ticker. Fields after `timestamp` are futures-specific and
 * undefined on spot exchanges.
 */
export interface Ticker {
  symbol: string;
  lastPrice: number;
  bid: number;
  ask: number;
  volume24Quote: number;
  high24: number;
  low24: number;
  /** 24h % change as a fraction (0.012 = +1.2%). */
  riseFallRate: number;
  timestamp: number;

  // Futures-only — undefined on spot
  openInterest?: number;
  fundingRate?: number;
  indexPrice?: number;
  fairPrice?: number;
}

export interface FundingInfo {
  symbol: string;
  ratePerCycle: number;
  cycleHours: number;
  nextSettleTime: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";

export interface PlaceOrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  /** Base-asset quantity. Use `quoteQuantity` instead for spot market-buy by quote amount. */
  quantity?: number;
  quoteQuantity?: number;
  /** Required for LIMIT orders. */
  price?: number;
  /** Idempotency key. Adapters must forward to exchange-native idempotency. */
  clientOrderId?: string;
}

export interface OrderResult {
  exchangeOrderId: string;
  clientOrderId?: string;
  status: "submitted" | "filled" | "rejected" | "cancelled" | "partial";
  filledQuantity?: number;
  averagePrice?: number;
}

export interface ExchangeAdapter {
  /** Stable identifier for logging/routing (e.g. "mexc-futures", "coinbase-spot"). */
  readonly id: string;
  readonly kind: "futures" | "spot";
  readonly supportsShort: boolean;
  readonly supportsLeverage: boolean;

  // --- Market data (required) ---
  getKlines(symbol: string, tf: Timeframe, limit?: number): Promise<Candle[]>;
  getTicker(symbol: string): Promise<Ticker | null>;
  symbolExists(symbol: string): Promise<boolean>;
  /** Resolve a common ticker (e.g. "BTC") to the adapter's canonical symbol (e.g. "BTC_USDT", "BTC-USD"). */
  findCanonicalSymbol(asset: string): Promise<string | null>;

  // --- Futures-only (omit on spot) ---
  getFundingRate?(symbol: string): Promise<FundingInfo | null>;

  // --- Account / orders (optional — required in S4 for executing adapters) ---
  getBalances?(): Promise<Balance[]>;
  placeOrder?(req: PlaceOrderRequest): Promise<OrderResult>;
  cancelOrder?(symbol: string, exchangeOrderId: string): Promise<void>;
  getOpenOrders?(symbol?: string): Promise<OrderResult[]>;
}

export type { Candle };
