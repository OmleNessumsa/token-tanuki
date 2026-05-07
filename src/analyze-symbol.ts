/**
 * Analyze a CEX-listed asset by symbol (e.g. "BTC", "XRP", "BNB", "ADA").
 *
 * Uses MEXC public market data instead of DexScreener/GeckoTerminal/security APIs.
 * Skips on-chain security checks (these are L1 native coins or major listings —
 * no contract to audit, no honeypot risk).
 *
 * Verdict applies the same chart-driven logic as the DEX path for established
 * assets, plus Murphy intermarket. No phase classifier (these aren't memecoins).
 */

import { getKlines, get24hTicker, findCanonicalPair, type MexcTicker24h } from "./clients/mexc.js";
import { scoreChart, type ChartScore } from "./analysis/chart.js";
import { getIntermarketContext, type IntermarketContext } from "./analysis/intermarket.js";
import type { FullVerdict } from "./analysis/verdict.js";
import type { Candle } from "./analysis/indicators.js";

export interface SymbolAnalysisResult {
  asset: string;
  pair: string | null;
  ticker: MexcTicker24h | null;
  chart: ChartScore;
  intermarket: IntermarketContext;
  verdict: FullVerdict;
  candles: { h1: Candle[]; d1: Candle[] };
}

export async function analyzeSymbol(asset: string): Promise<SymbolAnalysisResult> {
  const upper = asset.toUpperCase();
  const pair = await findCanonicalPair(upper);
  const intermarket = await getIntermarketContext();

  if (!pair) {
    return {
      asset: upper,
      pair: null,
      ticker: null,
      chart: emptyChart(),
      intermarket,
      verdict: { verdict: "AVOID", composite: 0, reasons: [`No MEXC trading pair found for ${upper}`], caveats: [] },
      candles: { h1: [], d1: [] },
    };
  }

  // Fetch 1d × 500 (~16 months) and 1h × 500 (~21 days) in parallel, plus ticker
  const [h1, d1, ticker] = await Promise.all([
    getKlines(pair, "60m", 500),
    getKlines(pair, "1d", 500),
    get24hTicker(pair),
  ]);

  const chart = scoreChart(d1, h1);
  const verdict = composeSymbolVerdict(chart, intermarket, ticker, pair);

  return { asset: upper, pair, ticker, chart, intermarket, verdict, candles: { h1, d1 } };
}

/**
 * Verdict for a CEX symbol — established asset, chart-driven.
 * Mirrors the established-token path in src/analysis/verdict.ts.
 */
function composeSymbolVerdict(
  chart: ChartScore,
  intermarket: IntermarketContext,
  ticker: MexcTicker24h | null,
  pair: string,
): FullVerdict {
  const reasons: string[] = [];
  const caveats: string[] = [];

  // BTC dump regime → blanket AVOID for alts
  if (intermarket.regime === "btc_dump" && pair !== "BTCUSDT" && pair !== "BTCUSDC") {
    reasons.push(`Intermarket: ${intermarket.description}`);
    return { verdict: "AVOID", composite: Math.round(chart.score * 0.4), reasons, caveats };
  }

  // Determine direction — same logic as established-asset path
  const rsi = chart.rsi ?? 50;
  let direction: "bullish" | "bearish" | "neutral";
  if (chart.rsiDivergence === "bullish") direction = "bullish";
  else if (chart.rsiDivergence === "bearish") direction = "bearish";
  else if (chart.trend === "up" && rsi < 75) direction = "bullish";
  else if (chart.trend === "up") direction = "neutral"; // overbought in uptrend
  else if (chart.trend === "down" && rsi <= 32) direction = "bullish"; // oversold dip
  else if (chart.trend === "down") direction = "bearish";
  else if (rsi < 35) direction = "bullish";
  else if (rsi > 70) direction = "bearish";
  else direction = "neutral";

  let composite = chart.score;
  if (intermarket.altLongMultiplier !== 1.0 && pair !== "BTCUSDT" && pair !== "BTCUSDC") {
    composite = Math.round(composite * intermarket.altLongMultiplier);
    reasons.push(`Intermarket: ${intermarket.description} (×${intermarket.altLongMultiplier.toFixed(2)})`);
  }
  composite = Math.min(100, composite);

  reasons.push(`Pair: ${pair}`);
  reasons.push(`Chart ${chart.score}/100 — trend ${chart.trend}${chart.rsi !== null ? `, RSI ${chart.rsi.toFixed(0)}` : ""}`);
  reasons.push(`Direction: ${direction}`);
  if (ticker) {
    reasons.push(`24h: ${parseFloat(ticker.priceChangePercent).toFixed(2)}% · vol $${formatUsd(parseFloat(ticker.quoteVolume))}`);
  }
  if (chart.recentBullishPatterns.length > 0) reasons.push(`Bullish patterns: ${chart.recentBullishPatterns.join(", ")}`);
  if (chart.recentBearishPatterns.length > 0) reasons.push(`Bearish patterns: ${chart.recentBearishPatterns.join(", ")}`);
  if (chart.rsiDivergence) reasons.push(`RSI ${chart.rsiDivergence} divergence`);

  let verdict: FullVerdict["verdict"];
  if (direction === "bullish") verdict = "BUY";
  else if (direction === "bearish") verdict = "AVOID";
  else if (chart.score < 35) verdict = "AVOID";
  else verdict = "WAIT";

  return { verdict, composite, reasons, caveats };
}

function formatUsd(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

function emptyChart(): ChartScore {
  return {
    score: 0,
    trend: "flat",
    rsi: null,
    rsiDivergence: null,
    recentBullishPatterns: [],
    recentBearishPatterns: [],
    chartPatterns: [],
    breakout: null,
    setups: [],
    volumeConfirmation: false,
    stage2: null,
    notes: [],
  };
}
