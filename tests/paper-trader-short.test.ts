import { describe, expect, it } from "vitest";
import { triggered } from "../scripts/paper-trader.js";

describe("triggered (LONG)", () => {
  it("stop fires when price drops to or below stop", () => {
    expect(triggered(95,  95,  "LONG", "stop")).toBe(true);
    expect(triggered(94,  95,  "LONG", "stop")).toBe(true);
    expect(triggered(96,  95,  "LONG", "stop")).toBe(false);
  });

  it("tp fires when price rises to or above tp", () => {
    expect(triggered(110, 110, "LONG", "tp")).toBe(true);
    expect(triggered(111, 110, "LONG", "tp")).toBe(true);
    expect(triggered(109, 110, "LONG", "tp")).toBe(false);
  });
});

describe("triggered (SHORT)", () => {
  it("stop fires when price rises to or above stop (stop is ABOVE entry on SHORT)", () => {
    expect(triggered(105, 105, "SHORT", "stop")).toBe(true);
    expect(triggered(106, 105, "SHORT", "stop")).toBe(true);
    expect(triggered(104, 105, "SHORT", "stop")).toBe(false);
  });

  it("tp fires when price falls to or below tp (tp is BELOW entry on SHORT)", () => {
    expect(triggered(90,  90,  "SHORT", "tp")).toBe(true);
    expect(triggered(89,  90,  "SHORT", "tp")).toBe(true);
    expect(triggered(91,  90,  "SHORT", "tp")).toBe(false);
  });

  it("never matches the LONG-direction trigger", () => {
    // If we passed a SHORT into LONG-style logic, a price below entry would
    // mistakenly fire the stop. Side-aware check refuses.
    expect(triggered(90, 105, "SHORT", "stop")).toBe(false);
  });
});

describe("regression: LONG stops aren't triggered by SHORT-style moves", () => {
  it("a LONG with stop 95 is NOT stopped at 110", () => {
    expect(triggered(110, 95, "LONG", "stop")).toBe(false);
  });
});
