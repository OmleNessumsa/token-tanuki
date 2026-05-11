import { describe, expect, it } from "vitest";
import { mexcFuturesAdapter } from "../src/clients/mexc-adapter.js";
import type { ExchangeAdapter } from "../src/exchange.js";

describe("mexcFuturesAdapter", () => {
  // Compile-time check: assigning to ExchangeAdapter proves the adapter
  // satisfies the interface contract.
  const adapter: ExchangeAdapter = mexcFuturesAdapter;

  it("declares MEXC futures capabilities", () => {
    expect(adapter.id).toBe("mexc-futures");
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

  it("exposes futures-only funding method", () => {
    expect(typeof adapter.getFundingRate).toBe("function");
  });

  it("does not expose order methods (added in S4)", () => {
    expect(adapter.placeOrder).toBeUndefined();
    expect(adapter.cancelOrder).toBeUndefined();
    expect(adapter.getOpenOrders).toBeUndefined();
    expect(adapter.getBalances).toBeUndefined();
  });
});
