import { detectChain, NETWORK_SLUGS, type Chain } from "./chain.js";
import { getPairs, pickCanonicalPair, searchByAddress } from "./clients/dexscreener.js";
import { getOhlcv } from "./clients/geckoterminal.js";
import { getEvmTokenSecurity, getSolanaTokenSecurity } from "./clients/goplus.js";
import { isHoneypot } from "./clients/honeypot.js";
import { getReport as getRugcheckReport } from "./clients/rugcheck.js";
import type { DexScreenerPair } from "./schemas.js";
import { evaluateSecurity, type SecurityReport } from "./analysis/security.js";
import { classifyPhase, type PhaseResult } from "./analysis/lifecycle.js";
import { scoreChart, type ChartScore } from "./analysis/chart.js";
import { composeVerdict, type FullVerdict } from "./analysis/verdict.js";
import { toCandles, type Candle } from "./analysis/indicators.js";

export interface AnalysisResult {
  address: string;
  chain: Chain;
  pair: DexScreenerPair | null;
  security: SecurityReport;
  phase: PhaseResult;
  chart: ChartScore;
  verdict: FullVerdict;
  candles: { m1: Candle[]; m5: Candle[]; h1: Candle[]; d1: Candle[] };
}

export async function analyzeToken(address: string): Promise<AnalysisResult> {
  const chain = await resolveChain(address);
  const pairs = await getPairs(chain, address);
  const pair = pickCanonicalPair(pairs, address);

  if (!pair) {
    return {
      address,
      chain,
      pair: null,
      security: { findings: [], fatals: [], buyTax: null, sellTax: null, topHolderPct: null, lpLockedOrBurned: null, honeypot: false, score: 0 },
      phase: { phase: "unknown", ageHours: null, ddFromAth: 0, buyability: "avoid", reason: "no pair found" },
      chart: { score: 0, trend: "flat", rsi: null, rsiDivergence: null, recentBullishPatterns: [], recentBearishPatterns: [], chartPatterns: [], volumeConfirmation: false, notes: ["no chart data"] },
      verdict: { verdict: "AVOID", composite: 0, reasons: ["No DEX pair found for address"], caveats: [] },
      candles: { m1: [], m5: [], h1: [], d1: [] },
    };
  }

  const pairAgeHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : null;
  const poolAddress = pair.pairAddress;

  // Security calls: parallel against different services.
  const securityPromise = chain === "ethereum"
    ? Promise.all([
        getEvmTokenSecurity(NETWORK_SLUGS.goplusEvmChainId.ethereum, address),
        isHoneypot(address, "ethereum"),
      ] as const)
    : Promise.all([
        getSolanaTokenSecurity(address),
        getRugcheckReport(address),
      ] as const);

  // OHLCV: sequenced — GeckoTerminal free tier is ~30 req/min and parallel calls 429.
  const ohlcvPromise = (async () => {
    const m1 = await getOhlcv({ chain, poolAddress, timeframe: "minute", aggregate: 1, limit: 200 });
    const m5 = await getOhlcv({ chain, poolAddress, timeframe: "minute", aggregate: 5, limit: 200 });
    const h1 = await getOhlcv({ chain, poolAddress, timeframe: "hour", aggregate: 1, limit: 200 });
    const d1 = await getOhlcv({ chain, poolAddress, timeframe: "day", aggregate: 1, limit: 200 });
    return [m1, m5, h1, d1] as const;
  })();

  const [[m1Raw, m5Raw, h1Raw, d1Raw], [secA, secB]] = await Promise.all([ohlcvPromise, securityPromise]);

  const candles = {
    m1: toCandles(m1Raw),
    m5: toCandles(m5Raw),
    h1: toCandles(h1Raw),
    d1: toCandles(d1Raw),
  };

  const isV3Pair = !!pair.labels?.some((l) => l.toLowerCase().includes("v3")) || pair.dexId.toLowerCase().includes("v3");
  const security = chain === "ethereum"
    ? evaluateSecurity(chain, {
        goplusEvm: secA as Awaited<ReturnType<typeof getEvmTokenSecurity>>,
        honeypot: secB as Awaited<ReturnType<typeof isHoneypot>>,
        pairAgeHours,
        pairLiquidityUsd: pair.liquidity?.usd ?? null,
        isV3Pair,
      })
    : evaluateSecurity(chain, {
        goplusSolana: secA as Awaited<ReturnType<typeof getSolanaTokenSecurity>>,
        rugcheck: secB as Awaited<ReturnType<typeof getRugcheckReport>>,
      });

  const phase = classifyPhase(candles.m1, candles.m5, pair.pairCreatedAt ?? null);
  const chart = scoreChart(candles.d1, candles.h1.length > 0 ? candles.h1 : candles.m5);
  const verdict = composeVerdict(security, phase, chart, pair);

  return { address, chain, pair, security, phase, chart, verdict, candles };
}

async function resolveChain(address: string): Promise<Chain> {
  const direct = detectChain(address);
  if (direct) return direct;
  const search = await searchByAddress(address);
  const first = search[0];
  if (first?.chainId === "ethereum" || first?.chainId === "solana") return first.chainId;
  throw new Error(`Could not detect chain for address: ${address}`);
}
