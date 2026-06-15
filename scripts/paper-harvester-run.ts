/**
 * Daily paper-trading runner for the beta harvester (Fase 3, CB-019).
 *
 * The harvester rebalances daily, so "live" is a once-a-day job — no
 * websockets. Each run:
 *   1. fetches the latest daily bars for the universe from Blofin,
 *   2. drops the still-forming day (no look-ahead),
 *   3. computes today's target weights via the CERTIFIED latestSignal(),
 *   4. rebalances the paper book to target (once per closed day; idempotent
 *      on same-day reruns),
 *   5. persists state and prints a NAV-vs-buy-hold report.
 *
 * No exchange orders, no real capital. Wire it to run shortly after 00:00
 * UTC (cron / the /schedule skill).
 *
 * Usage:
 *   tsx scripts/paper-harvester-run.ts            # run today's rebalance
 *   tsx scripts/paper-harvester-run.ts --status   # report only, no trading
 *   tsx scripts/paper-harvester-run.ts --reset [--cash N]   # (re)initialize
 */

import { getNativeCandles } from "../src/clients/blofin.js";
import type { Candle } from "../src/analysis/indicators.js";
import {
  DEFAULT_HARVESTER_CONFIG,
  latestSignal,
  type AssetSeries,
} from "../src/strategy/harvester.js";
import {
  createEmpty,
  loadState,
  saveState,
  markToMarket,
  currentWeights,
  rebalanceToTarget,
  HARVESTER_PAPER_PATH,
  type HarvesterPaperState,
} from "../src/strategy/paper-harvester.js";

const UNIVERSE = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "BNB-USDT"];
const BENCH = "BTC-USDT";
const FETCH_BARS = 250; // > warmup (max(volLB,MA)+1 = 131)
const DAY_SEC = 86_400;

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const reset = args.includes("--reset");
const cashArg = args.indexOf("--cash");
const initialCash = cashArg > -1 ? Number(args[cashArg + 1]) : 10_000;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

async function fetchClosedDaily(): Promise<AssetSeries[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayMidnight = Math.floor(nowSec / DAY_SEC) * DAY_SEC; // current forming day
  const series: AssetSeries[] = [];
  for (const sym of UNIVERSE) {
    const bars: Candle[] = await getNativeCandles(sym, "1D", { limit: FETCH_BARS });
    // Drop the still-forming bar (t == today's midnight) and any future junk.
    const closed = bars.filter((b) => b.t < todayMidnight).sort((a, b) => a.t - b.t);
    if (closed.length > 0) series.push({ symbol: sym, candles: closed });
    await new Promise((r) => setTimeout(r, 150));
  }
  return series;
}

function report(state: HarvesterPaperState, prices: Record<string, number>): void {
  const nav = markToMarket(state, prices);
  const ret = nav / state.initialCash - 1;
  const benchVal = state.benchUnits * (prices[BENCH] ?? 0);
  const benchRet = state.benchUnits > 0 ? benchVal / state.initialCash - 1 : 0;
  const peak = state.navHistory.reduce((m, p) => Math.max(m, p.nav), nav);
  const dd = peak > 0 ? (peak - nav) / peak : 0;
  const w = currentWeights(state, prices);

  console.log(`\n┌─ Harvester paper portfolio ${"─".repeat(34)}`);
  console.log(`│ started   ${state.startedAt ? new Date(state.startedAt).toISOString().slice(0, 10) : "—"}   rebalances ${state.rebalanceLog.length}`);
  console.log(`│ NAV       ${usd(nav)}   (init ${usd(state.initialCash)})`);
  console.log(`│ return    ${pct(ret)}   vs buy-hold BTC ${pct(benchRet)}   → ${pct(ret - benchRet)} excess`);
  console.log(`│ drawdown  ${pct(dd)}   cash ${pct(state.cash / nav)}`);
  console.log(`│ exposure  ${Object.keys(w).length ? Object.entries(w).map(([s, x]) => `${s.replace("-USDT", "")} ${pct(x)}`).join("  ") : "(flat — risk-off)"}`);
  console.log(`└${"─".repeat(60)}`);
  console.log(`  state: ${HARVESTER_PAPER_PATH}`);
}

// ---- main ----
let state = loadState();

if (reset || !state) {
  state = createEmpty(UNIVERSE, initialCash, DEFAULT_HARVESTER_CONFIG, Date.now());
  saveState(state);
  console.log(`initialized harvester paper portfolio: ${usd(initialCash)}, universe ${UNIVERSE.join(", ")}`);
}

console.log(`fetching latest closed daily bars from Blofin...`);
const series = await fetchClosedDaily();
if (series.length === 0) {
  console.error("no data fetched — aborting");
  process.exit(1);
}
const signal = latestSignal(series, state.config);
if (!signal) {
  console.error("no signal — aborting");
  process.exit(1);
}
const signalDay = new Date(signal.dayMs).toISOString().slice(0, 10);
console.log(`signal bar: ${signalDay}   target weights: ${Object.keys(signal.weights).length ? Object.entries(signal.weights).map(([s, w]) => `${s.replace("-USDT", "")} ${pct(w)}`).join("  ") : "(flat — risk-off)"}`);

if (statusOnly) {
  report(state, signal.prices);
} else if (signal.dayMs <= state.lastRebalanceDayMs) {
  console.log(`already rebalanced for ${signalDay} (last ${new Date(state.lastRebalanceDayMs).toISOString().slice(0, 10)}) — no trade.`);
  report(state, signal.prices);
} else {
  const navBefore = markToMarket(state, signal.prices);
  const { state: newState, record } = rebalanceToTarget(state, signal.weights, signal.prices, signal.dayMs, BENCH);
  state = newState;
  saveState(state);
  console.log(`\nrebalanced for ${signalDay}: NAV ${usd(navBefore)} → ${usd(record.navAfter)}  cost ${usd(record.totalCost)}  turnover ${pct(record.turnover)}`);
  for (const t of record.trades) {
    console.log(`  ${t.deltaUnits > 0 ? "BUY " : "SELL"} ${Math.abs(t.deltaUnits).toFixed(4)} ${t.symbol.replace("-USDT", "")} @ ${usd(t.price)}`);
  }
  report(state, signal.prices);
}
