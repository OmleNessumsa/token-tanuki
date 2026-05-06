/**
 * Watchlist alerts → Telegram.
 *
 * Reads a JSON file with conditions to monitor (symbol + timeframe + trigger),
 * checks each via analyzeFutures, and pushes an alert when the trigger fires.
 * Only alerts ONCE per condition (sets `firedAt` after).
 *
 * Watchlist file: ~/.cryptotrader/watchlist.json (or $CRYPTOTRADER_STATE_DIR/watchlist.json)
 *
 * Format:
 * [
 *   { "symbol": "HYPE", "timeframe": "15m", "trigger": "bullish_reclaim",
 *     "note": "re-entry signal after SL hunt", "createdAt": "..." }
 * ]
 *
 * Triggers supported:
 *   - "bullish_reclaim"  : timeframe direction flips to bullish
 *   - "bearish_reclaim"  : timeframe direction flips to bearish
 *   - "above:<price>"    : last price closes above <price>
 *   - "below:<price>"    : last price closes below <price>
 *   - "rsi_above:<num>"  : timeframe RSI crosses above N
 *   - "rsi_below:<num>"  : timeframe RSI crosses below N
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyzeFutures } from "../src/analyze-futures.js";
import { sendTelegram } from "../src/clients/telegram.js";

const STATE_DIR = process.env.CRYPTOTRADER_STATE_DIR ?? join(homedir(), ".cryptotrader");
const FILE = join(STATE_DIR, "watchlist.json");

type Trigger = string; // bullish_reclaim | bearish_reclaim | above:N | below:N | rsi_above:N | rsi_below:N
type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";

interface WatchItem {
  symbol: string;          // e.g. HYPE, BCH (no _USDT suffix)
  timeframe: Timeframe;
  trigger: Trigger;
  note?: string;
  createdAt: string;
  firedAt?: string | null; // set when alert fires; once set, item is dormant
}

function load(): WatchItem[] {
  if (!existsSync(FILE)) return [];
  try { return JSON.parse(readFileSync(FILE, "utf8")) as WatchItem[]; }
  catch { return []; }
}
function save(items: WatchItem[]): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(items, null, 2));
}

interface Eval { fired: boolean; reason: string; }

function evalTrigger(item: WatchItem, a: Awaited<ReturnType<typeof analyzeFutures>>): Eval {
  const tf = a.timeframes.find((t) => t.timeframe === item.timeframe);
  if (!tf) return { fired: false, reason: `tf ${item.timeframe} not analyzed` };
  const dir = tf.direction;
  const rsi = tf.chart.rsi;
  const last = a.ticker?.lastPrice ?? 0;

  if (item.trigger === "bullish_reclaim") {
    if (dir === "bullish") return { fired: true, reason: `${item.timeframe} flipped bullish (chart ${tf.chart.score}, rsi ${rsi?.toFixed(0)})` };
    return { fired: false, reason: `${item.timeframe} still ${dir}` };
  }
  if (item.trigger === "bearish_reclaim") {
    if (dir === "bearish") return { fired: true, reason: `${item.timeframe} flipped bearish` };
    return { fired: false, reason: `${item.timeframe} still ${dir}` };
  }
  const m = item.trigger.match(/^(above|below|rsi_above|rsi_below):(.+)$/);
  if (m) {
    const [, kind, valStr] = m as [string, string, string];
    const val = parseFloat(valStr);
    if (kind === "above" && last > val) return { fired: true, reason: `price $${last} > $${val}` };
    if (kind === "below" && last < val) return { fired: true, reason: `price $${last} < $${val}` };
    if (kind === "rsi_above" && rsi !== null && rsi > val) return { fired: true, reason: `${item.timeframe} RSI ${rsi?.toFixed(0)} > ${val}` };
    if (kind === "rsi_below" && rsi !== null && rsi < val) return { fired: true, reason: `${item.timeframe} RSI ${rsi?.toFixed(0)} < ${val}` };
    return { fired: false, reason: `not yet (${kind} ${val}, current ${kind.startsWith("rsi") ? rsi?.toFixed(0) : last})` };
  }
  return { fired: false, reason: `unknown trigger: ${item.trigger}` };
}

async function main(): Promise<void> {
  const items = load();
  const active = items.filter((it) => !it.firedAt);
  if (active.length === 0) {
    process.stderr.write("No active watches.\n");
    return;
  }
  process.stderr.write(`Checking ${active.length} active watches...\n`);

  let anyFired = false;
  for (const item of items) {
    if (item.firedAt) continue;
    process.stderr.write(`  ${item.symbol} ${item.timeframe} ${item.trigger} ... `);
    try {
      const a = await analyzeFutures(item.symbol);
      const result = evalTrigger(item, a);
      process.stderr.write(`${result.fired ? "🔔 FIRED" : "—"}: ${result.reason}\n`);
      if (result.fired) {
        item.firedAt = new Date().toISOString();
        anyFired = true;
        const tf = a.timeframes.find((t) => t.timeframe === item.timeframe);
        const lines = [
          `🔔 <b>Alert fired</b> — ${item.symbol}`,
          `<b>Trigger:</b> ${item.trigger} on ${item.timeframe}`,
          `<b>Why:</b> ${result.reason}`,
          "",
          `Price: $${a.ticker?.lastPrice.toFixed(a.ticker && a.ticker.lastPrice >= 1 ? 4 : 6)}`,
          `Current MTF: ${a.timeframes.map((t) => `${t.timeframe}=${t.direction[0]}${t.chart.score}`).join(" ")}`,
          tf ? `${item.timeframe} chart ${tf.chart.score}/100 · trend ${tf.chart.trend} · RSI ${tf.chart.rsi?.toFixed(0)}` : "",
          item.note ? `\n<i>${item.note}</i>` : "",
        ].filter(Boolean);
        await sendTelegram(lines.join("\n"), { parse_mode: "HTML" });
      }
    } catch (err) {
      process.stderr.write(`ERR ${err instanceof Error ? err.message : err}\n`);
    }
  }

  if (anyFired) save(items);
  // Also auto-prune old fired items > 7 days
  const now = Date.now();
  const kept = items.filter((it) => !it.firedAt || (now - new Date(it.firedAt).getTime()) < 7 * 86400_000);
  if (kept.length !== items.length) save(kept);
}

main().catch((e) => { console.error(e); process.exit(1); });
