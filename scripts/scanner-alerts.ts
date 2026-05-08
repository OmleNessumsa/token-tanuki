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
import { appendSignal } from "../src/signal-log.js";

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

function logSignal(a: FuturesAnalysis, symbol: string, asset: string, fired: boolean, shadowReason: string | null): void {
  if (!a.ticker) return;
  const plan = generateTradePlan({ analysis: a, accountUsd: 10000, leverage: 20, riskPctPerTrade: 1 });
  // Build rich feature snapshot — used by paper-analyze to find W/L patterns.
  const tfScores: Record<string, number> = {};
  const tfDirections: Record<string, string> = {};
  for (const tf of a.timeframes) {
    tfScores[tf.timeframe] = Math.round(tf.chart.score);
    tfDirections[tf.timeframe] = tf.direction;
  }
  const oneHour = a.timeframes.find((t) => t.timeframe === "1h");
  const dailyOrFallback = a.timeframes.find((t) => t.timeframe === "1d") ?? a.timeframes[a.timeframes.length - 1];
  const recentBullish = dailyOrFallback?.chart.recentBullishPatterns ?? [];
  const recentBearish = dailyOrFallback?.chart.recentBearishPatterns ?? [];
  const setups = (dailyOrFallback?.chart.setups ?? []).filter((s) => s.triggered).map((s) => `${s.setup}-${s.direction}`);
  const now = new Date();
  appendSignal({
    ts: Date.now(),
    symbol,
    asset,
    naturalSide: a.naturalSide,
    side: a.verdict.side,
    fired,
    shadowReason,
    composite: a.confluence.score,
    stage2: a.stage2,
    aligned: a.confluence.aligned,
    htfDirection: a.confluence.htfDirection,
    ltfDirection: a.confluence.ltfDirection,
    entryPrice: a.ticker.lastPrice,
    stopPrice: plan?.stop.price ?? null,
    tp1Price: plan?.targets[0]?.price ?? null,
    tp2Price: plan?.targets[1]?.price ?? null,
    tp3Price: plan?.targets[2]?.price ?? null,
    features: {
      tfScores,
      tfDirections,
      fundingRegime: a.funding?.regime ?? null,
      fundingRatePct: a.funding ? a.funding.ratePerCycle * 100 : null,
      intermarketRegime: a.intermarket.regime,
      trendTemplateRatio: a.trendTemplate && a.trendTemplate.criteriaTotal > 0
        ? a.trendTemplate.criteriaPassed / a.trendTemplate.criteriaTotal
        : null,
      rsi1h: oneHour?.chart.rsi ?? null,
      hasBreakout: dailyOrFallback?.chart.breakout !== null && dailyOrFallback?.chart.breakout !== undefined,
      hasVolumeConfirmation: dailyOrFallback?.chart.volumeConfirmation ?? false,
      recentBullishPatterns: recentBullish,
      recentBearishPatterns: recentBearish,
      activeSetups: setups,
      hourUtc: now.getUTCHours(),
      dayOfWeek: now.getUTCDay(),
    },
    outcome: null,
  });
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
        logSignal(a, t.symbol, asset, true, null);
      } else if (high) {
        process.stderr.write(`${a.verdict.side} ${a.confluence.score} (already alerted)\n`);
      } else {
        process.stderr.write(`${a.verdict.side} ${a.confluence.score}\n`);
        // Shadow log: signal would have been LONG except for Stage 2 gate.
        // Captures the counterfactual to compare expectancy fired vs shadowed.
        const shadowed = a.naturalSide === "LONG" && a.verdict.side === "FLAT" &&
          a.confluence.aligned && a.confluence.score >= minComposite && a.stage2 === false;
        if (shadowed) {
          logSignal(a, t.symbol, asset, false, "stage2-gated");
          process.stderr.write(`  └─ shadow: stage2-gated LONG ${a.confluence.score} (logged for forward test)\n`);
        }
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
