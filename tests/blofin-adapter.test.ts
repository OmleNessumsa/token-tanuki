import { describe, expect, it } from "vitest";
import { blofinFuturesAdapter } from "../src/clients/blofin-adapter.js";
import type { ExchangeAdapter } from "../src/exchange.js";
import {
  BLOFIN_ACTIVE_ASSETS,
  BLOFIN_TOP30_ASSETS,
  BLOFIN_TOP30_PERP,
} from "../src/whitelist.js";

describe("blofinFuturesAdapter", () => {
  // Compile-time check: assigning to ExchangeAdapter proves the adapter
  // satisfies the interface contract.
  const adapter: ExchangeAdapter = blofinFuturesAdapter;

  it("declares Blofin futures capabilities", () => {
    expect(adapter.id).toBe("blofin-futures");
    expect(adapter.kind).toBe("futures");
    expect(adapter.supportsShort).toBe(true);
    expect(adapter.supportsLeverage).toBe(true);
  });

  it("exposes all required market-data methods", () => {
    expect(typeof adapter.getKlines).toBe("function");
    expect(typeof adapter.getTicker).toBe("function");
    expect(typeof adapter.symbolExists).toBe("function");
    expect(typeof adapter.findCanonicalSymbol).toBe("function");
  });

  it("exposes futures-only funding method (drives funding-regime analysis)", () => {
    expect(typeof adapter.getFundingRate).toBe("function");
  });

  it("exposes getBalances (S2)", () => {
    expect(typeof adapter.getBalances).toBe("function");
  });

  it("does not expose order methods yet (added in S5 behind safety rails)", () => {
    expect(adapter.placeOrder).toBeUndefined();
    expect(adapter.cancelOrder).toBeUndefined();
    expect(adapter.getOpenOrders).toBeUndefined();
  });
});

describe("Blofin whitelist", () => {
  it("has exactly 30 perp pairs", () => {
    expect(BLOFIN_TOP30_PERP).toHaveLength(30);
  });

  it("has matching asset/pair arrays", () => {
    expect(BLOFIN_TOP30_ASSETS).toHaveLength(BLOFIN_TOP30_PERP.length);
  });

  it("every pair quotes in USDT (universal Blofin perp quote)", () => {
    for (const sym of BLOFIN_TOP30_PERP) {
      expect(sym).toMatch(/-USDT$/);
    }
  });

  it("active assets are a subset of top-30 assets", () => {
    for (const a of BLOFIN_ACTIVE_ASSETS) {
      expect(BLOFIN_TOP30_ASSETS).toContain(a);
    }
  });

  it("uses POL (not MATIC) — Polygon rebrand", () => {
    expect(BLOFIN_TOP30_ASSETS).toContain("POL");
    expect(BLOFIN_TOP30_ASSETS).not.toContain("MATIC");
  });

  it("preserves the original top-10 majors as a prefix", () => {
    const majors = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT", "POL"];
    for (const m of majors) {
      expect(BLOFIN_TOP30_ASSETS).toContain(m);
    }
  });
});
