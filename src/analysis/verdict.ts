import type { SecurityReport } from "./security.js";
import type { ChartScore } from "./chart.js";
import type { PhaseResult } from "./lifecycle.js";
import type { DexScreenerPair } from "../schemas.js";
import type { IntermarketContext } from "./intermarket.js";

export type Verdict = "BUY" | "WAIT" | "AVOID";

export interface FullVerdict {
  verdict: Verdict;
  composite: number; // 0-100
  reasons: string[];
  caveats: string[];
}

const ESTABLISHED_AGE_HOURS = 30 * 24;
const ESTABLISHED_LIQ_USD = 500_000;
const ESTABLISHED_SECURITY = 75;

export function composeVerdict(
  security: SecurityReport,
  phase: PhaseResult,
  chart: ChartScore,
  pair: DexScreenerPair | null,
  intermarket?: IntermarketContext,
): FullVerdict {
  const reasons: string[] = [];
  const caveats: string[] = [];

  // Stage 1: Hard rejects.
  if (security.fatals.length > 0) {
    return {
      verdict: "AVOID",
      composite: 0,
      reasons: security.fatals.map((f) => `[${f.source}] ${f.message}`),
      caveats: [],
    };
  }

  const liquidityUsd = pair?.liquidity?.usd ?? 0;
  if (liquidityUsd < 10_000) {
    return {
      verdict: "AVOID",
      composite: 0,
      reasons: [`Liquidity $${liquidityUsd.toFixed(0)} < $10k — untradeable, exit liquidity for snipers`],
      caveats: [],
    };
  }
  if (phase.buyability === "avoid") {
    reasons.push(`Phase ${phase.phase}: ${phase.reason}`);
    return {
      verdict: "AVOID",
      composite: Math.round(security.score * 0.3 + chart.score * 0.2),
      reasons,
      caveats,
    };
  }

  // Murphy intermarket: BTC dump → no alt longs regardless of token-level setup
  if (intermarket && intermarket.regime === "btc_dump") {
    reasons.push(`Intermarket: ${intermarket.description}`);
    return {
      verdict: "AVOID",
      composite: Math.round(security.score * 0.3 + chart.score * 0.2),
      reasons,
      caveats,
    };
  }

  // Stage 2: Classify the token. Established tokens get chart-driven verdicts;
  // memecoin-lifecycle tokens stay phase-driven.
  const ageHours = pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
  const isEstablished =
    ageHours > ESTABLISHED_AGE_HOURS &&
    liquidityUsd > ESTABLISHED_LIQ_USD &&
    security.score >= ESTABLISHED_SECURITY;

  // Stage 3: Directional bias from chart.
  const direction = readDirection(chart);

  // Stage 4: Compose composite score (used for confidence display, not gating).
  const liquidityScore = Math.min(100, (liquidityUsd / 200_000) * 100);
  const phaseScore = phase.buyability === "buy" ? 80 : 50;
  let composite = Math.round(
    security.score * 0.40 +
    phaseScore * 0.20 +
    chart.score * 0.25 +
    liquidityScore * 0.15
  );

  // Apply Murphy intermarket multiplier (1.0 = neutral, 0.7 = headwind, 1.3 = altseason tailwind)
  if (intermarket && intermarket.regime !== "unknown" && intermarket.altLongMultiplier !== 1.0) {
    const adjusted = Math.round(composite * intermarket.altLongMultiplier);
    if (adjusted !== composite) {
      reasons.push(`Intermarket: ${intermarket.description} (×${intermarket.altLongMultiplier.toFixed(2)})`);
      composite = Math.min(100, adjusted);
    }
  }

  reasons.push(`Security ${security.score}/100`);
  if (isEstablished) reasons.push(`Established asset (age ${(ageHours / 24).toFixed(0)}d, liq $${formatUsd(liquidityUsd)}) — chart-driven verdict`);
  else reasons.push(`Phase ${phase.phase} (${phase.buyability}) — ${phase.reason}`);
  reasons.push(`Chart ${chart.score}/100 — trend ${chart.trend}${chart.rsi !== null ? `, RSI ${chart.rsi.toFixed(0)}` : ""}`);
  reasons.push(`Direction: ${direction}`);
  reasons.push(`Liquidity $${formatUsd(liquidityUsd)}`);
  if (chart.recentBullishPatterns.length > 0) reasons.push(`Bullish patterns: ${chart.recentBullishPatterns.join(", ")}`);
  if (chart.recentBearishPatterns.length > 0) reasons.push(`Bearish patterns: ${chart.recentBearishPatterns.join(", ")}`);
  if (chart.rsiDivergence) reasons.push(`RSI ${chart.rsiDivergence} divergence`);

  for (const f of security.findings) {
    if (f.level === "warn") caveats.push(`[${f.source}] ${f.message}`);
  }

  // Stage 5: Decide.
  let verdict: Verdict;
  if (isEstablished) {
    verdict = decideEstablished(direction, security.score, chart, composite);
  } else {
    verdict = decideMemecoin(phase, direction, security.score, composite);
  }

  return { verdict, composite, reasons, caveats };
}

type Direction = "bullish" | "bearish" | "neutral";

function readDirection(chart: ChartScore): Direction {
  const rsi = chart.rsi ?? 50;
  // Confirmed breakout with volume overrides everything else — that's a tactical bullish signal
  // independent of trend (Connors, O'Neil, Minervini common framework).
  if (chart.breakout?.state === "broken_out" && chart.breakout.volumeConfirmed) return "bullish";
  if (chart.breakout?.state === "below_breakdown" && chart.breakout.volumeConfirmed) return "bearish";
  if (chart.rsiDivergence === "bullish") return "bullish";
  if (chart.rsiDivergence === "bearish") return "bearish";
  if (chart.trend === "up" && rsi < 75) return "bullish";
  if (chart.trend === "up" && rsi >= 75) return "neutral"; // overbought in uptrend = chase risk
  if (chart.trend === "down" && rsi <= 32) return "bullish"; // oversold dip-buy candidate
  if (chart.trend === "down") return "bearish";
  // flat trend
  if (rsi < 35) return "bullish";
  if (rsi > 70) return "bearish";
  return "neutral";
}

function decideEstablished(direction: Direction, secScore: number, chart: ChartScore, _composite: number): Verdict {
  // Mature blue-chips: trust the chart + security. Phase classifier doesn't apply.
  // Only BUY when there's an actual bullish read — being "safe and flat" is a WAIT, not a BUY.
  if (direction === "bullish" && secScore >= 80) return "BUY";
  if (direction === "bearish") return "AVOID";
  if (chart.score < 35) return "AVOID";
  return "WAIT";
}

function decideMemecoin(phase: PhaseResult, direction: Direction, secScore: number, composite: number): Verdict {
  // Memecoin lifecycle: phase governs.
  if (phase.buyability === "buy" && secScore >= 70 && direction !== "bearish") return "BUY";
  if (phase.buyability === "wait") {
    // Allow upgrade to BUY if everything else lines up while waiting (e.g., initial pump with bullish divergence)
    if (composite >= 70 && secScore >= 80 && direction === "bullish") return "BUY";
    return "WAIT";
  }
  // Phase unknown for a memecoin → use composite + direction to commit
  if (composite >= 60 && direction === "bullish" && secScore >= 80) return "BUY";
  if (composite < 40 || direction === "bearish") return "AVOID";
  return "WAIT";
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}
