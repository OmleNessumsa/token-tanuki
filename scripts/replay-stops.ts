/**
 * Replay our 76 closed paper trades against a sweep of WIDER synthetic stops.
 *
 * Original strategy used 2×ATR(14)/swing-low stops. Post-mortem 2026-05-15
 * showed 1-6h holding-time was a disaster (WR 9.4%, -26R) — i.e. our stops
 * got noise-tagged before the trade thesis could play out. This script
 * answers "at what multiplier of the original stop distance does net R
 * (after 1.2%/side fees) turn positive?".
 *
 * Method (first-event sim):
 *   1. For each closed trade, take entry + ORIGINAL stop dist as 1R baseline.
 *   2. For each multiplier m in MULTIPLIERS, synthStop = entry × (1 - orig_dist% × m).
 *   3. Fetch 1h candles from Coinbase covering [openTs .. openTs + 7d horizon].
 *   4. Walk forward, first to fire wins:
 *        - low ≤ synthStop      → stop hit, realized R = -1
 *        - high ≥ tp1           → tp1 hit, realized R = (tp1 - entry) / (entry - synthStop)
 *        - else after 7d        → horizon close at last close
 *   5. Apply 1.2%/side round-trip fee: feeR = 2.4 / synthStopDistPct (in stop-R units)
 *   6. Net R per trade = realized R - feeR.
 *
 * Run: npx tsx scripts/replay-stops.ts
 */

import pc from "picocolors";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchJson } from "../src/http.js";

const STATE_DIR = process.env.CRYPTOTRADER_STATE_DIR ?? join(homedir(), ".cryptotrader");
const PORTFOLIO = join(STATE_DIR, "paper-portfolio.json");

const MULTIPLIERS = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
const HORIZON_MS = 7 * 24 * 3600 * 1000;
const FEE_PCT_RT = 2.4;
const COINBASE_BASE = "https://api.coinbase.com/api/v3/brokerage/market";

interface ScaleOut { ts: number; price: number; fraction: number; reason: string; rMultiple: number; pnlUsd: number; }
interface ClosedTrade {
  signalId: string;
  symbol: string;
  asset: string;
  exchange?: string;
  openTs: number;
  closedTs: number;
  entryPrice: number;
  notionalUsd: number;
  finalExitReason: string;
  scaleOuts: ScaleOut[];
  totalRMultiple: number;
  totalPnlUsd: number;
}
interface SignalRecord {
  id: string;
  symbol: string;
  entryPrice: number;
  stopPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  tp3Price: number | null;
}

interface CandleRaw { start: string; open: string; high: string; low: string; close: string; volume: string; }
interface Candle { t: number; o: number; h: number; l: number; c: number; }

async function fetchCandles(productId: string, startSec: number, endSec: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = endSec;
  const granSec = 3600;
  const pageSec = 350 * granSec;
  while (cursor > startSec) {
    const start = Math.max(startSec, cursor - pageSec);
    const url = `${COINBASE_BASE}/products/${encodeURIComponent(productId)}/candles?start=${start}&end=${cursor}&granularity=ONE_HOUR`;
    let page: CandleRaw[] = [];
    try {
      const resp = await fetchJson<{ candles: CandleRaw[] }>(url);
      page = resp.candles ?? [];
    } catch (e) {
      process.stderr.write(`  fetch err ${productId}: ${e instanceof Error ? e.message : e}\n`);
      break;
    }
    if (page.length === 0) break;
    for (const c of page) {
      out.push({ t: Number(c.start), o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close) });
    }
    const oldestStart = Number(page[page.length - 1]!.start);
    if (!Number.isFinite(oldestStart) || oldestStart >= cursor) break;
    cursor = oldestStart;
    if (page.length < 350) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

interface ReplayResult {
  realizedR: number;
  exitReason: "stop" | "tp1" | "horizon";
  netR: number;
  feeR: number;
  synthStopDistPct: number;
}

function simulate(
  trade: ClosedTrade,
  sig: SignalRecord,
  candles: Candle[],
  multiplier: number,
): ReplayResult | null {
  const entry = trade.entryPrice;
  const origStop = sig.stopPrice;
  const tp1 = sig.tp1Price;
  if (origStop === null || tp1 === null || origStop >= entry || tp1 <= entry) return null;
  const origDistPct = ((entry - origStop) / entry) * 100;
  const synthDistPct = origDistPct * multiplier;
  const synthStop = entry * (1 - synthDistPct / 100);
  const openSec = Math.floor(trade.openTs / 1000);
  const horizonSec = openSec + 7 * 24 * 3600;

  let exitReason: "stop" | "tp1" | "horizon" = "horizon";
  let realizedR = 0;
  let lastClose = entry;

  for (const bar of candles) {
    if (bar.t < openSec) continue;
    if (bar.t >= horizonSec) break;
    lastClose = bar.c;
    // Conservative bar order: assume stop is checked before TP within the bar
    // (worst case for the strategy — same convention as the live paper-trader).
    if (bar.l <= synthStop) {
      exitReason = "stop";
      realizedR = -1;
      break;
    }
    if (bar.h >= tp1) {
      exitReason = "tp1";
      realizedR = (tp1 - entry) / (entry - synthStop);
      break;
    }
  }
  if (exitReason === "horizon") {
    realizedR = (lastClose - entry) / (entry - synthStop);
  }

  const feeR = FEE_PCT_RT / synthDistPct;
  return { realizedR, exitReason, netR: realizedR - feeR, feeR, synthStopDistPct: synthDistPct };
}

function fmtR(r: number): string {
  const s = (r >= 0 ? "+" : "") + r.toFixed(2);
  return r > 0.05 ? pc.green(s) : r < -0.05 ? pc.red(s) : pc.dim(s);
}
function fmtPf(pf: number): string {
  if (!Number.isFinite(pf)) return pc.dim("  ∞");
  const s = pf.toFixed(2);
  return pf >= 1.5 ? pc.green(s) : pf >= 1.0 ? pc.yellow(s) : pc.red(s);
}

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(PORTFOLIO, "utf8"));
  const trades: ClosedTrade[] = raw.closedTrades ?? [];
  const logPath = join(STATE_DIR, "signals.jsonl");
  const sigs: Record<string, SignalRecord> = {};
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SignalRecord;
      sigs[r.id] = r;
    } catch { /* skip */ }
  }

  const coinbaseTrades = trades.filter((t) => t.exchange === "coinbase-spot");
  process.stdout.write(pc.bold(`Stop-replay — ${coinbaseTrades.length} Coinbase paper trades\n`));
  process.stdout.write(pc.dim(`Sweep multipliers: ${MULTIPLIERS.join(", ")} × original stop distance\n`));
  process.stdout.write(pc.dim(`Horizon: 7d · Fee model: ${FEE_PCT_RT}% round-trip\n\n`));

  // Group by symbol → fetch candle window covering all trades' open..horizon
  const bySymbol: Record<string, ClosedTrade[]> = {};
  for (const t of coinbaseTrades) {
    (bySymbol[t.symbol] ??= []).push(t);
  }

  process.stdout.write(pc.dim("[1/2] fetching 1h candles per symbol...\n"));
  const candlesBySymbol: Record<string, Candle[]> = {};
  for (const [sym, tradesForSym] of Object.entries(bySymbol)) {
    const minOpen = Math.min(...tradesForSym.map((t) => t.openTs));
    const maxOpen = Math.max(...tradesForSym.map((t) => t.openTs));
    const startSec = Math.floor((minOpen - 6 * 3600 * 1000) / 1000);
    const endSec = Math.floor((maxOpen + HORIZON_MS + 6 * 3600 * 1000) / 1000);
    const c = await fetchCandles(sym, startSec, endSec);
    candlesBySymbol[sym] = c;
    process.stdout.write(pc.dim(`  ${sym.padEnd(12)} ${c.length} bars (${tradesForSym.length} trades)\n`));
  }
  process.stdout.write("\n");

  // For each multiplier, simulate all trades
  process.stdout.write(pc.dim("[2/2] replaying...\n\n"));
  const header = [
    "mult".padStart(6),
    "trades".padStart(7),
    "WR%".padStart(6),
    "stops%".padStart(7),
    "tp1%".padStart(6),
    "horiz%".padStart(7),
    "gross R".padStart(15),
    "avg R".padStart(14),
    "feeR/tr".padStart(8),
    "NET R".padStart(15),
    "PF (net)".padStart(15),
  ];
  process.stdout.write(pc.bold(header.join("  ")) + "\n");
  process.stdout.write(pc.dim("─".repeat(125)) + "\n");

  for (const mult of MULTIPLIERS) {
    const results: ReplayResult[] = [];
    let skipped = 0;
    for (const t of coinbaseTrades) {
      const sig = sigs[t.signalId];
      const c = candlesBySymbol[t.symbol];
      if (!sig || !c || c.length === 0) { skipped++; continue; }
      const r = simulate(t, sig, c, mult);
      if (r === null) { skipped++; continue; }
      results.push(r);
    }
    if (results.length === 0) {
      process.stdout.write(pc.dim(`  ${mult.toFixed(2)}×  no replayable trades (skipped ${skipped})\n`));
      continue;
    }
    const grossR = results.reduce((a, r) => a + r.realizedR, 0);
    const netR = results.reduce((a, r) => a + r.netR, 0);
    const stops = results.filter((r) => r.exitReason === "stop").length;
    const tp1s = results.filter((r) => r.exitReason === "tp1").length;
    const hors = results.filter((r) => r.exitReason === "horizon").length;
    const wins = results.filter((r) => r.netR > 0).length;
    const feeRs = results.map((r) => r.feeR);
    const avgFee = feeRs.reduce((a, b) => a + b, 0) / feeRs.length;
    const grossWin = results.filter((r) => r.netR > 0).reduce((a, r) => a + r.netR, 0);
    const grossLoss = Math.abs(results.filter((r) => r.netR <= 0).reduce((a, r) => a + r.netR, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : Number.POSITIVE_INFINITY;

    const cells = [
      `${mult.toFixed(2)}×`.padStart(6),
      String(results.length).padStart(7),
      ((wins / results.length) * 100).toFixed(1).padStart(6),
      `${((stops / results.length) * 100).toFixed(0)}%`.padStart(7),
      `${((tp1s / results.length) * 100).toFixed(0)}%`.padStart(6),
      `${((hors / results.length) * 100).toFixed(0)}%`.padStart(7),
      fmtR(grossR).padStart(23),
      fmtR(grossR / results.length).padStart(22),
      avgFee.toFixed(2).padStart(8),
      fmtR(netR).padStart(23),
      fmtPf(pf).padStart(24),
    ];
    process.stdout.write(cells.join("  ") + "\n");
  }
  process.stdout.write("\n");
  process.stdout.write(pc.dim(
    "Reading the table:\n" +
      "  - 1.00× = current 2×ATR stops (baseline).\n" +
      "  - mult>1 = wider stops than baseline.\n" +
      "  - Each trade's stop distance widens linearly; TP1 stays put.\n" +
      "  - First-event sim: stop OR tp1 within the bar, stop wins (conservative).\n" +
      "  - 'NET R' subtracts 2.4% round-trip fees, expressed in synth-stop R units.\n",
  ));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
