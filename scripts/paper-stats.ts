/**
 * Forward-test status report for any tenant book. Reads the state under
 * CRYPTOTRADER_STATE_DIR (default ~/.cryptotrader) and prints a compact
 * dashboard: account, open positions with live unrealized P&L, closed
 * trades summary, signal log breakdown, recent events.
 *
 * Run:
 *   npx tsx scripts/paper-stats.ts
 *   CRYPTOTRADER_STATE_DIR=~/.cryptotrader-elmo npx tsx scripts/paper-stats.ts
 */

import pc from "picocolors";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaperPortfolio, PaperPosition, PaperTrade } from "../src/paper-portfolio.js";
import { computeR, computeSlicePnl, defaultTakerFeePct, feesForSlice } from "../src/paper-portfolio.js";
import type { SignalRecord } from "../src/signal-log.js";
import type { ExchangeAdapter } from "../src/exchange.js";
import { mexcFuturesAdapter } from "../src/clients/mexc-adapter.js";
import { coinbaseSpotAdapter } from "../src/clients/coinbase-adapter.js";
import { blofinFuturesAdapter } from "../src/clients/blofin-adapter.js";

const STATE_DIR = process.env.CRYPTOTRADER_STATE_DIR ?? join(homedir(), ".cryptotrader");
const PORTFOLIO_FILE = join(STATE_DIR, "paper-portfolio.json");
const SIGNALS_FILE = join(STATE_DIR, "signals.jsonl");

const ADAPTERS: Record<string, ExchangeAdapter> = {
  "mexc-futures": mexcFuturesAdapter,
  "coinbase-spot": coinbaseSpotAdapter,
  "blofin-futures": blofinFuturesAdapter,
};

const fmtUsd = (n: number): string => {
  const s = `$${Math.abs(n).toFixed(2)}`;
  return n < 0 ? `-${s}` : s;
};

const fmtPct = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const fmtR = (r: number): string => `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;

const colorPnl = (n: number): string => (n > 0 ? pc.green : n < 0 ? pc.red : pc.dim);

function fmtPrice(n: number | undefined | null): string {
  if (n == null) return "—";
  if (n >= 1000) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(8)}`;
}

function fmtAge(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(0)}m`;
  const hr = min / 60;
  if (hr < 48) return `${hr.toFixed(1)}h`;
  return `${(hr / 24).toFixed(1)}d`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });
}

function readPortfolio(): PaperPortfolio | null {
  if (!existsSync(PORTFOLIO_FILE)) return null;
  try { return JSON.parse(readFileSync(PORTFOLIO_FILE, "utf8")) as PaperPortfolio; }
  catch { return null; }
}

function readSignalsLog(): SignalRecord[] {
  if (!existsSync(SIGNALS_FILE)) return [];
  const body = readFileSync(SIGNALS_FILE, "utf8");
  const out: SignalRecord[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as SignalRecord); }
    catch { /* skip */ }
  }
  return out;
}

async function fetchLivePrices(positions: PaperPosition[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  for (const pos of positions) {
    try {
      const adapter = ADAPTERS[pos.exchange ?? "mexc-futures"] ?? mexcFuturesAdapter;
      const t = await adapter.getTicker(pos.symbol);
      if (t) prices.set(pos.symbol, t.lastPrice);
    } catch { /* leave unset */ }
  }
  return prices;
}

function summarizeClosedTrades(trades: PaperTrade[]) {
  if (trades.length === 0) return null;
  const winners = trades.filter((t) => t.totalRMultiple > 0);
  const losers = trades.filter((t) => t.totalRMultiple <= 0);
  const totalR = trades.reduce((s, t) => s + t.totalRMultiple, 0);
  const totalPnl = trades.reduce((s, t) => s + t.totalPnlUsd, 0);
  const totalFees = trades.reduce((s, t) => s + (t.totalFeesUsd ?? 0), 0);
  const winR = winners.reduce((s, t) => s + t.totalRMultiple, 0);
  const lossR = Math.abs(losers.reduce((s, t) => s + t.totalRMultiple, 0));
  const profitFactor = lossR > 0 ? winR / lossR : (winR > 0 ? Infinity : 0);
  return {
    count: trades.length,
    wins: winners.length,
    losses: losers.length,
    winRate: trades.length > 0 ? winners.length / trades.length : 0,
    avgR: totalR / trades.length,
    totalR,
    totalPnl,
    totalFees,
    profitFactor,
  };
}

function summarizeSignals(signals: SignalRecord[]) {
  const fired = signals.filter((s) => s.fired);
  const shadow = signals.filter((s) => !s.fired);
  const byExchange = new Map<string, number>();
  for (const s of fired) {
    const k = s.exchange ?? "mexc-futures";
    byExchange.set(k, (byExchange.get(k) ?? 0) + 1);
  }
  const longFired = fired.filter((s) => s.side === "LONG").length;
  const shortFired = fired.filter((s) => s.side === "SHORT").length;
  const stage2OK = fired.filter((s) => s.stage2 === true).length;
  return { total: signals.length, fired: fired.length, shadow: shadow.length, byExchange, longFired, shortFired, stage2OK };
}

function rule(): string { return pc.dim("─".repeat(60)); }

async function main(): Promise<void> {
  const p = readPortfolio();
  if (!p) {
    console.log(pc.red(`No paper-portfolio at ${PORTFOLIO_FILE}`));
    console.log(pc.dim("Set CRYPTOTRADER_STATE_DIR to point at a tenant dir, or run scripts/launchd/install-coinbase.sh."));
    process.exit(1);
  }
  const signals = readSignalsLog();

  const sinceMs = Date.now() - p.startedAt;
  const sinceLabel = fmtAge(sinceMs);

  console.log("");
  console.log(pc.bold(`Forward-test status — ${STATE_DIR.replace(homedir(), "~")}`));
  console.log(pc.dim(`running ${sinceLabel} since ${fmtTime(p.startedAt)}`));
  console.log(rule());

  // ---- Account ----
  const pnl = p.cash - p.initialCash;
  const pnlPct = (pnl / p.initialCash) * 100;
  console.log(pc.bold("Account"));
  console.log(`  Cash             ${fmtUsd(p.cash)}  ${colorPnl(pnl)(`(${fmtPct(pnlPct)} realized)`)}`);
  console.log(`  Initial          ${fmtUsd(p.initialCash)}`);
  console.log(`  Open positions   ${p.openPositions.length}`);
  console.log(`  Closed trades    ${p.closedTrades.length}`);

  // ---- Open positions with live prices ----
  if (p.openPositions.length > 0) {
    console.log("");
    console.log(pc.bold("Open positions"));
    const livePrices = await fetchLivePrices(p.openPositions);
    let totalUnrealized = 0;
    for (const pos of p.openPositions) {
      const px = livePrices.get(pos.symbol);
      const grossUnreal = px !== undefined
        ? computeSlicePnl(pos.entryPrice, px, pos.notionalUsd, pos.leverage, pos.remainingFraction)
        : 0;
      const fees = px !== undefined
        ? feesForSlice(pos.notionalUsd, pos.remainingFraction, defaultTakerFeePct(pos.exchange))
        : 0;
      const netUnreal = grossUnreal - fees;
      totalUnrealized += netUnreal;
      const r = px !== undefined ? computeR(pos.entryPrice, px, pos.initialStop) : 0;
      const movePct = px !== undefined ? ((px - pos.entryPrice) / pos.entryPrice) * 100 : 0;
      const age = fmtAge(Date.now() - pos.openTs);
      const remaining = `${Math.round(pos.remainingFraction * 100)}%`;
      const pxStr = px !== undefined ? fmtPrice(px) : pc.dim("?");
      console.log(
        `  ${pc.bold(pos.asset.padEnd(6))} ${pc.dim((pos.exchange ?? "?").padEnd(14))} ` +
          `entry ${fmtPrice(pos.entryPrice)} → ${pxStr}  ` +
          `${colorPnl(netUnreal)(fmtUsd(netUnreal))} ` +
          `${colorPnl(r)(`(${fmtR(r)} · ${fmtPct(movePct)})`)}  ` +
          `${pc.dim(`stop ${fmtPrice(pos.currentStop)}  TP1 ${fmtPrice(pos.tp1Price)}  ${remaining} open  ${age}`)}`,
      );
    }
    console.log(`  ${pc.dim("─".repeat(58))}`);
    console.log(`  ${"Total unrealized".padEnd(18)} ${colorPnl(totalUnrealized)(fmtUsd(totalUnrealized))}`);
    const totalEquity = p.cash + totalUnrealized;
    console.log(`  ${"Equity (cash+unr)".padEnd(18)} ${fmtUsd(totalEquity)}  ${colorPnl(totalEquity - p.initialCash)(`(${fmtPct(((totalEquity - p.initialCash) / p.initialCash) * 100)} total)`)}`);
  }

  // ---- Closed trades summary ----
  const summary = summarizeClosedTrades(p.closedTrades);
  if (summary) {
    console.log("");
    console.log(pc.bold("Closed trades"));
    console.log(`  ${summary.count} total  (${pc.green(`${summary.wins}W`)} / ${pc.red(`${summary.losses}L`)}  win-rate ${(summary.winRate * 100).toFixed(1)}%)`);
    console.log(`  Avg R          ${colorPnl(summary.avgR)(fmtR(summary.avgR))}`);
    console.log(`  Total R        ${colorPnl(summary.totalR)(fmtR(summary.totalR))}`);
    console.log(`  Total P&L      ${colorPnl(summary.totalPnl)(fmtUsd(summary.totalPnl))}  ${pc.dim(`(fees ${fmtUsd(summary.totalFees)})`)}`);
    const pfLabel = !isFinite(summary.profitFactor) ? "∞" : summary.profitFactor.toFixed(2);
    console.log(`  Profit factor  ${pfLabel}`);
  } else {
    console.log("");
    console.log(pc.bold("Closed trades"));
    console.log(pc.dim("  None yet — first closes need TP/stop/horizon to trigger."));
  }

  // ---- Signals ----
  const sig = summarizeSignals(signals);
  if (signals.length > 0) {
    console.log("");
    console.log(pc.bold("Signals"));
    console.log(`  Logged         ${sig.total}  (fired ${sig.fired}, shadow ${sig.shadow})`);
    if (sig.byExchange.size > 0) {
      const parts = [...sig.byExchange.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
      console.log(`  By exchange    ${parts}`);
    }
    console.log(`  LONG fired     ${sig.longFired}    SHORT fired ${sig.shortFired}`);
    if (sig.stage2OK > 0 || sig.fired > 0) {
      console.log(`  Stage 2 ✓      ${sig.stage2OK} of ${sig.fired} fired`);
    }
  }

  // ---- Recent activity (last 5 signals + last 5 scaleOuts) ----
  type Event = { ts: number; line: string };
  const events: Event[] = [];
  for (const s of signals.slice(-5)) {
    const tag = s.fired ? pc.green("fired") : pc.dim("shadow");
    events.push({
      ts: s.ts,
      line: `${tag}  ${s.side} ${s.asset.padEnd(6)} composite ${s.composite}  Stage2 ${s.stage2 === true ? "✓" : s.stage2 === false ? "✗" : "?"}`,
    });
  }
  for (const t of p.closedTrades.slice(-5)) {
    events.push({
      ts: t.closedTs,
      line: `${pc.cyan("close")}  ${t.asset.padEnd(6)} ${t.finalExitReason.padEnd(8)} ${colorPnl(t.totalPnlUsd)(fmtUsd(t.totalPnlUsd))}  ${fmtR(t.totalRMultiple)}`,
    });
  }
  for (const pos of p.openPositions) {
    for (const so of pos.scaleOuts.slice(-3)) {
      events.push({
        ts: so.ts,
        line: `${pc.yellow(so.reason.padEnd(8))} ${pos.asset.padEnd(6)} @ ${fmtPrice(so.price)}  closed ${(so.fraction * 100).toFixed(0)}%  ${colorPnl(so.pnlUsd)(fmtUsd(so.pnlUsd))}`,
      });
    }
  }
  if (events.length > 0) {
    events.sort((a, b) => b.ts - a.ts);
    console.log("");
    console.log(pc.bold("Recent activity (newest first)"));
    for (const e of events.slice(0, 8)) {
      console.log(`  ${pc.dim(fmtTime(e.ts))}  ${e.line}`);
    }
  }

  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
