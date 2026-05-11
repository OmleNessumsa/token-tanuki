/**
 * MEXC Futures private (signed) API client.
 * Read-only endpoints used: /position/open_positions and /account/assets.
 *
 * Signing: HMAC-SHA256(apiKey + timestamp + queryString-or-body, secret).
 * Headers: ApiKey, Request-Time, Signature, Content-Type.
 */

import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { fetchJson } from "../http.js";

const BASE = "https://contract.mexc.com";

export interface MexcPosition {
  positionId: number;
  symbol: string;            // e.g. "SOL_USDT"
  positionType: 1 | 2;       // 1 = LONG, 2 = SHORT
  openType: 1 | 2;           // 1 = isolated, 2 = cross
  state: number;
  holdVol: number;           // contracts held
  holdAvgPrice: number;      // entry price
  liquidatePrice: number;
  im: number;                // initial margin (USDT)
  oim: number;
  leverage: number;
  marginRatio: number;
  holdFee: number;           // funding paid (negative = paid out)
  realised: number;
  profitRatio: number;       // includes funding
  createTime: number;
  updateTime: number;
}

interface MexcSignedResp<T> { success: boolean; code: number; data: T; message?: string; }

function signedHeaders(queryStringOrBody = ""): Record<string, string> {
  const key = config.mexcApiKey;
  const secret = config.mexcApiSecret;
  if (!key || !secret) throw new Error("MEXC_API_KEY and MEXC_API_SECRET not set in env");
  const ts = String(Date.now());
  const signature = createHmac("sha256", secret).update(key + ts + queryStringOrBody).digest("hex");
  return {
    ApiKey: key,
    "Request-Time": ts,
    Signature: signature,
    "Content-Type": "application/json",
  };
}

export async function getOpenPositions(): Promise<MexcPosition[]> {
  const url = `${BASE}/api/v1/private/position/open_positions`;
  const resp = await fetchJson<MexcSignedResp<MexcPosition[]>>(url, { headers: signedHeaders() });
  if (!resp.success) throw new Error(`MEXC: ${resp.message ?? "private call failed"} (code ${resp.code})`);
  return resp.data;
}

export interface MexcAsset {
  currency: string;
  positionMargin: number;
  availableBalance: number;
  cashBalance: number;
  frozenBalance: number;
  equity: number;
  unrealized: number;
  bonus: number;
}

export async function getAccountAssets(): Promise<MexcAsset[]> {
  const url = `${BASE}/api/v1/private/account/assets`;
  const resp = await fetchJson<MexcSignedResp<MexcAsset[]>>(url, { headers: signedHeaders() });
  if (!resp.success) throw new Error(`MEXC: ${resp.message ?? "private call failed"} (code ${resp.code})`);
  return resp.data.filter((a) => a.equity > 0); // only show currencies with balance
}

/** USDT-equivalent equity (the account's effective tradable size). */
export async function getUsdtEquity(): Promise<number> {
  const assets = await getAccountAssets();
  const usdt = assets.find((a) => a.currency === "USDT");
  return usdt ? usdt.equity : 0;
}

/**
 * Stop-loss / take-profit "plan orders" pending on a futures position.
 * MEXC stores these separately from the position itself.
 */
export interface MexcStopOrder {
  symbol: string;
  side: number;            // 1=open long, 2=close short, 3=open short, 4=close long
  triggerPrice: number;
  triggerType: number;     // 1=more than/equal, 2=less than/equal
  state: number;           // 1=untriggered, 2=cancelled, 3=triggered, 4=invalid
  positionId: number;
  triggerOrderType: number; // 1=plan, 2=stop loss, 3=take profit, etc.
}

export async function getStopOrders(symbol?: string): Promise<MexcStopOrder[]> {
  const qs = `states=1${symbol ? `&symbol=${symbol}` : ""}&page_num=1&page_size=50`;
  const url = `${BASE}/api/v1/private/planorder/list/orders?${qs}`;
  try {
    const resp = await fetchJson<MexcSignedResp<{ resultList?: MexcStopOrder[] }>>(url, { headers: signedHeaders(qs) });
    return resp.success ? resp.data?.resultList ?? [] : [];
  } catch {
    return [];
  }
}

/** Check whether a position has a stop loss configured. */
export async function hasStopLoss(symbol: string, positionId: number): Promise<boolean> {
  const orders = await getStopOrders(symbol);
  return orders.some((o) =>
    o.positionId === positionId &&
    o.state === 1 && // untriggered
    // For LONG (close long = side 4): SL fires when price goes BELOW (triggerType 2)
    // For SHORT (close short = side 2): SL fires when price goes ABOVE (triggerType 1)
    (o.side === 4 || o.side === 2),
  );
}

/**
 * A closed (historical) futures position. `realised` is final PnL in USDT
 * (positive = win, negative = loss), already including funding fees.
 */
export interface MexcHistoryPosition {
  positionId: number;
  symbol: string;
  positionType: 1 | 2;       // 1 = LONG, 2 = SHORT
  openType: 1 | 2;           // 1 = isolated, 2 = cross
  state: number;             // 3 = closed
  holdVol: number;
  holdAvgPrice: number;      // entry
  closeAvgPrice: number;     // average exit price
  closeVol: number;
  openAvgPrice: number;
  liquidatePrice: number;
  oim: number;
  im: number;
  holdFee: number;
  realised: number;          // realized PnL in USDT
  leverage: number;
  createTime: number;
  updateTime: number;
}

/**
 * Paginated history of closed positions. MEXC caps page_size at 100.
 * Pass `pages` to fetch multiple pages (default 5 = up to 500 positions).
 */
export async function getHistoryPositions(opts: {
  symbol?: string;
  pageSize?: number;
  pages?: number;
} = {}): Promise<MexcHistoryPosition[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.pages ?? 5;
  const all: MexcHistoryPosition[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = `${opts.symbol ? `symbol=${opts.symbol}&` : ""}page_num=${page}&page_size=${pageSize}`;
    const url = `${BASE}/api/v1/private/position/list/history_positions?${qs}`;
    const resp = await fetchJson<MexcSignedResp<{ resultList?: MexcHistoryPosition[] } | MexcHistoryPosition[]>>(
      url,
      { headers: signedHeaders(qs) },
    );
    if (!resp.success) throw new Error(`MEXC: ${resp.message ?? "history call failed"} (code ${resp.code})`);
    const list = Array.isArray(resp.data) ? resp.data : resp.data?.resultList ?? [];
    if (list.length === 0) break;
    all.push(...list);
    if (list.length < pageSize) break;
  }
  return all;
}
