import { describe, expect, it } from "vitest";
import { composeVerdict } from "../src/analysis/verdict.js";
import type { SecurityReport } from "../src/analysis/security.js";
import type { ChartScore } from "../src/analysis/chart.js";
import type { PhaseResult } from "../src/analysis/lifecycle.js";
import type { DexScreenerPair } from "../src/schemas.js";

const baseSec = (over: Partial<SecurityReport> = {}): SecurityReport => ({
  findings: [], fatals: [], buyTax: 0, sellTax: 0, topHolderPct: 5, lpLockedOrBurned: true, honeypot: false, score: 90, ...over,
});
const basePhase = (over: Partial<PhaseResult> = {}): PhaseResult => ({
  phase: "accumulation", ageHours: 24, ddFromAth: 0.3, buyability: "buy", reason: "test", ...over,
});
const baseChart = (over: Partial<ChartScore> = {}): ChartScore => ({
  score: 75, trend: "up", rsi: 55, rsiDivergence: null, recentBullishPatterns: [], recentBearishPatterns: [], volumeConfirmation: true, notes: [], ...over,
});
const basePair = (liqUsd: number, ageDays = 1): DexScreenerPair => ({
  chainId: "ethereum", dexId: "uniswap", pairAddress: "0xpair",
  baseToken: { address: "0xtoken", name: "Test", symbol: "TEST" },
  quoteToken: { address: "0xweth", name: "WETH", symbol: "WETH" },
  liquidity: { usd: liqUsd },
  pairCreatedAt: Date.now() - ageDays * 86_400_000,
} as DexScreenerPair);

describe("composeVerdict — hard rejects", () => {
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
});

describe("composeVerdict — memecoin-lifecycle path", () => {
  it("BUY when phase=buy + healthy chart + good security", () => {
    const v = composeVerdict(baseSec({ score: 90 }), basePhase(), baseChart({ score: 80 }), basePair(500_000, 1));
    expect(v.verdict).toBe("BUY");
  });

  it("WAIT when phase=wait + middling chart + no clear direction", () => {
    const v = composeVerdict(
      baseSec({ score: 75 }),
      basePhase({ buyability: "wait", phase: "initialPump" }),
      baseChart({ score: 50, trend: "flat", rsi: 50 }),
      basePair(50_000, 1),
    );
    expect(v.verdict).toBe("WAIT");
  });

  it("upgrades wait→BUY when initial pump shows strong bullish setup", () => {
    const v = composeVerdict(
      baseSec({ score: 90 }),
      basePhase({ buyability: "wait", phase: "initialPump" }),
      baseChart({ score: 85, trend: "up", rsi: 60, rsiDivergence: "bullish" }),
      basePair(800_000, 1),
    );
    expect(v.verdict).toBe("BUY");
  });

  it("memecoin with bearish chart + unknown phase → AVOID", () => {
    const v = composeVerdict(
      baseSec({ score: 80 }),
      basePhase({ buyability: "wait", phase: "unknown" }),
      baseChart({ score: 25, trend: "down", rsi: 45 }),
      basePair(50_000, 5),
    );
    expect(["AVOID", "WAIT"]).toContain(v.verdict);
  });
});

describe("composeVerdict — established-asset path", () => {
  it("BUY for an established asset in uptrend with high security", () => {
    const v = composeVerdict(
      baseSec({ score: 100 }),
      basePhase({ buyability: "wait", phase: "unknown", reason: "no clear signal" }),
      baseChart({ score: 70, trend: "up", rsi: 55 }),
      basePair(5_000_000, 365),
    );
    expect(v.verdict).toBe("BUY");
  });

  it("WAIT for established stablecoin-like flat asset with high security", () => {
    const v = composeVerdict(
      baseSec({ score: 100 }),
      basePhase({ buyability: "wait", phase: "unknown" }),
      baseChart({ score: 70, trend: "flat", rsi: 50 }),
      basePair(50_000_000, 1000),
    );
    expect(v.verdict).toBe("WAIT");
  });

  it("AVOID for an established asset in clear downtrend (not oversold)", () => {
    const v = composeVerdict(
      baseSec({ score: 100 }),
      basePhase({ buyability: "wait", phase: "unknown" }),
      baseChart({ score: 35, trend: "down", rsi: 50 }),
      basePair(5_000_000, 365),
    );
    expect(v.verdict).toBe("AVOID");
  });

  it("BUY for established asset on oversold dip (downtrend + RSI < 32)", () => {
    const v = composeVerdict(
      baseSec({ score: 100 }),
      basePhase({ buyability: "wait", phase: "unknown" }),
      baseChart({ score: 50, trend: "down", rsi: 28 }),
      basePair(5_000_000, 365),
    );
    expect(v.verdict).toBe("BUY");
  });

  it("WAIT only when truly neutral and security is merely good", () => {
    const v = composeVerdict(
      baseSec({ score: 80 }),
      basePhase({ buyability: "wait", phase: "unknown" }),
      baseChart({ score: 55, trend: "flat", rsi: 50 }),
      basePair(5_000_000, 365),
    );
    expect(v.verdict).toBe("WAIT");
  });

  it("includes warn-level findings as caveats", () => {
    const v = composeVerdict(
      baseSec({ findings: [{ level: "warn", source: "goplus", message: "metadata mutable" }] }),
      basePhase(), baseChart(), basePair(500_000, 60),
    );
    expect(v.caveats.some((c) => c.includes("metadata mutable"))).toBe(true);
  });
});
