/**
 * Futures scanner — runs analyzeFutures across the top-N MEXC perp markets by
 * 24h volume, ranks results by setup quality.
 *
 * Usage:
 *   npx tsx scripts/scan-futures.ts                   # top 30 by volume
 *   npx tsx scripts/scan-futures.ts --top 50          # top 50
 *   npx tsx scripts/scan-futures.ts --include-btc-eth # include BTC + ETH (default excluded)
 *   npx tsx scripts/scan-futures.ts --json            # JSON output
 */

import { fetchJson } from "../src/http.js";
import { analyzeFutures, type FuturesAnalysis } from "../src/analyze-futures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MexcTicker {
  symbol: string;
  lastPrice: number;
  amount24: number;
  riseFallRate: number;
}

const SKIP_SYMBOLS_DEFAULT = new Set(["BTC_USDT", "ETH_USDT"]);
const SKIP_KEYWORDS = ["XAUT", "SILVER", "GOLD", "PAXG", "USDC", "DAI", "USDT_USD"]; // commodities + stables

interface CliArgs {
  top: number;
  includeBtcEth: boolean;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--") && !["json", "include-btc-eth"].includes(key)) {
        args[key] = next;
        i++;
      } else args[key] = true;
    }
  }
  return {
    top: typeof args.top === "string" ? parseInt(args.top, 10) : 30,
    includeBtcEth: args["include-btc-eth"] === true,
    json: args.json === true,
  };
}

interface ScanRow {
  rank: number;
  symbol: string;
  asset: string;
  side: "LONG" | "SHORT" | "FLAT";
  confidence: "high" | "medium" | "low";
  composite: number;
  htf: string;
  ltf: string;
  aligned: boolean;
  fundingRegime: string | null;
  change24hPct: number | null;
  vol24hUsd: number;
  reasons: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  process.stderr.write(`[1/3] fetching MEXC perp tickers...\n`);
  const tickers = await fetchJson<{ success: boolean; data: MexcTicker[] }>("https://contract.mexc.com/api/v1/contract/ticker");
  if (!tickers.success) throw new Error("ticker fetch failed");
  process.stderr.write(`  got ${tickers.data.length} perps\n`);

  // Filter: USDT pairs only, exclude commodities/stables, optionally exclude BTC/ETH
  const skip = new Set([...SKIP_SYMBOLS_DEFAULT].filter(() => !args.includeBtcEth));
  const filtered = tickers.data
    .filter((t) => t.symbol.endsWith("_USDT"))
    .filter((t) => !SKIP_KEYWORDS.some((k) => t.symbol.includes(k)))
    .filter((t) => !skip.has(t.symbol))
    .filter((t) => t.amount24 > 0);

  const top = filtered
    .sort((a, b) => b.amount24 - a.amount24)
    .slice(0, args.top);

  process.stderr.write(`[2/3] scanning top ${top.length} perps by 24h vol...\n\n`);

  const rows: ScanRow[] = [];
  for (let i = 0; i < top.length; i++) {
    const t = top[i]!;
    const asset = t.symbol.replace(/_USDT$/, "").replace(/^([A-Z]+)COIN$/, "$1");
    process.stderr.write(`[${(i + 1).toString().padStart(2)}/${top.length}] ${t.symbol.padEnd(18)} ($${(t.amount24 / 1e6).toFixed(0)}M)... `);
    try {
      const a = await analyzeFutures(asset);
      rows.push({
        rank: i + 1,
        symbol: t.symbol,
        asset,
        side: a.verdict.side,
        confidence: a.verdict.confidence,
        composite: a.confluence.score,
        htf: a.confluence.htfDirection,
        ltf: a.confluence.ltfDirection,
        aligned: a.confluence.aligned,
        fundingRegime: a.funding?.regime ?? null,
        change24hPct: a.ticker?.riseFallRate ? a.ticker.riseFallRate * 100 : null,
        vol24hUsd: t.amount24,
        reasons: a.verdict.reasons.slice(0, 2),
      });
      process.stderr.write(`${a.verdict.side} ${a.confluence.score} ${a.confluence.aligned ? "(aligned)" : ""}\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({
        rank: i + 1, symbol: t.symbol, asset, side: "FLAT", confidence: "low",
        composite: 0, htf: "?", ltf: "?", aligned: false, fundingRegime: null,
        change24hPct: null, vol24hUsd: t.amount24, reasons: [msg.slice(0, 80)],
      });
      process.stderr.write(`ERR ${msg.slice(0, 50)}\n`);
    }
    await sleep(800); // pace MEXC requests (multiple endpoints per analysis)
  }

  process.stderr.write(`\n[3/3] formatting results...\n`);

  const order: Record<string, number> = { LONG: 0, SHORT: 1, FLAT: 2 };
  const confOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  rows.sort((a, b) =>
    (order[a.side]! - order[b.side]!) ||
    (confOrder[a.confidence]! - confOrder[b.confidence]!) ||
    (b.composite - a.composite),
  );

  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log("");
  console.log(`MEXC Futures Scan — top ${top.length} by 24h volume — ${new Date().toISOString().slice(0, 16)}`);
  console.log("");

  const fmtPct = (n: number | null) => n === null ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  const fmtVol = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`;
  console.log("symbol".padEnd(20) + "side".padEnd(6) + "conf".padEnd(7) + "comp".padEnd(6) + "HTF".padEnd(8) + "LTF".padEnd(8) + "align".padEnd(7) + "funding".padEnd(15) + "24h".padEnd(10) + "vol");
  console.log("─".repeat(95));
  for (const r of rows) {
    console.log(
      r.symbol.padEnd(20) +
      r.side.padEnd(6) +
      r.confidence.padEnd(7) +
      String(r.composite).padEnd(6) +
      r.htf.padEnd(8) +
      r.ltf.padEnd(8) +
      (r.aligned ? "✓" : "·").padEnd(7) +
      (r.fundingRegime ?? "?").padEnd(15) +
      fmtPct(r.change24hPct).padEnd(10) +
      fmtVol(r.vol24hUsd),
    );
  }

  const longs = rows.filter((r) => r.side === "LONG");
  const shorts = rows.filter((r) => r.side === "SHORT");
  const flats = rows.filter((r) => r.side === "FLAT");
  console.log("");
  console.log(`Summary: ${longs.length} LONG · ${shorts.length} SHORT · ${flats.length} FLAT`);
  console.log("");

  const highLongs = longs.filter((r) => r.confidence === "high" && r.aligned);
  if (highLongs.length > 0) {
    console.log("=== HIGH CONFIDENCE LONGS (HTF+LTF aligned) ===");
    for (const l of highLongs) {
      console.log(`  ${l.symbol.padEnd(18)} composite ${l.composite.toString().padStart(3)}  funding=${l.fundingRegime}  24h=${fmtPct(l.change24hPct)}`);
      for (const reason of l.reasons) console.log(`      · ${reason}`);
    }
  }

  const highShorts = shorts.filter((r) => r.confidence === "high" && r.aligned);
  if (highShorts.length > 0) {
    console.log("");
    console.log("=== HIGH CONFIDENCE SHORTS (HTF+LTF aligned) ===");
    for (const s of highShorts) {
      console.log(`  ${s.symbol.padEnd(18)} composite ${s.composite.toString().padStart(3)}  funding=${s.fundingRegime}  24h=${fmtPct(s.change24hPct)}`);
      for (const reason of s.reasons) console.log(`      · ${reason}`);
    }
  }

  const fs = await import("node:fs");
  const outPath = `/tmp/scan-futures-${Date.now()}.json`;
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  console.log("");
  console.log(`Full JSON: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
