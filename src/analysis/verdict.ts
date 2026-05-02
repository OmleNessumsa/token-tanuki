import type { SecurityReport } from "./security.js";
import type { ChartScore } from "./chart.js";
import type { PhaseResult } from "./lifecycle.js";
import type { DexScreenerPair } from "../schemas.js";

export type Verdict = "BUY" | "WAIT" | "AVOID";

export interface FullVerdict {
  verdict: Verdict;
  composite: number; // 0-100
  reasons: string[];
  caveats: string[];
}

export function composeVerdict(
  security: SecurityReport,
  phase: PhaseResult,
  chart: ChartScore,
  pair: DexScreenerPair | null,
): FullVerdict {
  const reasons: string[] = [];
  const caveats: string[] = [];

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
  if (liquidityUsd < 30_000) {
    caveats.push(`Liquidity $${liquidityUsd.toFixed(0)} < $30k — chart patterns are low confidence`);
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

  const liquidityScore = Math.min(100, (liquidityUsd / 200_000) * 100);
  const phaseScore = phase.buyability === "buy" ? 80 : 50;
  const composite = Math.round(
    security.score * 0.40 +
    phaseScore * 0.20 +
    chart.score * 0.25 +
    liquidityScore * 0.15
  );

  reasons.push(`Security ${security.score}/100`);
  reasons.push(`Phase ${phase.phase} (${phase.buyability}) — ${phase.reason}`);
  reasons.push(`Chart ${chart.score}/100 — trend ${chart.trend}${chart.rsi !== null ? `, RSI ${chart.rsi.toFixed(0)}` : ""}`);
  reasons.push(`Liquidity $${formatUsd(liquidityUsd)}`);
  if (chart.recentBullishPatterns.length > 0) reasons.push(`Bullish patterns: ${chart.recentBullishPatterns.join(", ")}`);
  if (chart.recentBearishPatterns.length > 0) reasons.push(`Bearish patterns: ${chart.recentBearishPatterns.join(", ")}`);
  if (chart.rsiDivergence) reasons.push(`RSI ${chart.rsiDivergence} divergence`);

  for (const f of security.findings) {
    if (f.level === "warn") caveats.push(`[${f.source}] ${f.message}`);
  }

  let verdict: Verdict;
  if (composite >= 70 && phase.buyability === "buy" && security.score >= 70) verdict = "BUY";
  else if (composite >= 50) verdict = "WAIT";
  else verdict = "AVOID";

  return { verdict, composite, reasons, caveats };
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}
