import { describe, expect, it } from "vitest";
import { composeVerdict } from "../src/analysis/verdict.js";
import type { SecurityReport } from "../src/analysis/security.js";
import type { ChartScore } from "../src/analysis/chart.js";
import type { PhaseResult } from "../src/analysis/lifecycle.js";
import type { DexScreenerPair } from "../src/schemas.js";

const baseSec = (over: Partial<SecurityReport> = {}): SecurityReport => ({
  findings: [], fatals: [], buyTax: 0, sellTax: 0, topHolderPct: 5, lpLockedOrBurned: true, honeypot: false, score: 80, ...over,
});
const basePhase = (over: Partial<PhaseResult> = {}): PhaseResult => ({
  phase: "accumulation", ageHours: 24, ddFromAth: 0.3, buyability: "buy", reason: "test", ...over,
});
const baseChart = (over: Partial<ChartScore> = {}): ChartScore => ({
  score: 75, trend: "up", rsi: 55, rsiDivergence: null, recentBullishPatterns: [], recentBearishPatterns: [], volumeConfirmation: true, notes: [], ...over,
});
const basePair = (liqUsd: number): DexScreenerPair => ({
  chainId: "ethereum", dexId: "uniswap", pairAddress: "0xpair",
  baseToken: { address: "0xtoken", name: "Test", symbol: "TEST" },
  quoteToken: { address: "0xweth", name: "WETH", symbol: "WETH" },
  liquidity: { usd: liqUsd },
} as DexScreenerPair);

describe("composeVerdict", () => {
  it("AVOID immediately on any fatal security finding", () => {
    const v = composeVerdict(
      baseSec({ fatals: [{ level: "fatal", source: "test", message: "honeypot" }], score: 0 }),
      basePhase(), baseChart(), basePair(500_000),
    );
    expect(v.verdict).toBe("AVOID");
    expect(v.composite).toBe(0);
  });

  it("AVOID when liquidity < $10k", () => {
    const v = composeVerdict(baseSec(), basePhase(), baseChart(), basePair(5_000));
    expect(v.verdict).toBe("AVOID");
  });

  it("AVOID when phase says avoid (parabolic, distribution, dead)", () => {
    const v = composeVerdict(baseSec(), basePhase({ buyability: "avoid", reason: "parabolic" }), baseChart(), basePair(500_000));
    expect(v.verdict).toBe("AVOID");
  });

  it("BUY when everything aligns: high security, accumulation phase, healthy chart, real liquidity", () => {
    const v = composeVerdict(baseSec({ score: 90 }), basePhase(), baseChart({ score: 80 }), basePair(500_000));
    expect(v.verdict).toBe("BUY");
    expect(v.composite).toBeGreaterThanOrEqual(70);
  });

  it("WAIT when phase is wait (initial pump)", () => {
    const v = composeVerdict(baseSec(), basePhase({ buyability: "wait", phase: "initialPump" }), baseChart(), basePair(500_000));
    expect(v.verdict).toBe("WAIT");
  });

  it("WAIT when liquidity is between 10k and 30k", () => {
    const v = composeVerdict(baseSec(), basePhase(), baseChart(), basePair(15_000));
    expect(v.caveats.some((c) => c.includes("low confidence"))).toBe(true);
  });

  it("includes warn-level findings as caveats", () => {
    const v = composeVerdict(
      baseSec({ findings: [{ level: "warn", source: "goplus", message: "metadata mutable" }] }),
      basePhase(), baseChart(), basePair(500_000),
    );
    expect(v.caveats.some((c) => c.includes("metadata mutable"))).toBe(true);
  });
});
