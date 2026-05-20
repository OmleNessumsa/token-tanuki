import { describe, expect, it } from "vitest";
import { signRequest } from "../src/clients/blofin-private.js";

/**
 * Pinned fixture: fixed timestamp + nonce + secret produce a deterministic
 * ACCESS-SIGN value. The expected sign was hand-computed via Node crypto:
 *
 *   prehash = "/api/v1/asset/balances?accountType=futuresGET" + ts + nonce + body
 *   hex     = HMAC-SHA256(prehash, secret).digest("hex")
 *   sign    = base64(utf8Bytes(hex))   ← THE QUIRK
 *
 * Regression target: catches accidental base64-of-raw-bytes (the "obvious"
 * implementation), which would yield a 32-byte→44-char base64 instead of
 * the 64-hex-char→88-char base64 used by Blofin.
 */
const FIXED_TS = "1700000000000";
const FIXED_NONCE = "00000000-0000-0000-0000-000000000000";
const SECRET = "test-secret";
const KEY = "test-key";
const PASSPHRASE = "test-pass";

describe("signRequest", () => {
  it("produces the pinned ACCESS-SIGN value for a fixed fixture (regression for double-base64 quirk)", () => {
    const headers = signRequest("GET", "/api/v1/asset/balances?accountType=futures", "", {
      timestamp: FIXED_TS,
      nonce: FIXED_NONCE,
      secret: SECRET,
      key: KEY,
      passphrase: PASSPHRASE,
    });
    // The sign is base64(utf8(hex)) — 88 chars including padding.
    expect(headers["ACCESS-SIGN"]).toBe(
      "NjUxMTBhM2MzMjkyZWYyNTgyYWU1ZmFiOWIyODI4ZjI0YzVkYmIzODdmMWE4ODBlOTY1MDYxMTRiZWQ1OTk5YQ==",
    );
  });

  it("ACCESS-SIGN length matches base64-of-64-hex-chars (88 with padding)", () => {
    const headers = signRequest("GET", "/api/v1/asset/balances?accountType=futures", "", {
      timestamp: FIXED_TS,
      nonce: FIXED_NONCE,
      secret: SECRET,
      key: KEY,
      passphrase: PASSPHRASE,
    });
    expect(headers["ACCESS-SIGN"]).toHaveLength(88);
    // Catches regression where someone changed to base64(rawBytes) (44 chars).
    expect(headers["ACCESS-SIGN"]).not.toHaveLength(44);
  });

  it("includes the query string in prehash (different query yields different sign)", () => {
    const a = signRequest("GET", "/api/v1/asset/balances?accountType=futures", "", {
      timestamp: FIXED_TS, nonce: FIXED_NONCE, secret: SECRET, key: KEY, passphrase: PASSPHRASE,
    });
    const b = signRequest("GET", "/api/v1/asset/balances?accountType=spot", "", {
      timestamp: FIXED_TS, nonce: FIXED_NONCE, secret: SECRET, key: KEY, passphrase: PASSPHRASE,
    });
    expect(a["ACCESS-SIGN"]).not.toBe(b["ACCESS-SIGN"]);
  });

  it("treats empty body as literal \"\" (not \"null\" or \"{}\")", () => {
    const withEmpty = signRequest("GET", "/api/v1/asset/balances?accountType=futures", "", {
      timestamp: FIXED_TS, nonce: FIXED_NONCE, secret: SECRET, key: KEY, passphrase: PASSPHRASE,
    });
    const withNullStr = signRequest("GET", "/api/v1/asset/balances?accountType=futures", "null", {
      timestamp: FIXED_TS, nonce: FIXED_NONCE, secret: SECRET, key: KEY, passphrase: PASSPHRASE,
    });
    // If empty were silently coerced to "null", these would match.
    expect(withEmpty["ACCESS-SIGN"]).not.toBe(withNullStr["ACCESS-SIGN"]);
  });

  it("method case matters — GET vs get yield different sign", () => {
    // Sanity: we explicitly type method as uppercase, but if someone bypasses
    // TS and lowercases, the sign would change. This pins the convention.
    const upper = signRequest("GET", "/x", "", {
      timestamp: FIXED_TS, nonce: FIXED_NONCE, secret: SECRET, key: KEY, passphrase: PASSPHRASE,
    });
    // Bypass TS to test lower case
    const lower = signRequest("get" as "GET", "/x", "", {
      timestamp: FIXED_TS, nonce: FIXED_NONCE, secret: SECRET, key: KEY, passphrase: PASSPHRASE,
    });
    expect(upper["ACCESS-SIGN"]).not.toBe(lower["ACCESS-SIGN"]);
  });

  it("propagates all five required headers verbatim", () => {
    const headers = signRequest("GET", "/api/v1/asset/balances?accountType=futures", "", {
      timestamp: FIXED_TS, nonce: FIXED_NONCE, secret: SECRET, key: KEY, passphrase: PASSPHRASE,
    });
    expect(headers["ACCESS-KEY"]).toBe(KEY);
    expect(headers["ACCESS-TIMESTAMP"]).toBe(FIXED_TS);
    expect(headers["ACCESS-NONCE"]).toBe(FIXED_NONCE);
    expect(headers["ACCESS-PASSPHRASE"]).toBe(PASSPHRASE);
  });

  it("POST body affects the sign (different body → different sign)", () => {
    const body1 = JSON.stringify({ instId: "BTC-USDT", side: "buy", size: "0.1" });
    const body2 = JSON.stringify({ instId: "BTC-USDT", side: "buy", size: "0.2" });
    const a = signRequest("POST", "/api/v1/trade/order", body1, {
      timestamp: FIXED_TS, nonce: FIXED_NONCE, secret: SECRET, key: KEY, passphrase: PASSPHRASE,
    });
    const b = signRequest("POST", "/api/v1/trade/order", body2, {
      timestamp: FIXED_TS, nonce: FIXED_NONCE, secret: SECRET, key: KEY, passphrase: PASSPHRASE,
    });
    expect(a["ACCESS-SIGN"]).not.toBe(b["ACCESS-SIGN"]);
  });
});
