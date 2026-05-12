/**
 * One-shot Coinbase top-10 scanner. Runs the multi-TF futures pipeline
 * against the Coinbase spot adapter for each asset in COINBASE_TOP10_ASSETS,
 * then prints a compact table.
 *
 * Run: npx tsx scripts/scan-coinbase.ts
 */

import pc from "picocolors";
import { analyzeFutures, type FuturesAnalysis } from "../src/analyze-futures.js";
import { coinbaseSpotAdapter } from "../src/clients/coinbase-adapter.js";
import { COINBASE_TOP10_ASSETS } from "../src/whitelist.js";

function colorSide(side: string): string {
  if (side === "LONG") return pc.bgGreen(pc.black(` LONG  `));
  if (side === "SHORT") return pc.bgRed(pc.white(` SHORT `));
  return pc.bgYellow(pc.black(` FLAT  `));
}

function colorScore(s: number): string {
  const txt = String(s).padStart(3);
  if (s >= 65) return pc.green(txt);
  if (s >= 50) return pc.yellow(txt);
  return pc.red(txt);
}

function bar(s: number, width = 8): string {
  const filled = Math.max(0, Math.min(width, Math.round((s / 100) * width)));
  const b = "█".repeat(filled) + "░".repeat(width - filled);
  return s >= 65 ? pc.green(b) : s >= 50 ? pc.yellow(b) : pc.red(b);
}

function dirGlyph(d: "bullish" | "bearish" | "neutral"): string {
  return d === "bullish" ? pc.green("▲") : d === "bearish" ? pc.red("▼") : pc.yellow("·");
}

function fmtTfRow(a: FuturesAnalysis): string {
  return a.timeframes.map((t) => `${t.timeframe}${dirGlyph(t.direction)}${String(Math.round(t.chart.score)).padStart(2)}`).join(" ");
}

function fmtPrice(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1000) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

async function main(): Promise<void> {
  const started = Date.now();
  process.stdout.write(pc.bold("Scanning Coinbase top-10 spot — multi-TF (5m/15m/1h/4h/1d)\n\n"));

  // Cap concurrency so we don't burst-trip Coinbase rate limits. Each asset
  // hits 5 kline endpoints + 1 ticker + 1 funding-skip = ~7 calls. With 10
  // assets in parallel that's ~70 concurrent requests; staggering keeps
  // us well within the public rate limit (~30 req/s).
  const CONCURRENCY = 3;
  const results: FuturesAnalysis[] = [];
  for (let i = 0; i < COINBASE_TOP10_ASSETS.length; i += CONCURRENCY) {
    const batch = COINBASE_TOP10_ASSETS.slice(i, i + CONCURRENCY);
    const out = await Promise.all(
      batch.map(async (asset) => {
        try {
          return await analyzeFutures(asset, coinbaseSpotAdapter);
        } catch (e) {
          return { asset, error: e instanceof Error ? e.message : String(e) } as unknown as FuturesAnalysis;
        }
      }),
    );
    results.push(...out);
  }

  // Sort: LONG first, descending by composite score; then FLAT; then by symbol.
  const ranked = results.slice().sort((a, b) => {
    const sideRank = (s: string) => (s === "LONG" ? 0 : s === "FLAT" ? 1 : 2);
    const ra = sideRank(a.verdict?.side ?? "FLAT");
    const rb = sideRank(b.verdict?.side ?? "FLAT");
    if (ra !== rb) return ra - rb;
    return (b.confluence?.score ?? 0) - (a.confluence?.score ?? 0);
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // Header
  const cols = [
    "Side  ".padEnd(8),
    "Symbol".padEnd(11),
    "Last".padEnd(11),
    "24h".padEnd(8),
    "Comp",
    "Bar".padEnd(8),
    "Conf".padEnd(7),
    "HTF/LTF".padEnd(14),
    "Stg2".padEnd(5),
    "TF detail (5m/15m/1h/4h/1d)",
  ];
  process.stdout.write(pc.dim(cols.join("  ")) + "\n");
  process.stdout.write(pc.dim("─".repeat(120)) + "\n");

  for (const a of ranked) {
    if (!a.verdict) {
      process.stdout.write(pc.red(`${a.asset} — error\n`));
      continue;
    }
    const ch = (a.ticker?.riseFallRate ?? 0) * 100;
    const chColored = ch >= 0 ? pc.green(`+${ch.toFixed(2)}%`) : pc.red(`${ch.toFixed(2)}%`);
    const stage2 = a.stage2 === true ? pc.green("✓") : a.stage2 === false ? pc.red("✗") : pc.dim("?");
    const conf = a.verdict.confidence;
    const confColor = conf === "high" ? pc.green : conf === "medium" ? pc.yellow : pc.dim;
    const cells = [
      colorSide(a.verdict.side),
      (a.perpSymbol ?? "—").padEnd(11),
      fmtPrice(a.ticker?.lastPrice).padEnd(11),
      chColored.padEnd(16),    // padded because color codes inflate length
      colorScore(a.confluence.score),
      bar(a.confluence.score),
      confColor(conf.padEnd(7)),
      `${a.confluence.htfDirection.slice(0, 4)}/${a.confluence.ltfDirection.slice(0, 4)}`.padEnd(14),
      stage2.padEnd(8),
      fmtTfRow(a),
    ];
    process.stdout.write(cells.join("  ") + "\n");
  }

  // Summary
  const longs = ranked.filter((a) => a.verdict?.side === "LONG");
  const flats = ranked.filter((a) => a.verdict?.side === "FLAT");
  const highConfLongs = longs.filter((a) => a.verdict?.confidence === "high");
  const mediumConfLongs = longs.filter((a) => a.verdict?.confidence === "medium");
  process.stdout.write("\n");
  process.stdout.write(pc.bold("Summary:") + "\n");
  process.stdout.write(`  LONG signals : ${longs.length}/10  (high=${highConfLongs.length}  medium=${mediumConfLongs.length}  low=${longs.length - highConfLongs.length - mediumConfLongs.length})\n`);
  process.stdout.write(`  FLAT         : ${flats.length}/10\n`);
  process.stdout.write(pc.dim(`  scan elapsed : ${elapsed}s\n`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
