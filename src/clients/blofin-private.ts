/**
 * Blofin Open API — authenticated (private) client.
 *
 * Auth scheme: HMAC-SHA256 with a tricky double-encoding step.
 *
 *   ACCESS-SIGN = base64( utf8Bytes( hex( HMAC_SHA256(prehash, secret) ) ) )
 *
 * Note carefully: the HEX-STRING of the digest is base64-encoded, NOT the
 * raw digest bytes. This is unusual (most HMAC APIs base64 the raw bytes)
 * and is the most common source of integration bugs against Blofin.
 *
 * The prehash string concatenates: `${path}${method}${ms_ts}${nonce}${body}`
 * where:
 *  - path includes query string for GET requests
 *  - method is uppercase (GET/POST/DELETE)
 *  - ms_ts is unix milliseconds as a string
 *  - nonce is a UUID
 *  - body is the request JSON for POST, empty string "" for GET
 *
 * Reference: docs.blofin.com/index.html → "Authentication".
 */

import { createHmac, randomUUID } from "node:crypto";
import "../config.js";
import { fetchJson } from "../http.js";

const BASE_URL = "https://openapi.blofin.com";

export type HttpMethod = "GET" | "POST" | "DELETE";

/**
 * The five required headers, typed loosely as a string-record so fetchJson
 * (which expects Record<string, string>) accepts the value without a cast.
 * Callers can still index by the five well-known keys.
 */
export type SignedHeaders = Record<
  "ACCESS-KEY" | "ACCESS-SIGN" | "ACCESS-TIMESTAMP" | "ACCESS-NONCE" | "ACCESS-PASSPHRASE",
  string
> & Record<string, string>;

function readCredentials(): { key: string; secret: string; passphrase: string } {
  const key = process.env.BLOFIN_API_KEY ?? "";
  const secret = process.env.BLOFIN_API_SECRET ?? "";
  const passphrase = process.env.BLOFIN_API_PASSPHRASE ?? "";
  if (!key || !secret || !passphrase) {
    throw new Error(
      "Missing Blofin credentials: set BLOFIN_API_KEY, BLOFIN_API_SECRET, and BLOFIN_API_PASSPHRASE in .env",
    );
  }
  return { key, secret, passphrase };
}

/**
 * Build Blofin auth headers for a single request. Exported as a pure
 * function so unit tests can assert exact signatures against fixed
 * timestamp+nonce inputs.
 */
export function signRequest(
  method: HttpMethod,
  path: string,
  body: string = "",
  opts: { timestamp?: string; nonce?: string; secret?: string; key?: string; passphrase?: string } = {},
): SignedHeaders {
  const creds = opts.secret && opts.key && opts.passphrase
    ? { key: opts.key, secret: opts.secret, passphrase: opts.passphrase }
    : readCredentials();
  const timestamp = opts.timestamp ?? Date.now().toString();
  const nonce = opts.nonce ?? randomUUID();
  const prehash = `${path}${method}${timestamp}${nonce}${body}`;
  // Step 1: HMAC-SHA256 → hex digest (lowercase, 64 chars).
  const hexDigest = createHmac("sha256", creds.secret).update(prehash).digest("hex");
  // Step 2: base64-encode the HEX STRING (not the raw digest bytes).
  const sign = Buffer.from(hexDigest, "utf8").toString("base64");
  return {
    "ACCESS-KEY": creds.key,
    "ACCESS-SIGN": sign,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-NONCE": nonce,
    "ACCESS-PASSPHRASE": creds.passphrase,
  };
}

async function authedGet<T>(path: string): Promise<T> {
  const headers = signRequest("GET", path);
  return fetchJson<T>(`${BASE_URL}${path}`, { headers });
}

// --- Balances ---

export interface BlofinBalanceRow {
  currency: string;
  balance: string;       // total
  available: string;     // freely usable
  frozen: string;        // locked in orders/positions
}

export interface BlofinBalanceWrapper {
  ts: string;
  totalEquity?: string;
  isolatedEquity?: string;
  details: BlofinBalanceRow[];
}

interface BalancesEnvelope {
  code: string;
  msg: string;
  data: BlofinBalanceWrapper[] | BlofinBalanceRow[];
}

/**
 * Pull futures balances. Blofin returns either a wrapper object containing
 * a `details` array (newer schema) or a flat array of balance rows (older
 * docs example) — normalize to the flat list so callers don't care.
 */
export async function getBalances(accountType: "futures" = "futures"): Promise<BlofinBalanceRow[]> {
  const path = `/api/v1/asset/balances?accountType=${accountType}`;
  const env = await fetchJson<BalancesEnvelope>(`${BASE_URL}${path}`, {
    headers: signRequest("GET", path),
  });
  if (env.code !== "0") {
    throw new Error(`Blofin getBalances failed: code=${env.code} msg=${env.msg}`);
  }
  const data = env.data;
  if (!Array.isArray(data) || data.length === 0) return [];
  // Heuristic: if the first row has a `details` array, it's wrapper-shape.
  const first = data[0] as BlofinBalanceWrapper | BlofinBalanceRow;
  if ("details" in first && Array.isArray((first as BlofinBalanceWrapper).details)) {
    return (data as BlofinBalanceWrapper[]).flatMap((w) => w.details ?? []);
  }
  return data as BlofinBalanceRow[];
}

export { authedGet as _authedGetForTests };
