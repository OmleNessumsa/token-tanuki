/**
 * Stop-distance sweep on the Coinbase 5-asset active universe.
 *
 * Pulls 1h candles, runs the in-repo backtest engine (composite ≥ threshold,
 * Stage 2 required, ATR stops, 7d horizon) for a range of stopAtrMult values,
 * and reports realized expectancy WITH and WITHOUT 1.2% taker round-trip fees.
 *
 * Goal: answer "are our 2×ATR stops too tight for the noise on this
 * timeframe?" with concrete numbers before adjusting trade-plan.ts.
 *
 * Run: npx tsx scripts/backtest-stops.ts
 *      npx tsx scripts/backtest-stops.ts --bars 2000 --threshold 50
 */

import pc from "picocolors";
import { getNativeCandles, type CoinbaseGranularity } from "../src/clients/coinbase.js";
import { runStrategyOnSeries, summarize, type BacktestConfig, type BacktestTrade } from "../src/analysis/backtest.js";

const ACTIVE_ASSETS = ["DOGE-USDC", "LINK-USDC", "ETH-USDC", "SOL-USDC", "ADA-USDC"];
const STOP_MULTIPLIERS = [1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
const FEE_PCT_ROUND_TRIP = 2.4; // Coinbase Intro 1 taker × 2 sides
const GRANULARITY: CoinbaseGranularity = "ONE_HOUR";
// 7d horizon in hours; live paper-trader uses HORIZON_DAYS=7.
const HORIZON_BARS = 7 * 24;
// Live scanner cooldown is 6h.
const COOLDOWN_BARS = 6;

interface ArgsT {
  bars: number;
  threshold: number;
  requireStage2: boolean;
}

function parseArgs(argv: readonly string[]): ArgsT {
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && i < argv.length - 1 ? (argv[i + 1] ?? def) : def;
  };
  return {
    bars: parseInt(get("--bars", "1000"), 10),
    threshold: parseInt(get("--threshold", "55"), 10),
    requireStage2: !argv.includes("--no-stage2"),
  };
}

/**
 * Fee in R-units = (round-trip fee % of notional) / (stop distance % of notional).
 * Worked example: 2.4% fee, 2% stop → 1.2R cost per trade. 2.4% fee, 4% stop → 0.6R.
 * Wider stops carry lower per-R fee drag — exactly the bias we want to expose.
 */
function feeInR(trade: BacktestTrade): number {
  const stopDistPct = ((trade.entryPrice - trade.stopPrice) / trade.entryPrice) * 100;
  if (stopDistPct <= 0) return 0;
  return FEE_PCT_ROUND_TRIP / stopDistPct;
}

function fmtR(r: number): string {
  const s = (r >= 0 ? "+" : "") + r.toFixed(2);
  return r > 0.05 ? pc.green(s) : r < -0.05 ? pc.red(s) : pc.dim(s);
}

function fmtPf(pf: number): string {
  if (!Number.isFinite(pf)) return pc.dim("  ∞");
  const s = pf.toFixed(2);
  return pf >= 1.5 ? pc.green(s) : pf >= 1.0 ? pc.yellow(s) : pc.red(s);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  process.stdout.write(
    pc.bold(`Stop-distance sweep — Coinbase 1h, ${args.bars} bars (~${(args.bars / 24).toFixed(0)}d), 5 active assets\n`),
  );
  process.stdout.write(
    pc.dim(
      `composite≥${args.threshold}  Stage2=${args.requireStage2}  horizon=${HORIZON_BARS}h(${HORIZON_BARS / 24}d)  cooldown=${COOLDOWN_BARS}h  fee=${FEE_PCT_ROUND_TRIP}% rt\n\n`,
    ),
  );

  process.stdout.write(pc.dim("[1/2] fetching 1h candles from Coinbase...\n"));
  const candleSets: Record<string, ReturnType<typeof getNativeCandles> extends Promise<infer T> ? T : never> = {};
  for (const sym of ACTIVE_ASSETS) {
    try {
      const c = await getNativeCandles(sym, GRANULARITY, args.bars);
      candleSets[sym] = c;
      process.stdout.write(pc.dim(`  ${sym.padEnd(12)} ${c.length} bars\n`));
    } catch (e) {
      process.stdout.write(pc.red(`  ${sym.padEnd(12)} fetch failed: ${e instanceof Error ? e.message : e}\n`));
    }
  }
  process.stdout.write("\n");

  process.stdout.write(pc.dim("[2/2] running stop-multiplier sweep...\n\n"));

  // Header
  const header = [
    "ATR×".padStart(5),
    "trades".padStart(7),
    "WR%".padStart(6),
    "avgR".padStart(7),
    "totR".padStart(8),
    "PF".padStart(6),
    "stopHit%".padStart(9),
    "horizon%".padStart(9),
    "feeR/tr".padStart(8),
    "totR (net fees)".padStart(16),
    "PF (net)".padStart(9),
  ];
  process.stdout.write(pc.bold(header.join("  ")) + "\n");
  process.stdout.write(pc.dim("─".repeat(120)) + "\n");

  for (const mult of STOP_MULTIPLIERS) {
    const config: BacktestConfig = {
      thresholdComposite: args.threshold,
      horizonBars: HORIZON_BARS,
      stopAtrMult: mult,
      warmupBars: 200,
      cooldownBars: COOLDOWN_BARS,
      requireBreakout: false,
      requireStage2: args.requireStage2,
      stage2SmaPeriod: 150,
    };

    const allTrades: BacktestTrade[] = [];
    for (const candles of Object.values(candleSets)) {
      allTrades.push(...runStrategyOnSeries(candles, config));
    }
    if (allTrades.length === 0) {
      process.stdout.write(pc.dim(`  ${mult.toFixed(2)}×  no trades\n`));
      continue;
    }
    const stats = summarize(allTrades);
    const stopHits = allTrades.filter((t) => t.exitReason === "stop").length;
    const horizonExits = allTrades.length - stopHits;
    const feeRs = allTrades.map((t) => feeInR(t));
    const avgFeeR = feeRs.reduce((a, b) => a + b, 0) / feeRs.length;
    const netRs = allTrades.map((t, i) => t.rMultiple - feeRs[i]!);
    const netTotalR = netRs.reduce((a, b) => a + b, 0);
    const netWins = netRs.filter((r) => r > 0).length;
    const netGrossWin = netRs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const netGrossLoss = Math.abs(netRs.filter((r) => r <= 0).reduce((a, b) => a + b, 0));
    const netPf = netGrossLoss > 0 ? netGrossWin / netGrossLoss : Number.POSITIVE_INFINITY;
    const grossWin = allTrades.filter((t) => t.rMultiple > 0).reduce((a, t) => a + t.rMultiple, 0);
    const grossLoss = Math.abs(allTrades.filter((t) => t.rMultiple <= 0).reduce((a, t) => a + t.rMultiple, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : Number.POSITIVE_INFINITY;

    const cells = [
      `${mult.toFixed(2)}×`.padStart(5),
      String(stats.trades).padStart(7),
      (stats.winRate * 100).toFixed(1).padStart(6),
      fmtR(stats.expectancy).padStart(16),                // padded for color codes
      fmtR(stats.totalR).padStart(16),
      fmtPf(pf).padStart(15),
      `${((stopHits / allTrades.length) * 100).toFixed(0)}%`.padStart(9),
      `${((horizonExits / allTrades.length) * 100).toFixed(0)}%`.padStart(9),
      avgFeeR.toFixed(2).padStart(8),
      fmtR(netTotalR).padStart(24),
      fmtPf(netPf).padStart(18),
      `net WR ${((netWins / allTrades.length) * 100).toFixed(0)}%`,
    ];
    process.stdout.write(cells.join("  ") + "\n");
  }

  process.stdout.write("\n");
  process.stdout.write(pc.dim(
    "Notes:\n" +
      "  • avgR/totR are GROSS (pre-fee). PF (net) and totR (net fees) apply 2.4% rt fee per trade.\n" +
      "  • 'feeR/tr' = average fee burden in R-units. Wider stops automatically lower this number.\n" +
      "  • This is a single-TF (1h) backtest using scoreChart. Live system fires on 5/15/1h/4h/1d alignment,\n" +
      "    so the absolute numbers won't match live; the direction-of-effect for stop multiplier should.\n",
  ));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
