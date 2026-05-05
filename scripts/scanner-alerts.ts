/**
 * Scanner alerts → Telegram.
 *
 * 1. Run scan-futures-style scan over top-N MEXC perps by 24h volume
 * 2. Filter: only HIGH-confidence aligned LONGs (or SHORTs) with composite ≥ 70
 * 3. Compare against state file at ~/.cryptotrader/scan-state.json — only push NEW signals
 * 4. Push trade card per new signal
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchJson } from "../src/http.js";
import { analyzeFutures } from "../src/analyze-futures.js";
import { generateTradePlan } from "../src/analysis/trade-plan.js";
import { sendTelegram } from "../src/clients/telegram.js";

const STATE_DIR = join(homedir(), ".cryptotrader");
const STATE_FILE = join(STATE_DIR, "scan-state.json");
const SLEEP_BETWEEN = 800;

interface MexcTicker { symbol: string; amount24: number; }

interface ScanState {
  /** map of symbol → last alerted side ("LONG" / "SHORT") + timestamp */
  alerted: Record<string, { side: string; composite: number; ts: number }>;
}

const SKIP_KEYWORDS = ["XAUT", "SILVER", "GOLD", "PAXG", "USDC", "DAI", "USDT_USD"];
const SKIP_SYMBOLS = new Set(["BTC_USDT", "ETH_USDT"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadState(): ScanState {
  if (!existsSync(STATE_FILE)) return { alerted: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { alerted: {} }; }
}
function saveState(s: ScanState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const top = args.includes("--top") ? parseInt(args[args.indexOf("--top") + 1]!, 10) : 30;
  const minComposite = args.includes("--min") ? parseInt(args[args.indexOf("--min") + 1]!, 10) : 70;
  const force = args.includes("--force");

  process.stderr.write(`Fetching tickers...\n`);
  const tickers = await fetchJson<{ success: boolean; data: MexcTicker[] }>("https://contract.mexc.com/api/v1/contract/ticker");
  const filtered = tickers.data
    .filter((t) => t.symbol.endsWith("_USDT"))
    .filter((t) => !SKIP_KEYWORDS.some((k) => t.symbol.includes(k)))
    .filter((t) => !SKIP_SYMBOLS.has(t.symbol))
    .filter((t) => t.amount24 > 0)
    .sort((a, b) => b.amount24 - a.amount24)
    .slice(0, top);

  process.stderr.write(`Scanning top ${filtered.length} perps (min composite ${minComposite})...\n\n`);

  const state = loadState();
  const newAlerts: Array<{ asset: string; symbol: string; analysis: Awaited<ReturnType<typeof analyzeFutures>> }> = [];

  for (let i = 0; i < filtered.length; i++) {
    const t = filtered[i]!;
    const asset = t.symbol.replace(/_USDT$/, "").replace(/^([A-Z]+)COIN$/, "$1");
    process.stderr.write(`[${(i + 1).toString().padStart(2)}/${filtered.length}] ${t.symbol.padEnd(18)} `);
    try {
      const a = await analyzeFutures(asset);
      const high = a.verdict.confidence === "high" && a.confluence.aligned && a.confluence.score >= minComposite;
      const isLong = a.verdict.side === "LONG";
      const isShort = a.verdict.side === "SHORT";
      const isNew = !state.alerted[t.symbol] ||
        state.alerted[t.symbol]!.side !== a.verdict.side ||
        Math.abs(state.alerted[t.symbol]!.composite - a.confluence.score) > 10;

      if (high && (isLong || isShort) && (force || isNew)) {
        newAlerts.push({ asset, symbol: t.symbol, analysis: a });
        state.alerted[t.symbol] = { side: a.verdict.side, composite: a.confluence.score, ts: Date.now() };
        process.stderr.write(`★ ${a.verdict.side} ${a.confluence.score} (NEW)\n`);
      } else if (high) {
        process.stderr.write(`${a.verdict.side} ${a.confluence.score} (already alerted)\n`);
      } else {
        process.stderr.write(`${a.verdict.side} ${a.confluence.score}\n`);
      }
    } catch (err) {
      process.stderr.write(`ERR ${err instanceof Error ? err.message : err}\n`);
    }
    await sleep(SLEEP_BETWEEN);
  }

  saveState(state);

  if (newAlerts.length === 0) {
    process.stderr.write("\nNo new alerts.\n");
    return;
  }

  process.stderr.write(`\n${newAlerts.length} new alert(s), sending to Telegram...\n`);

  for (const { asset, analysis } of newAlerts) {
    const plan = generateTradePlan({
      analysis,
      accountUsd: 10000,
      leverage: 20,
      riskPctPerTrade: 1,
    });
    const lines: string[] = [];
    const sideEmoji = analysis.verdict.side === "LONG" ? "🟢" : "🔴";
    lines.push(`${sideEmoji} <b>NEW ${analysis.verdict.side}</b> — ${asset}`);
    lines.push(`Composite <b>${analysis.confluence.score}/100</b> · ${analysis.verdict.confidence} confidence · ALIGNED ✓`);
    lines.push("");
    if (analysis.ticker) {
      const ch24 = analysis.ticker.riseFallRate * 100;
      lines.push(`Price: $${analysis.ticker.lastPrice.toFixed(4)} (24h ${ch24 >= 0 ? "+" : ""}${ch24.toFixed(2)}%)`);
    }
    if (analysis.funding) lines.push(`Funding: ${analysis.funding.regime} (${(analysis.funding.ratePerCycle * 100).toFixed(4)}%/cycle)`);
    lines.push("");
    lines.push(`MTF: ${analysis.timeframes.map((t) => `${t.timeframe}=${t.direction[0]}${t.chart.score}`).join(" ")}`);
    lines.push("");
    if (plan) {
      lines.push(`<b>Trade plan @ 20x / $10k account:</b>`);
      lines.push(`Entry: $${plan.entry.ideal.toFixed(4)} (max $${plan.entry.max.toFixed(4)})`);
      lines.push(`Stop: $${plan.stop.price.toFixed(4)} (${plan.stop.distancePct.toFixed(2)}% ${plan.side === "LONG" ? "below" : "above"})`);
      const t = plan.targets[0];
      if (t) lines.push(`Target: $${t.price.toFixed(4)} (R:R ${t.rr.toFixed(2)})`);
      lines.push(`Size: ${plan.positionSizing.units.toFixed(4)} ${asset} = $${plan.positionSizing.notionalUsd.toFixed(0)} notional · margin $${plan.positionSizing.marginUsd.toFixed(0)}`);
    }
    const result = await sendTelegram(lines.join("\n"), { parse_mode: "HTML" });
    process.stderr.write(`  ${asset}: ${result.ok ? "✓" : "✗ " + result.error}\n`);
    await sleep(500);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
