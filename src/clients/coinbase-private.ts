/**
 * Coinbase Advanced Trade — authenticated (private) client.
 *
 * Uses CDP-issued ECDSA API keys with ES256 JWT signing. Tokens are
 * single-request bearer tokens with a 2-minute TTL and a uri claim that
 * binds the token to one METHOD + path. Sign per request.
 *
 * Reference: https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication
 * Format ground-truth: github.com/coinbase/coinbase-advanced-py jwt_generator.py
 */

import { createPrivateKey, createSign, randomBytes, type KeyObject } from "node:crypto";
import "../config.js";
import { fetchJson } from "../http.js";

const API_HOST = "api.coinbase.com";
const BASE_URL = `https://${API_HOST}`;

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

let cachedKey: KeyObject | null = null;

function loadPrivateKey(): KeyObject {
  if (cachedKey) return cachedKey;
  const raw = process.env.COINBASE_API_PRIVATE_KEY ?? "";
  if (!raw) throw new Error("COINBASE_API_PRIVATE_KEY not set");
  // .env stores the PEM with literal \n escapes — restore actual newlines
  const pem = raw.replace(/\\n/g, "\n");
  cachedKey = createPrivateKey(pem);
  return cachedKey;
}

/**
 * Build a single-request ES256 JWT for Coinbase Advanced Trade. The `uri`
 * claim binds the token to one METHOD + endpoint path; reusing for another
 * request will yield 401. Tokens expire in 120s.
 */
export function signJwt(method: "GET" | "POST" | "DELETE", path: string): string {
  const keyName = process.env.COINBASE_API_KEY_NAME ?? "";
  if (!keyName) throw new Error("COINBASE_API_KEY_NAME not set");

  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: keyName,
    nonce: randomBytes(16).toString("hex"),
  };
  // Coinbase verifies the JWT uri claim against the path WITHOUT query string.
  // Including the query string yields 401. Strip everything after `?`.
  const qIndex = path.indexOf("?");
  const pathForJwt = qIndex >= 0 ? path.slice(0, qIndex) : path;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: keyName,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uri: `${method} ${API_HOST}${pathForJwt}`,
  };

  const headerB64 = base64Url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64Url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = createSign("SHA256");
  signer.update(signingInput);
  // JWT spec requires IEEE P1363 (raw r||s) encoding for ECDSA. Node defaults
  // to DER, which yields 401 from Coinbase.
  const sig = signer.sign({ key: loadPrivateKey(), dsaEncoding: "ieee-p1363" });

  return `${signingInput}.${base64Url(sig)}`;
}

async function authedGet<T>(path: string): Promise<T> {
  const jwt = signJwt("GET", path);
  return fetchJson<T>(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

export interface CoinbaseAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: { value: string; currency: string };
  hold: { value: string; currency: string };
  default: boolean;
  active: boolean;
  type: string;
  ready: boolean;
}

interface AccountsResp {
  accounts: CoinbaseAccount[];
  has_next: boolean;
  cursor: string;
  size: number;
}

export async function getAccounts(): Promise<CoinbaseAccount[]> {
  const out: CoinbaseAccount[] = [];
  let cursor = "";
  // Coinbase paginates accounts. Walk the cursor until exhausted.
  for (let safety = 0; safety < 10; safety++) {
    const path = `/api/v3/brokerage/accounts?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const resp = await authedGet<AccountsResp>(path);
    out.push(...(resp.accounts ?? []));
    if (!resp.has_next || !resp.cursor) break;
    cursor = resp.cursor;
  }
  return out;
}

/** Test-only: reset the cached private key (for test re-init after env changes). */
export function _resetKeyCache(): void {
  cachedKey = null;
}
