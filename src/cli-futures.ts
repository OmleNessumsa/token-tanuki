/**
 * Futures CLI mode (Phase 5).
 *
 * Usage:
 *   cryptotrader futures BCH                              # default 20× / $10k account
 *   cryptotrader futures BCH --leverage 10 --account 5000
 *   cryptotrader futures BCH --leverage 20 --account 10000 --risk 0.5 --json
 *
 * Output: structured trade card with multi-timeframe analysis + leverage-aware sizing.
 */

import pc from "picocolors";
import { analyzeFutures, type FuturesAnalysis } from "./analyze-futures.js";
import { generateTradePlan, type TradePlan } from "./analysis/trade-plan.js";

interface CliArgs {
  asset: string;
  leverage: number;
  account: number;
  risk: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs | null {
  const args: Record<string, string | true> = {};
  let asset: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else args[key] = true;
    } else if (!asset) {
      asset = a;
    }
  }
  if (!asset) return null;
  return {
    asset,
    leverage: typeof args.leverage === "string" ? parseFloat(args.leverage) : 20,
    account: typeof args.account === "string" ? parseFloat(args.account) : 10000,
    risk: typeof args.risk === "string" ? parseFloat(args.risk) : 1,
    json: args.json === true,
  };
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function fmtPx(n: number): string {
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function colorVerdict(side: string): string {
  if (side === "LONG") return pc.bgGreen(pc.black(` ${side} `));
  if (side === "SHORT") return pc.bgRed(pc.white(` ${side} `));
  return pc.bgYellow(pc.black(` ${side} `));
}

function bar(score: number, width = 10): string {
  const filled = Math.round((score / 100) * width);
  const s = "█".repeat(Math.max(0, Math.min(width, filled))) + "░".repeat(width - Math.max(0, Math.min(width, filled)));
  return score >= 70 ? pc.green(s) : score >= 40 ? pc.yellow(s) : pc.red(s);
}

function formatPlan(a: FuturesAnalysis, plan: TradePlan | null, args: CliArgs): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`${colorVerdict(a.verdict.side)}  ${a.verdict.confidence} confidence  composite ${a.confluence.score}/100  ${bar(a.confluence.score)}`);
  lines.push("");
  lines.push(pc.bold(`${a.asset} → ${a.perpSymbol}`));
  if (a.ticker) {
    const ch = a.ticker.riseFallRate * 100;
    const chColor = ch >= 0 ? pc.green : pc.red;
    lines.push(`  Last: $${fmtPx(a.ticker.lastPrice)} · 24h ${chColor(`${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`)} · OI ${a.ticker.holdVol.toLocaleString()} contracts`);
  }
  if (a.funding) lines.push(`  ${a.funding.description}`);
  if (a.intermarket.regime !== "neutral" && a.intermarket.regime !== "unknown") lines.push(`  ${pc.dim(`Intermarket: ${a.intermarket.description}`)}`);
  lines.push("");

  // Multi-timeframe table
  lines.push(pc.bold("Multi-timeframe:"));
  for (const t of a.timeframes) {
    const dir = t.direction === "bullish" ? pc.green("▲ bull") : t.direction === "bearish" ? pc.red("▼ bear") : pc.yellow("· neut");
    const rsi = t.chart.rsi?.toFixed(0) ?? "?";
    lines.push(`  ${t.timeframe.padEnd(4)} ${dir}  ${bar(t.chart.score, 6)} ${String(t.chart.score).padStart(3)}/100  trend=${t.chart.trend.padEnd(5)} rsi=${rsi}`);
  }
  lines.push(`  HTF (4h+1d): ${a.confluence.htfDirection} | LTF (15m+1h): ${a.confluence.ltfDirection} | ${a.confluence.aligned ? pc.green("ALIGNED ✓") : pc.yellow("MIXED")}`);
  lines.push("");

  if (!plan) {
    lines.push(pc.yellow("No trade plan generated — verdict is FLAT or no clear setup"));
    return lines.join("\n");
  }

  lines.push(pc.bold(`Trade Card @ ${plan.positionSizing.leverageUsed}× leverage · $${args.account.toFixed(0)} account · ${args.risk}% risk`));
  lines.push("─".repeat(60));
  lines.push(`  ${pc.bold("Entry:")}      $${fmtPx(plan.entry.ideal)} (max $${fmtPx(plan.entry.max)})`);
  const stopColor = plan.stop.method === "liq-cap" ? pc.yellow : pc.dim;
  lines.push(`  ${pc.bold("Stop:")}       $${fmtPx(plan.stop.price)}  ${stopColor(`(${plan.stop.distancePct.toFixed(2)}% ${plan.side === "LONG" ? "below" : "above"}, ${plan.stop.method})`)}`);
  lines.push(`  ${pc.bold("Liq:")}        $${fmtPx(plan.liquidation.price)}  ${pc.dim(`(${plan.liquidation.bufferPct.toFixed(2)}% buffer)`)}`);
  lines.push(`  ${pc.bold("Targets:")}`);
  for (const t of plan.targets) {
    const rrColor = t.rr >= 3 ? pc.green : t.rr >= 2 ? pc.cyan : pc.yellow;
    lines.push(`    → $${fmtPx(t.price).padEnd(10)} ${rrColor(`R:R ${t.rr.toFixed(2)}`)}  ${pc.dim(t.rationale)}`);
  }
  lines.push("");
  lines.push(`  ${pc.bold("Position:")}   ${plan.positionSizing.units.toFixed(4)} ${a.asset} = ${fmtUsd(plan.positionSizing.notionalUsd)} notional`);
  lines.push(`  ${pc.bold("Margin:")}     ${fmtUsd(plan.positionSizing.marginUsd)} · 1R risk = ${fmtUsd(plan.positionSizing.accountRiskUsd)}`);

  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push(pc.bold(pc.yellow("Warnings:")));
    for (const w of plan.warnings) lines.push(`  ${pc.yellow("⚠")} ${w}`);
  }

  lines.push("");
  lines.push(pc.bold("Invalidation:"));
  for (const i of plan.invalidation) lines.push(`  ${pc.red("×")} ${i}`);

  if (a.verdict.caveats.length > 0) {
    lines.push("");
    lines.push(pc.bold(pc.yellow("Caveats:")));
    for (const c of a.verdict.caveats) lines.push(`  ${pc.yellow("⚠")} ${c}`);
  }

  return lines.join("\n");
}

function printHelp(): void {
  process.stdout.write(`cryptotrader futures — multi-timeframe leveraged trade plan generator.

Usage:
  cryptotrader futures <ASSET> [--leverage N] [--account USD] [--risk PCT] [--json]

Examples:
  cryptotrader futures BCH
  cryptotrader futures TON --leverage 20 --account 10000
  cryptotrader futures BTC --leverage 10 --account 5000 --risk 0.5

Defaults: leverage=20, account=$10000, risk=1% per trade.

Output: trade card with multi-timeframe analysis (5m/15m/1h/4h/1d), MEXC perp data,
funding rate context, BTC intermarket regime, and a leverage-aware entry/stop/target/size plan.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // The subcommand "futures" is consumed by the dispatcher (cli.ts)
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const args = parseArgs(argv);
  if (!args) { printHelp(); process.exit(1); }

  try {
    const a = await analyzeFutures(args.asset);
    const plan = generateTradePlan({
      analysis: a,
      accountUsd: args.account,
      leverage: args.leverage,
      riskPctPerTrade: args.risk,
    });

    if (args.json) {
      const slimAnalysis = {
        asset: a.asset,
        perpSymbol: a.perpSymbol,
        ticker: a.ticker,
        funding: a.funding,
        intermarket: a.intermarket,
        confluence: a.confluence,
        verdict: a.verdict,
        timeframes: a.timeframes.map((t) => ({ timeframe: t.timeframe, direction: t.direction, chartScore: t.chart.score, trend: t.chart.trend, rsi: t.chart.rsi })),
      };
      process.stdout.write(JSON.stringify({ analysis: slimAnalysis, plan }, null, 2) + "\n");
    } else {
      process.stdout.write(formatPlan(a, plan, args) + "\n");
    }
    process.exit(a.verdict.side === "FLAT" ? 2 : 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
  }
}

main();
