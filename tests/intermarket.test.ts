import { describe, expect, it } from "vitest";
import { classifyRegime } from "../src/analysis/intermarket.js";

describe("classifyRegime", () => {
  it("flags btc_dump on >5% drop in 24h", () => {
    expect(classifyRegime(-7, -10)).toBe("btc_dump");
    expect(classifyRegime(-5.1, 0)).toBe("btc_dump");
  });

  it("flags altseason when BTC ran hard past week then stabilizes", () => {
    expect(classifyRegime(0.5, 12)).toBe("altseason");
    expect(classifyRegime(-0.5, 10)).toBe("altseason");
  });

  it("flags btc_dominance_rising on moderate BTC down", () => {
    expect(classifyRegime(-3, 0)).toBe("btc_dominance_rising");
  });

  it("returns neutral otherwise", () => {
    expect(classifyRegime(0, 2)).toBe("neutral");
    expect(classifyRegime(3, 5)).toBe("neutral");
  });

  it("dump rule beats altseason rule when both could fire", () => {
    expect(classifyRegime(-6, 12)).toBe("btc_dump");
  });
});
