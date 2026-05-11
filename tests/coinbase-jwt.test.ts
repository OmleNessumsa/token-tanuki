import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { signJwt, _resetKeyCache } from "../src/clients/coinbase-private.js";

/** Decode a base64url segment of a JWT to a JSON object. */
function decodePart<T = unknown>(part: string): T {
  const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
  const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
  return JSON.parse(json) as T;
}

describe("signJwt (Coinbase ES256)", () => {
  beforeAll(() => {
    // Generate a throwaway P-256 key for the test. Export as PEM with the
    // same `\n` literal-escape convention used in .env.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    process.env.COINBASE_API_KEY_NAME = "organizations/test-org/apiKeys/test-key";
    process.env.COINBASE_API_PRIVATE_KEY = pem.replace(/\n/g, "\\n");
    _resetKeyCache();
  });

  it("produces a three-part JWT", () => {
    const jwt = signJwt("GET", "/api/v3/brokerage/accounts");
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("header has ES256 + JWT + kid + nonce", () => {
    const [headerB64] = signJwt("GET", "/api/v3/brokerage/accounts").split(".");
    const header = decodePart<Record<string, string>>(headerB64!);
    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe(process.env.COINBASE_API_KEY_NAME);
    expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("payload has correct claims (sub/iss/nbf/exp/uri)", () => {
    const now = Math.floor(Date.now() / 1000);
    const [, payloadB64] = signJwt("GET", "/api/v3/brokerage/accounts").split(".");
    const p = decodePart<Record<string, unknown>>(payloadB64!);
    expect(p.sub).toBe(process.env.COINBASE_API_KEY_NAME);
    expect(p.iss).toBe("cdp");
    expect(typeof p.nbf).toBe("number");
    expect(typeof p.exp).toBe("number");
    expect((p.exp as number) - (p.nbf as number)).toBe(120);
    expect(Math.abs((p.nbf as number) - now)).toBeLessThan(5);
    expect(p.uri).toBe("GET api.coinbase.com/api/v3/brokerage/accounts");
  });

  it("strips query string from uri claim (regression for 401 bug)", () => {
    const [, payloadB64] = signJwt("GET", "/api/v3/brokerage/accounts?limit=250&cursor=abc").split(".");
    const p = decodePart<{ uri: string }>(payloadB64!);
    expect(p.uri).toBe("GET api.coinbase.com/api/v3/brokerage/accounts");
  });

  it("signature is 64 bytes (IEEE P1363, not DER)", () => {
    const [, , sigB64] = signJwt("GET", "/api/v3/brokerage/accounts").split(".");
    const padded = sigB64! + "=".repeat((4 - (sigB64!.length % 4)) % 4);
    const sig = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(sig.length).toBe(64);
  });

  it("uses different nonce per call", () => {
    const a = signJwt("GET", "/x").split(".")[0];
    const b = signJwt("GET", "/x").split(".")[0];
    const headerA = decodePart<{ nonce: string }>(a!);
    const headerB = decodePart<{ nonce: string }>(b!);
    expect(headerA.nonce).not.toBe(headerB.nonce);
  });
});
