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
