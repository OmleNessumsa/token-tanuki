/**
 * Aronson-style backtest of cryptotrader's composite-≥75 LONG signal.
 *
 * Pulls 1d klines for the top-30 MEXC perps, runs scoreChart at each historical
 * bar, simulates trades with ATR-based stops + N-day horizon, and computes
 * realized expectancy.
 *
 * Then: block-shuffles each perp's series and re-runs to build a null
 * distribution → p-value.
 *
 * Usage:
 *   npx tsx scripts/backtest.ts --threshold 75 --horizon 7 --perms 200 --top 30
 */
import { fetchJson } from "../src/http.js";
import { getFuturesKlines } from "../src/clients/mexc-futures.js";
import type { Candle } from "../src/analysis/indicators.js";
import { runStrategyOnSeries, summarize, permutationTest, type BacktestConfig, type BacktestStats } from "../src/analysis/backtest.js";
import { sendTelegram } from "../src/clients/telegram.js";

interface MexcTicker { symbol: string; amount24: number; }

function parseArgs(argv: readonly string[]): { threshold: number; horizon: number; perms: number; top: number; cooldown: number; sendTg: boolean; requireBreakout: boolean; requireStage2: boolean } {
  const args: Record<string, string | true> = {};
  const flagOnlyKeys = new Set(["send-telegram", "require-breakout", "require-stage2"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--") && !flagOnlyKeys.has(key)) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return {
    threshold: typeof args.threshold === "string" ? parseInt(args.threshold) : 75,
    horizon: typeof args.horizon === "string" ? parseInt(args.horizon) : 7,
    perms: typeof args.perms === "string" ? parseInt(args.perms) : 200,
    top: typeof args.top === "string" ? parseInt(args.top) : 30,
    cooldown: typeof args.cooldown === "string" ? parseInt(args.cooldown) : 5,
    sendTg: args["send-telegram"] === true,
    requireBreakout: args["require-breakout"] === true,
    requireStage2: args["require-stage2"] === true,
  };
}

const SKIP_KEYWORDS = ["XAUT", "SILVER", "GOLD", "PAXG", "USDC", "DAI", "USDT_USD"];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(`Aronson backtest: threshold=${args.threshold} horizon=${args.horizon}d perms=${args.perms}\n`);

  process.stderr.write("[1/3] fetching ticker list...\n");
  const tickers = await fetchJson<{ data: MexcTicker[] }>("https://contract.mexc.com/api/v1/contract/ticker");
  const top = tickers.data
    .filter((t) => t.symbol.endsWith("_USDT"))
    .filter((t) => !SKIP_KEYWORDS.some((k) => t.symbol.includes(k)))
    .filter((t) => t.amount24 > 0)
    .sort((a, b) => b.amount24 - a.amount24)
    .slice(0, args.top);
  process.stderr.write(`  selected ${top.length} perps\n`);

  process.stderr.write("[2/3] pulling 1d klines (up to 500 bars per perp ≈ 16 months)...\n");
  const candleSets: Record<string, Candle[]> = {};
  for (let i = 0; i < top.length; i++) {
    const t = top[i]!;
    const candles = await getFuturesKlines(t.symbol, "Day1", 500);
    if (candles.length >= 250) {
      candleSets[t.symbol] = candles;
      process.stderr.write(`  ${t.symbol.padEnd(18)} ${candles.length} bars\n`);
    } else {
      process.stderr.write(`  ${t.symbol.padEnd(18)} skip (only ${candles.length} bars)\n`);
    }
  }
  process.stderr.write(`  total perps with sufficient data: ${Object.keys(candleSets).length}\n\n`);

  const config: BacktestConfig = {
    thresholdComposite: args.threshold,
    horizonBars: args.horizon,
    stopAtrMult: 2,
    warmupBars: 200,
    cooldownBars: args.cooldown,
    requireBreakout: args.requireBreakout,
    requireStage2: args.requireStage2,
  };
  const tags: string[] = [];
  if (args.requireBreakout) tags.push("BREAKOUT");
  if (args.requireStage2) tags.push("STAGE2");
  const variantLabel = tags.length === 0 ? "BASELINE" : tags.join("+");
  const filterDesc = tags.length === 0 ? "composite ≥X only" : `composite ≥X AND ${tags.map((t) => t === "BREAKOUT" ? "Donchian breakout" : "price > 30W SMA").join(" AND ")}`;
  process.stderr.write(`Variant: ${variantLabel} (${filterDesc})\n`);

  process.stderr.write("[3/3] running strategy on real data + " + args.perms + " permutations...\n");
  const startTs = Date.now();
  const result = permutationTest(candleSets, config, args.perms, 5, 42);
  const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(0);
  process.stderr.write(`  done in ${elapsedSec}s\n\n`);

  // Per-symbol breakdown for transparency
  const perSymbol: Array<{ symbol: string; stats: BacktestStats }> = [];
  for (const [sym, candles] of Object.entries(candleSets)) {
    const trades = runStrategyOnSeries(candles, config);
    perSymbol.push({ symbol: sym, stats: summarize(trades) });
  }

  // Output
  const r = result.realStats;
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ARONSON BACKTEST [" + variantLabel + "] — composite ≥" + args.threshold + " LONG, " + args.horizon + "-bar hold, 2×ATR stop");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`Trades:            ${r.trades}`);
  console.log(`Win rate:          ${(r.winRate * 100).toFixed(1)}%   (${r.wins}W / ${r.losses}L)`);
  console.log(`Avg winner:        +${r.avgWinR.toFixed(2)}R`);
  console.log(`Avg loser:         ${r.avgLossR.toFixed(2)}R`);
  console.log(`Payoff ratio:      ${r.avgLossR < 0 ? Math.abs(r.avgWinR / r.avgLossR).toFixed(2) : "Inf"}`);
  console.log(`Expectancy:        ${r.expectancy.toFixed(3)}R per trade`);
  console.log(`Total R:           ${r.totalR.toFixed(1)}R`);
  console.log(`Max drawdown:      ${r.maxDrawdownR.toFixed(1)}R`);
  console.log("");
  console.log(`Permutation test (${args.perms} shuffles, block size 5):`);
  console.log(`  Real total R:     ${r.totalR.toFixed(1)}`);
  console.log(`  Mean (shuffled):  ${result.meanPermuted.toFixed(1)}`);
  console.log(`  Std (shuffled):   ${result.stdPermuted.toFixed(1)}`);
  console.log(`  p-value:          ${result.pValue.toFixed(4)}`);
  console.log(`  Significant?      ${result.significant ? "✅ YES (p < 0.05)" : "❌ NO — performance indistinguishable from random"}`);
  console.log("");

  // Top symbols by total R
  perSymbol.sort((a, b) => b.stats.totalR - a.stats.totalR);
  console.log("Top 10 contributors (by total R):");
  for (const ps of perSymbol.slice(0, 10)) {
    if (ps.stats.trades === 0) continue;
    console.log(`  ${ps.symbol.padEnd(18)} ${ps.stats.trades.toString().padStart(3)} trades · winrate ${(ps.stats.winRate * 100).toFixed(0)}% · expectancy ${ps.stats.expectancy.toFixed(2)}R · total ${ps.stats.totalR.toFixed(1)}R`);
  }
  console.log("");
  console.log("Bottom 5 (worst contributors):");
  for (const ps of perSymbol.slice(-5).reverse()) {
    if (ps.stats.trades === 0) continue;
    console.log(`  ${ps.symbol.padEnd(18)} ${ps.stats.trades.toString().padStart(3)} trades · winrate ${(ps.stats.winRate * 100).toFixed(0)}% · expectancy ${ps.stats.expectancy.toFixed(2)}R · total ${ps.stats.totalR.toFixed(1)}R`);
  }

  if (args.sendTg) {
    const verdict = result.significant ? "✅ SIGNIFICANT EDGE" : "❌ NO STAT EDGE";
    const lines = [
      `🔬 <b>Aronson Backtest [${variantLabel}]</b>`,
      `Threshold: composite ≥${args.threshold}${args.requireBreakout ? " + breakout" : ""}${args.requireStage2 ? " + stage2" : ""} · ${args.horizon}d hold · 2×ATR stop`,
      "",
      `<b>Real performance:</b>`,
      `  Trades: ${r.trades}`,
      `  Win rate: ${(r.winRate * 100).toFixed(1)}%`,
      `  Expectancy: ${r.expectancy.toFixed(2)}R / trade`,
      `  Total: ${r.totalR.toFixed(1)}R · Max DD ${r.maxDrawdownR.toFixed(1)}R`,
      "",
      `<b>Permutation (${args.perms} shuffles):</b>`,
      `  Mean shuffle: ${result.meanPermuted.toFixed(1)}R · std ${result.stdPermuted.toFixed(1)}`,
      `  p-value: ${result.pValue.toFixed(3)}`,
      `  Verdict: ${verdict}`,
    ];
    await sendTelegram(lines.join("\n"), { parse_mode: "HTML" });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
