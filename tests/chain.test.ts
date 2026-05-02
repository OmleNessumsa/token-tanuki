import { describe, expect, it } from "vitest";
import { detectChain, normalizeAddress } from "../src/chain.js";

describe("detectChain", () => {
  it("recognizes ethereum addresses", () => {
    expect(detectChain("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe("ethereum");
    expect(detectChain("0x0000000000000000000000000000000000000000")).toBe("ethereum");
  });

  it("recognizes solana mints", () => {
    expect(detectChain("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("solana");
    expect(detectChain("So11111111111111111111111111111111111111112")).toBe("solana");
  });

  it("returns null for invalid addresses", () => {
    expect(detectChain("nope")).toBeNull();
    expect(detectChain("0xshort")).toBeNull();
    expect(detectChain("")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(detectChain("  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  ")).toBe("ethereum");
  });

  it("does not match base58 strings containing 0/O/I/l", () => {
    // Solana base58 excludes 0, O, I, l. A 32-char string with 0 should not match.
    expect(detectChain("0".repeat(32))).toBeNull();
  });
});

describe("normalizeAddress", () => {
  it("lowercases ethereum addresses", () => {
    expect(normalizeAddress("0xABCDEF0000000000000000000000000000001234", "ethereum")).toBe(
      "0xabcdef0000000000000000000000000000001234",
    );
  });

  it("preserves solana case", () => {
    const sol = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(normalizeAddress(sol, "solana")).toBe(sol);
  });
});
