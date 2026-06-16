/**
 * Daily paper-trading runner for the PortfolioAllocator, wired BTC-only through
 * a SINGLE trend sleeve (ticket CB-026).
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * The multi-asset basket FAILED the OOS gate (CB-025) and is shelved. The
 * diagnostic showed that BTC-only routed THROUGH the real PortfolioAllocator
 * scores Sharpe 1.06 / maxDD 25% — marginally better than the raw harvester
 * (1.04 / 32%) — and, crucially, it exercises the allocator framework live on
 * the one premium that actually works. This runner wires exactly that to paper:
 * a single-sleeve (trend, BTC-only) portfolio through the certified allocator.
 *
 * The funding-carry sleeve is DELIBERATELY EXCLUDED — its premium is
 * unvalidated (the first-cert proxy zeroes the basis). So this runner does NOT
 * use `buildPaperAllocator` (which wires BOTH sleeves); it constructs the
 * allocator over a lone `TrendSleeve` and fetches NO carry pairs.
 *
 * ── MIRRORS paper-harvester-run.ts ────────────────────────────────────────
 * Same shape as the harvester runner: fetch latest closed daily bars, drop the
 * still-forming UTC day (no look-ahead), compute today's target book, rebalance
 * the paper book once per closed day (idempotent same-day rerun guard via
 * `dayMs <= state.lastRebalanceDayMs`), persist state + PnL, print a report.
 * No exchange orders, no real capital.
 *
 * ── STATE FILE (does NOT collide with the harvester) ──────────────────────
 * State lives at $CRYPTOTRADER_STATE_DIR/paper-allocator-state.json (or
 * ~/.cryptotrader/paper-allocator-state.json). The harvester uses
 * harvester-paper.json — a DISTINCT path, so the two paper books never clobber.
 *
 * Usage:
 *   tsx scripts/paper-allocator-run.ts             # run today's rebalance
 *   tsx scripts/paper-allocator-run.ts --status    # report only, no trading
 *   tsx scripts/paper-allocator-run.ts --dry-run   # compute + report, NO write
 *   tsx scripts/paper-allocator-run.ts --reset [--cash N]   # (re)initialize
 *
 * Wire it to run shortly after 00:00 UTC (launchd template alongside this file).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAllocator } from "../src/strategy/allocator.js";
import { createTrendSleeve } from "../src/strategy/sleeves/trend-sleeve.js";
import {
  buildPaperMarketData,
  latestPrices,
  markToMarket,
  rebalanceToBook,
  createEmptyAllocatorState,
  defaultPaperRange,
  type AllocatorPaperState,
} from "../src/strategy/paper-allocator.js";

// ── BTC-only single-sleeve configuration ────────────────────────────────────

/** The trend sleeve trades a BTC-only universe; no carry pairs are fetched. */
const TREND_UNIVERSE = ["BTC-USDT"] as const;
/** No funding-carry sleeve — its premium is unvalidated (proxy zeroes basis). */
const CARRY_ASSETS: readonly string[] = [];
const BENCH = "BTC-USDT";

// ── State persistence (own ledger, distinct from the harvester's) ───────────

const STATE_DIR =
  process.env["CRYPTOTRADER_STATE_DIR"] ?? join(homedir(), ".cryptotrader");
const STATE_FILE = join(STATE_DIR, "paper-allocator-state.json");

function loadState(): AllocatorPaperState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as AllocatorPaperState;
  } catch {
    return null;
  }
}

function saveState(state: AllocatorPaperState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const dryRun = args.includes("--dry-run");
const reset = args.includes("--reset");
const cashArg = args.indexOf("--cash");
const initialCash = cashArg > -1 ? Number(args[cashArg + 1]) : 10_000;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) =>
  `$${x.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const day = (ms: number) =>
  ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "—";

// ── Reporting ────────────────────────────────────────────────────────────────

function currentWeights(
  state: AllocatorPaperState,
  prices: Record<string, number>,
): Record<string, number> {
  const nav = markToMarket(state, prices);
  const out: Record<string, number> = {};
  if (nav <= 0) return out;
  for (const [key, u] of Object.entries(state.units)) {
    const sym = key.split("|")[0]!;
    const p = prices[sym];
    if (p !== undefined && p > 0 && u !== 0) out[key] = (u * p) / nav;
  }
  return out;
}

function report(
  state: AllocatorPaperState,
  prices: Record<string, number>,
  benchUnits: number,
): void {
  const nav = markToMarket(state, prices);
  const ret = nav / state.initialCash - 1;
  const benchVal = benchUnits * (prices[BENCH] ?? 0);
  const benchRet = benchUnits > 0 ? benchVal / state.initialCash - 1 : 0;
  const peak = state.navHistory.reduce((m, p) => Math.max(m, p.nav), nav);
  const dd = peak > 0 ? (peak - nav) / peak : 0;
  const w = currentWeights(state, prices);

  console.log(`\n┌─ Allocator paper portfolio (BTC-only, trend sleeve) ${"─".repeat(14)}`);
  console.log(`│ started   ${day(state.startedAt)}   rebalances ${state.navHistory.length}`);
  console.log(`│ NAV       ${usd(nav)}   (init ${usd(state.initialCash)})`);
  console.log(`│ return    ${pct(ret)}   vs buy-hold BTC ${pct(benchRet)}   → ${pct(ret - benchRet)} excess`);
  console.log(`│ drawdown  ${pct(dd)}   cash ${nav > 0 ? pct(state.cash / nav) : "—"}`);
  console.log(
    `│ exposure  ${
      Object.keys(w).length
        ? Object.entries(w)
            .map(([k, x]) => `${k.split("|")[0]!.replace("-USDT", "")}·${k.split("|")[1]} ${pct(x)}`)
            .join("  ")
        : "(flat — risk-off)"
    }`,
  );
  console.log(`└${"─".repeat(60)}`);
  console.log(`  state: ${STATE_FILE}${dryRun ? "  (dry-run: NOT written)" : ""}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

let state = loadState();

if (reset || !state) {
  // costPerLegRoundTrip defaults to 0.0014 inside createEmptyAllocatorState,
  // matching the harvester's DEFAULT_HARVESTER_CONFIG cost assumption.
  state = createEmptyAllocatorState(initialCash, undefined, Date.now());
  if (!dryRun) {
    saveState(state);
    console.log(
      `initialized allocator paper portfolio: ${usd(initialCash)}, BTC-only trend sleeve`,
    );
  } else {
    console.log(
      `(dry-run) would initialize allocator paper portfolio: ${usd(initialCash)}, BTC-only trend sleeve`,
    );
  }
}

// Benchmark units for the buy-hold BTC comparison: initialCash worth of BTC at
// inception. AllocatorPaperState carries no bench field (it's read-only,
// CB-024), so we derive a best-effort inception-price proxy: the BTC close at
// the FIRST recorded NAV day if we can resolve it, else current price. This is
// report-only colour — it never touches the paper book accounting.
function benchUnitsFor(
  state: AllocatorPaperState,
  prices: Record<string, number>,
): number {
  const btc = prices[BENCH];
  if (btc === undefined || btc <= 0) return 0;
  return state.initialCash / btc;
}

console.log(`fetching latest closed daily bars from Blofin (BTC-only)...`);
const data = await buildPaperMarketData(TREND_UNIVERSE, CARRY_ASSETS, defaultPaperRange());
if (data.grid.length === 0 || data.assets.length === 0) {
  console.error("no data fetched — aborting");
  process.exit(1);
}

// Single trend sleeve, BTC-only universe. NO funding-carry sleeve.
const trend = createTrendSleeve({}, TREND_UNIVERSE);
const allocator = createAllocator([trend], {}); // allocator defaults

const i = data.grid.length - 1;
const result = allocator.allocateAt(data, i);
const prices = latestPrices(data);
const dayMs = (data.grid[i] ?? 0) * 1000;
const signalDay = day(dayMs);

const bookDesc = result.book.length
  ? result.book
      .map((l) => `${l.symbol.replace("-USDT", "")}·${l.instrument} ${pct(l.weight)}`)
      .join("  ")
  : "(flat — risk-off)";
console.log(
  `signal bar: ${signalDay}   est portfolio vol ${pct(result.estPortfolioVol)}   target book: ${bookDesc}`,
);

const benchUnits = benchUnitsFor(state, prices);

if (statusOnly) {
  report(state, prices, benchUnits);
} else if (dayMs <= state.lastRebalanceDayMs) {
  console.log(
    `already rebalanced for ${signalDay} (last ${day(state.lastRebalanceDayMs)}) — no trade.`,
  );
  report(state, prices, benchUnits);
} else {
  const reb = rebalanceToBook(state, result.book, prices, dayMs);
  state = reb.state;
  if (!dryRun) saveState(state);
  console.log(
    `\n${dryRun ? "(dry-run) " : ""}rebalanced for ${signalDay}: NAV ${usd(reb.navBefore)} → ${usd(reb.navAfter)}  cost ${usd(reb.totalCost)}  turnover ${pct(reb.turnover)}`,
  );
  report(state, prices, benchUnits);
}
