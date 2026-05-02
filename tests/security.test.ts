import { describe, expect, it } from "vitest";
import { evaluateEvmSecurity, evaluateSolanaSecurity } from "../src/analysis/security.js";

describe("evaluateEvmSecurity — disqualifiers", () => {
  it("flags honeypot from honeypot.is", () => {
    const r = evaluateEvmSecurity(null, {
      honeypotResult: { isHoneypot: true, honeypotReason: "sell reverted" },
    } as any, 1);
    expect(r.honeypot).toBe(true);
    expect(r.fatals.some((f) => f.message.includes("Honeypot"))).toBe(true);
    expect(r.score).toBe(0);
  });

  it("flags >15% sell tax as fatal", () => {
    const r = evaluateEvmSecurity(null, { simulationResult: { sellTax: 25 } } as any, 1);
    expect(r.fatals.length).toBeGreaterThan(0);
    expect(r.score).toBe(0);
  });

  it("flags hidden owner from goplus", () => {
    const r = evaluateEvmSecurity({ hidden_owner: "1" } as any, null, 1);
    expect(r.fatals.some((f) => f.message.toLowerCase().includes("hidden owner"))).toBe(true);
  });

  it("flags unverified contract older than 24h", () => {
    const r = evaluateEvmSecurity({ is_open_source: "0" } as any, null, 48);
    expect(r.fatals.some((f) => f.message.includes("not verified"))).toBe(true);
  });

  it("does not flag unverified for very fresh tokens", () => {
    const r = evaluateEvmSecurity({ is_open_source: "0" } as any, null, 0.5);
    expect(r.fatals.some((f) => f.message.includes("not verified"))).toBe(false);
  });

  it("flags top wallet > 30%", () => {
    const r = evaluateEvmSecurity({ holders: [{ address: "0xabc", percent: "0.45" }] } as any, null, 5);
    expect(r.fatals.some((f) => f.message.includes("Top non-LP holder"))).toBe(true);
  });

  it("excludes locker tagged holders from concentration math", () => {
    const r = evaluateEvmSecurity({ holders: [{ address: "0xabc", percent: "0.5", tag: "Unicrypt Locker" }, { address: "0xdef", percent: "0.05" }] } as any, null, 5);
    expect(r.fatals.some((f) => f.message.includes("Top non-LP"))).toBe(false);
  });

  it("scores 100 with no findings", () => {
    const r = evaluateEvmSecurity(null, null, 5);
    expect(r.score).toBe(100);
  });
});

describe("evaluateSolanaSecurity — disqualifiers", () => {
  it("flags active mint authority as fatal", () => {
    const r = evaluateSolanaSecurity({ mintable: { authority: "SomeWalletAddr" } } as any, null);
    expect(r.fatals.some((f) => f.message.toLowerCase().includes("mint authority"))).toBe(true);
    expect(r.score).toBe(0);
  });

  it("flags active freeze authority as fatal", () => {
    const r = evaluateSolanaSecurity({ freezable: { authority: "FreezerWallet" } } as any, null);
    expect(r.fatals.some((f) => f.message.toLowerCase().includes("freeze authority"))).toBe(true);
  });

  it("flags rugcheck danger-level risks", () => {
    const r = evaluateSolanaSecurity(null, { risks: [{ name: "Bundled launch", level: "danger", description: "" }] } as any);
    expect(r.fatals.some((f) => f.message.includes("Bundled launch"))).toBe(true);
  });

  it("flags insider cluster > 40%", () => {
    const r = evaluateSolanaSecurity(null, {
      topHolders: [
        { address: "a", pct: 30, insider: true },
        { address: "b", pct: 25, insider: true },
      ],
    } as any);
    expect(r.fatals.some((f) => f.message.includes("Insider cluster"))).toBe(true);
  });

  it("flags rugged tokens", () => {
    const r = evaluateSolanaSecurity(null, { rugged: true } as any);
    expect(r.fatals.some((f) => f.message.includes("rugged"))).toBe(true);
  });

  it("counts good signals when authorities renounced", () => {
    const r = evaluateSolanaSecurity(
      { mintable: { authority: null }, freezable: { authority: null } } as any,
      { lpLockedPct: 100 } as any,
    );
    expect(r.findings.some((f) => f.level === "good")).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(100);
  });
});
