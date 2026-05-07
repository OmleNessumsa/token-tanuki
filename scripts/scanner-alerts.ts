/**
 * Scanner alerts → Telegram (single digest message).
 *
 * Sends ONE compact message with all new signals as a list:
 *   🆕 5 new LONG signals (composite ≥75):
 *   🔥 DOGE 81 +2.99%  entry $0.1157
 *   🔥 AVAX 79 +0.18%  entry $9.4220
 *   ...
 *   Reply with symbol for full trade plan
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchJson } from "../src/http.js";
import { analyzeFutures, type FuturesAnalysis } from "../src/analyze-futures.js";
import { generateTradePlan } from "../src/analysis/trade-plan.js";
import { sendTelegram } from "../src/clients/telegram.js";

// Per-tenant state isolation: CRYPTOTRADER_STATE_DIR env var overrides default ~/.cryptotrader/
const STATE_DIR = process.env.CRYPTOTRADER_STATE_DIR ?? join(homedir(), ".cryptotrader");
const STATE_FILE = join(STATE_DIR, "scan-state.json");
const SLEEP_BETWEEN = 800;

interface MexcTicker { symbol: string; amount24: number; }
interface ScanState { alerted: Record<string, { side: string; composite: number; ts: number }>; }

const SKIP_KEYWORDS = ["XAUT", "SILVER", "GOLD", "PAXG", "USDC", "DAI", "USDT_USD"];
const SKIP_SYMBOLS = new Set(["BTC_USDT", "ETH_USDT"]);
/** Re-alert a coin after this many hours even if side/composite haven't materially changed. */
const REALERT_AFTER_HOURS = 24;

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
  const minComposite = args.includes("--min") ? parseInt(args[args.indexOf("--min") + 1]!, 10) : 75;
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
  const newAlerts: Array<{ asset: string; symbol: string; analysis: FuturesAnalysis }> = [];

  for (let i = 0; i < filtered.length; i++) {
    const t = filtered[i]!;
    const asset = t.symbol.replace(/_USDT$/, "").replace(/^([A-Z]+)COIN$/, "$1");
    process.stderr.write(`[${(i + 1).toString().padStart(2)}/${filtered.length}] ${t.symbol.padEnd(18)} `);
    try {
      const a = await analyzeFutures(asset);
      const high = a.verdict.confidence === "high" && a.confluence.aligned && a.confluence.score >= minComposite;
      const isLong = a.verdict.side === "LONG";
      const isShort = a.verdict.side === "SHORT";
      const prev = state.alerted[t.symbol];
      const ageHours = prev ? (Date.now() - prev.ts) / 3_600_000 : Infinity;
      const isNew = !prev ||
        prev.side !== a.verdict.side ||
        Math.abs(prev.composite - a.confluence.score) > 10 ||
        ageHours >= REALERT_AFTER_HOURS;

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

  // Single compact digest message
  const longs = newAlerts.filter((n) => n.analysis.verdict.side === "LONG").sort((a, b) => b.analysis.confluence.score - a.analysis.confluence.score);
  const shorts = newAlerts.filter((n) => n.analysis.verdict.side === "SHORT").sort((a, b) => b.analysis.confluence.score - a.analysis.confluence.score);

  const lines: string[] = [];
  lines.push(`🆕 <b>${newAlerts.length} new signal${newAlerts.length === 1 ? "" : "s"}</b> (composite ≥${minComposite})`);
  lines.push("");

  /** Compare current price to recommended entry, return LATE/IN ZONE/EARLY tag. */
  function entryStatus(side: "LONG" | "SHORT", current: number, entryIdeal: number): { tag: string; deltaPct: number } {
    const deltaPct = ((current - entryIdeal) / entryIdeal) * 100;
    if (side === "LONG") {
      if (deltaPct > 1.5) return { tag: "🚨 LATE", deltaPct };
      if (deltaPct > 0.5) return { tag: "⚠ chase", deltaPct };
      if (deltaPct >= -0.5) return { tag: "✅ IN ZONE", deltaPct };
      return { tag: "💎 EARLY", deltaPct };
    }
    // SHORT — mirror
    if (deltaPct < -1.5) return { tag: "🚨 LATE", deltaPct };
    if (deltaPct < -0.5) return { tag: "⚠ chase", deltaPct };
    if (deltaPct <= 0.5) return { tag: "✅ IN ZONE", deltaPct };
    return { tag: "💎 EARLY", deltaPct };
  }

  function fmtPx(n: number): string {
    if (n >= 1000) return n.toFixed(2);
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(6);
  }

  function renderRow({ asset, analysis }: { asset: string; analysis: FuturesAnalysis }): string {
    const ch24 = analysis.ticker ? analysis.ticker.riseFallRate * 100 : 0;
    const sign = ch24 >= 0 ? "+" : "";
    const current = analysis.ticker?.lastPrice ?? 0;
    const fundingFlag = analysis.funding?.regime === "euphoria" ? " 🚨EUPHORIC" : analysis.funding?.regime === "crowded_long" ? " ⚠crowded" : "";

    // Generate a trade plan to get the recommended entry
    const plan = generateTradePlan({ analysis, accountUsd: 10000, leverage: 20, riskPctPerTrade: 1 });
    if (!plan) {
      return `<b>${asset}</b> · ${analysis.confluence.score} · $${fmtPx(current)} (${sign}${ch24.toFixed(1)}%)${fundingFlag}`;
    }

    const status = entryStatus(plan.side, current, plan.entry.ideal);
    const deltaSign = status.deltaPct >= 0 ? "+" : "";
    const stop = plan.stop.price;
    const tps = plan.targets.slice(0, 3);
    const tpStr = tps.length > 0
      ? tps.map((t, i) => `TP${i + 1} $${fmtPx(t.price)} (${t.rr.toFixed(1)}R)`).join(" · ")
      : "no TPs";
    return [
      `<b>${asset}</b> · ${analysis.confluence.score} · 24h ${sign}${ch24.toFixed(1)}%${fundingFlag}`,
      `   entry $${fmtPx(plan.entry.ideal)} · now $${fmtPx(current)} (${deltaSign}${status.deltaPct.toFixed(2)}%) ${status.tag}`,
      `   stop $${fmtPx(stop)} (${plan.stop.distancePct.toFixed(1)}%) · ${tpStr}`,
    ].join("\n");
  }

  if (longs.length > 0) {
    lines.push("<b>🟢 LONG</b>");
    for (const item of longs) lines.push(renderRow(item));
  }
  if (shorts.length > 0) {
    if (longs.length > 0) lines.push("");
    lines.push("<b>🔴 SHORT</b>");
    for (const item of shorts) lines.push(renderRow(item));
  }
  lines.push("");
  lines.push(`<i>✅ IN ZONE = entry now · ⚠ chase = small premium · 🚨 LATE = wait pullback</i>`);

  process.stderr.write(`\n${newAlerts.length} new — sending digest...\n`);
  const result = await sendTelegram(lines.join("\n"), { parse_mode: "HTML" });
  if (result.ok) process.stderr.write(`✓ sent\n`);
  else process.stderr.write(`✗ ${result.error}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
