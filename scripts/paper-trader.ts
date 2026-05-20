/**
 * Claude paper-trader — executes paper trades on every fired LONG signal,
 * manages them with mechanical rules, posts updates to Telegram.
 *
 * Runs every 5 min via cryptotrader-paper.timer (Claude tenant only).
 *
 * Rules:
 *   - Open: $50 notional × 20× = $1000 expo per position. One per signal.
 *   - Stop: as in trade plan.
 *   - TP1 hit: close 50%, move stop to entry (BE).
 *   - TP2 hit: close 30%, move stop to TP1.
 *   - TP3 hit: close remaining 20%.
 *   - 7 days open without TP1 → close at market.
 */

import { sendTelegram } from "../src/clients/telegram.js";
import { readSignals } from "../src/signal-log.js";
import {
  loadPortfolio, savePortfolio, computeSlicePnl, computeR,
  defaultTakerFeePct, feesForSlice,
  type PaperPortfolio, type PaperPosition, type PaperTrade, type ScaleOut, type ScaleOutReason,
} from "../src/paper-portfolio.js";
import type { ExchangeAdapter } from "../src/exchange.js";
import { mexcFuturesAdapter } from "../src/clients/mexc-adapter.js";
import { coinbaseSpotAdapter } from "../src/clients/coinbase-adapter.js";
import { blofinFuturesAdapter } from "../src/clients/blofin-adapter.js";

const ADAPTERS: Record<string, ExchangeAdapter> = {
  "mexc-futures": mexcFuturesAdapter,
  "coinbase-spot": coinbaseSpotAdapter,
  "blofin-futures": blofinFuturesAdapter,
};

/** Resolve the adapter for a position. Defaults to MEXC for legacy records that pre-date the exchange tag. */
function adapterFor(exchange: string | undefined): ExchangeAdapter {
  return ADAPTERS[exchange ?? "mexc-futures"] ?? mexcFuturesAdapter;
}

/**
 * Default leverage to size with when the signal didn't pin one. MEXC was
 * historically 20× (legacy paper convention). Blofin starts conservatively
 * at 5× per the 2026-05-20 plan; trade-plan will adjust downward if the
 * stop wouldn't fit in the liquidation buffer at that leverage.
 */
function defaultLeverage(exchange: string | undefined): number {
  if (exchange === "blofin-futures") return 5;
  if (exchange === "coinbase-spot") return 1;
  return 20; // mexc-futures legacy
}

const NOTIONAL_PER_TRADE_DEFAULT = 50;
const HORIZON_DAYS = 7;
const SLEEP_BETWEEN_CHECKS_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmtPx(n: number): string {
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toFixed(8);
}

function fmtR(r: number): string {
  return (r >= 0 ? "+" : "") + r.toFixed(2) + "R";
}

function fmtUsd(n: number): string {
  return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2);
}

async function postOpen(pos: PaperPosition): Promise<void> {
  const isLong = pos.side === "LONG";
  // Stop and TP distances render as absolute %s; the direction is implied by side.
  const stopDistPct = (Math.abs(pos.entryPrice - pos.initialStop) / pos.entryPrice * 100).toFixed(2);
  const tp1Pct = (Math.abs(pos.tp1Price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2);
  const arrow = isLong ? "📈" : "📉";
  const lines = [
    `🤖 <b>Claude Paper</b> — ${arrow} OPEN ${pos.asset} ${pos.side}`,
    `Entry $${fmtPx(pos.entryPrice)} · Notional $${pos.notionalUsd.toFixed(0)} × ${pos.leverage}× = $${(pos.notionalUsd * pos.leverage).toFixed(0)} expo`,
    `Stop $${fmtPx(pos.initialStop)} (${isLong ? "-" : "+"}${stopDistPct}%)`,
    `TP1 $${fmtPx(pos.tp1Price)} (${isLong ? "+" : "-"}${tp1Pct}%) · TP2 $${fmtPx(pos.tp2Price)} · TP3 $${fmtPx(pos.tp3Price)}`,
  ];
  await sendTelegram(lines.join("\n"), { parse_mode: "HTML" });
}

async function postScaleOut(pos: PaperPosition, slice: ScaleOut): Promise<void> {
  const labelMap: Record<ScaleOutReason, string> = {
    tp1: "🎯 TP1 hit", tp2: "🎯 TP2 hit", tp3: "🏆 TP3 hit",
    stop: "🛑 STOP hit", horizon: "⏰ horizon expired", discretion: "✂️ discretionary close",
  };
  const lines = [
    `🤖 <b>Claude Paper</b> — ${labelMap[slice.reason]} ${pos.asset}`,
    `@ $${fmtPx(slice.price)} · closed ${(slice.fraction * 100).toFixed(0)}% (${fmtR(slice.rMultiple)} · ${fmtUsd(slice.pnlUsd)})`,
    pos.remainingFraction > 0
      ? `Remaining ${(pos.remainingFraction * 100).toFixed(0)}% open · stop now $${fmtPx(pos.currentStop)}`
      : `Position fully closed.`,
  ];
  await sendTelegram(lines.join("\n"), { parse_mode: "HTML" });
}

async function postFullClose(trade: PaperTrade, p: PaperPortfolio): Promise<void> {
  const ageDays = ((trade.closedTs - trade.openTs) / 86_400_000).toFixed(1);
  const lines = [
    `🤖 <b>Claude Paper</b> — TRADE CLOSED ${trade.asset} (${trade.finalExitReason})`,
    `Total ${fmtR(trade.totalRMultiple)} · ${fmtUsd(trade.totalPnlUsd)} · held ${ageDays}d`,
    `Book: $${p.cash.toFixed(2)} (${(((p.cash - p.initialCash) / p.initialCash) * 100).toFixed(2)}%)`,
  ];
  await sendTelegram(lines.join("\n"), { parse_mode: "HTML" });
}

function finalizeIfDone(pos: PaperPosition, p: PaperPortfolio, finalReason: ScaleOutReason): PaperTrade | null {
  if (pos.remainingFraction > 0.001) return null;
  const totalPnlUsd = pos.scaleOuts.reduce((acc, s) => acc + s.pnlUsd, 0);
  const totalR = pos.scaleOuts.reduce((acc, s) => acc + s.rMultiple * s.fraction, 0);
  // Recompute total fees deducted: pnl is net, but expose gross-vs-fees.
  const feePct = defaultTakerFeePct(pos.exchange);
  const totalFees = pos.scaleOuts.reduce(
    (acc, s) => acc + feesForSlice(pos.notionalUsd, s.fraction, feePct),
    0,
  );
  const trade: PaperTrade = {
    id: pos.id,
    signalId: pos.signalId,
    symbol: pos.symbol,
    asset: pos.asset,
    exchange: pos.exchange,
    mode: pos.mode,
    side: pos.side,
    openTs: pos.openTs,
    closedTs: Date.now(),
    entryPrice: pos.entryPrice,
    notionalUsd: pos.notionalUsd,
    leverage: pos.leverage,
    finalExitReason: finalReason,
    scaleOuts: pos.scaleOuts,
    totalRMultiple: totalR,
    totalPnlUsd,
    totalFeesUsd: totalFees,
  };
  p.closedTrades.push(trade);
  p.cash += totalPnlUsd;
  p.openPositions = p.openPositions.filter((x) => x.id !== pos.id);
  return trade;
}

async function recordSlice(pos: PaperPosition, fraction: number, price: number, reason: ScaleOutReason): Promise<ScaleOut> {
  const r = computeR(pos.entryPrice, price, pos.initialStop, pos.side);
  const grossPnl = computeSlicePnl(pos.entryPrice, price, pos.notionalUsd, pos.leverage, fraction, pos.side);
  // Net pnl: subtract round-trip fees for the closed fraction.
  const feePct = defaultTakerFeePct(pos.exchange);
  const fees = feesForSlice(pos.notionalUsd, fraction, feePct);
  const netPnl = grossPnl - fees;
  const slice: ScaleOut = { ts: Date.now(), price, fraction, reason, rMultiple: r, pnlUsd: netPnl };
  pos.scaleOuts.push(slice);
  pos.remainingFraction = Math.max(0, pos.remainingFraction - fraction);
  return slice;
}

/**
 * Side-aware "did the price reach this trigger?" check.
 *
 *   LONG  stop  → triggers when current ≤ stop
 *   LONG  tp    → triggers when current ≥ tp
 *   SHORT stop  → triggers when current ≥ stop  (stop sits ABOVE entry)
 *   SHORT tp    → triggers when current ≤ tp    (tp sits BELOW entry)
 *
 * Exported so tests can exercise the state-machine logic in isolation —
 * processOpenPositions itself wraps network calls and is not unit-friendly.
 */
export function triggered(
  current: number,
  target: number,
  side: PaperPosition["side"],
  kind: "stop" | "tp",
): boolean {
  const isLong = side === "LONG";
  if (kind === "stop") return isLong ? current <= target : current >= target;
  return isLong ? current >= target : current <= target;
}

async function processOpenPositions(p: PaperPortfolio): Promise<void> {
  for (const pos of [...p.openPositions]) {
    try {
      const adapter = adapterFor(pos.exchange);
      const ticker = await adapter.getTicker(pos.symbol);
      if (!ticker) continue;
      const current = ticker.lastPrice;
      pos.lastChecked = Date.now();

      // Order of checks: stop first (worst case), then TPs in order, then horizon.
      if (triggered(current, pos.currentStop, pos.side, "stop")) {
        const slice = await recordSlice(pos, pos.remainingFraction, pos.currentStop, "stop");
        await postScaleOut(pos, slice);
        const trade = finalizeIfDone(pos, p, "stop");
        if (trade) await postFullClose(trade, p);
        continue;
      }

      const tpsHit = pos.scaleOuts.filter((s) => s.reason === "tp1" || s.reason === "tp2" || s.reason === "tp3").length;
      if (tpsHit === 0 && triggered(current, pos.tp1Price, pos.side, "tp")) {
        const slice = await recordSlice(pos, 0.5, pos.tp1Price, "tp1");
        pos.currentStop = pos.entryPrice;
        await postScaleOut(pos, slice);
      }
      if (tpsHit <= 1 && triggered(current, pos.tp2Price, pos.side, "tp") && pos.scaleOuts.find((s) => s.reason === "tp1")) {
        const slice = await recordSlice(pos, 0.3, pos.tp2Price, "tp2");
        pos.currentStop = pos.tp1Price;
        await postScaleOut(pos, slice);
      }
      if (tpsHit <= 2 && triggered(current, pos.tp3Price, pos.side, "tp") && pos.scaleOuts.find((s) => s.reason === "tp2")) {
        const slice = await recordSlice(pos, pos.remainingFraction, pos.tp3Price, "tp3");
        await postScaleOut(pos, slice);
        const trade = finalizeIfDone(pos, p, "tp3");
        if (trade) await postFullClose(trade, p);
        continue;
      }

      // Horizon expiry — close at market if held longer than HORIZON_DAYS
      const ageMs = Date.now() - pos.openTs;
      if (ageMs >= HORIZON_DAYS * 86_400_000 && pos.remainingFraction > 0) {
        const slice = await recordSlice(pos, pos.remainingFraction, current, "horizon");
        await postScaleOut(pos, slice);
        const trade = finalizeIfDone(pos, p, "horizon");
        if (trade) await postFullClose(trade, p);
      }
    } catch (e) {
      process.stderr.write(`err on ${pos.symbol}: ${e instanceof Error ? e.message : e}\n`);
    }
    await sleep(SLEEP_BETWEEN_CHECKS_MS);
  }
}

async function openNewPositions(p: PaperPortfolio): Promise<void> {
  const signals = readSignals();
  // Require at minimum: stop + TP1. TP2/TP3 are nice-to-have; we synthesize
  // them via 1×R progression if the trade plan didn't produce them.
  const openSymbols = new Set(p.openPositions.map((pos) => pos.symbol));
  const newOnes = signals.filter((s) => {
    if (!s.fired) return false;
    if (s.side !== "LONG" && s.side !== "SHORT") return false;
    if (s.stopPrice === null || s.tp1Price === null) return false;
    if (p.alreadyTradedSignalIds.includes(s.id)) return false;
    // Defensive: stop and TP1 must be on the directionally correct side of
    // entry. Reject malformed signals so a bad scan doesn't cascade through
    // the state machine and force-fire all TPs in one tick.
    if (s.side === "LONG") {
      if (s.stopPrice >= s.entryPrice) return false;
      if (s.tp1Price  <= s.entryPrice) return false;
    } else {
      if (s.stopPrice <= s.entryPrice) return false;
      if (s.tp1Price  >= s.entryPrice) return false;
    }
    // Belt-and-braces: scanner cooldown should already prevent same-symbol
    // re-fires, but if a signal sneaks through, never stack a second paper
    // position on a symbol that already has one open. Position correlation
    // is risk amplification we don't want.
    if (openSymbols.has(s.symbol)) return false;
    return true;
  });
  for (const sig of newOnes) {
    const side: PaperPosition["side"] = sig.side === "SHORT" ? "SHORT" : "LONG";
    const stop = sig.stopPrice!;
    const isLong = side === "LONG";
    // 1R distance in price units; positive number regardless of side.
    const oneR = Math.abs(sig.entryPrice - stop);
    // Synthetic TP2/TP3 fallbacks: project N×R from entry in the favourable
    // direction. After fallbacks, sort the three so the state machine
    // ("TPn requires TP(n-1) hit") doesn't deadlock when synthetic TPs end
    // up out-of-order with plan-derived ones.
    //
    //  LONG  : favourable = up    → ascending sort (closest TP first)
    //  SHORT : favourable = down  → descending sort (closest TP first)
    const tp2Default = isLong ? sig.entryPrice + 2 * oneR : sig.entryPrice - 2 * oneR;
    const tp3Default = isLong ? sig.entryPrice + 3 * oneR : sig.entryPrice - 3 * oneR;
    const tpRaw = [
      sig.tp1Price!,
      sig.tp2Price ?? tp2Default,
      sig.tp3Price ?? tp3Default,
    ];
    const sorted = tpRaw.slice().sort((a, b) => (isLong ? a - b : b - a));
    const tp1 = sorted[0]!;
    const tp2 = sorted[1]!;
    const tp3 = sorted[2]!;
    // Mode/exchange-aware sizing:
    //   spot                  → margin = min(cash, initialCash) × 0.25, leverage 1
    //   blofin-futures        → margin = $50, leverage 5 (5× cheaper fees,
    //                           so consistent risk-budget with smaller expo)
    //   mexc-futures legacy   → margin = $50, leverage 20×
    const mode = sig.mode ?? "futures";
    const exchange = sig.exchange ?? "mexc-futures";
    const isSpot = mode === "spot";
    const notional = isSpot
      ? Math.min(p.cash, p.initialCash) * 0.25
      : NOTIONAL_PER_TRADE_DEFAULT;
    const leverage = isSpot ? 1 : defaultLeverage(exchange);
    const pos: PaperPosition = {
      id: sig.id,
      signalId: sig.id,
      symbol: sig.symbol,
      asset: sig.asset,
      exchange,
      mode,
      side,
      openTs: sig.ts,
      entryPrice: sig.entryPrice,
      notionalUsd: notional,
      leverage,
      initialStop: stop,
      currentStop: stop,
      tp1Price: tp1,
      tp2Price: tp2,
      tp3Price: tp3,
      remainingFraction: 1.0,
      scaleOuts: [],
      lastChecked: Date.now(),
    };
    p.openPositions.push(pos);
    p.alreadyTradedSignalIds.push(sig.id);
    await postOpen(pos);
  }
}

async function maybePostDailySummary(p: PaperPortfolio): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (p.lastDailySummary === today) return;
  // Fire at 07:00 UTC ± 10 min (= 09:00 NL CEST / 08:00 NL CET — "ochtend").
  const hour = new Date().getUTCHours();
  const minute = new Date().getUTCMinutes();
  if (hour !== 7 || minute > 10) return;

  // Fetch live prices for open positions to compute unrealized P&L
  const livePrices: Record<string, number> = {};
  for (const pos of p.openPositions) {
    try {
      const adapter = adapterFor(pos.exchange);
      const t = await adapter.getTicker(pos.symbol);
      if (t) livePrices[pos.symbol] = t.lastPrice;
    } catch { /* ignore */ }
    await sleep(SLEEP_BETWEEN_CHECKS_MS);
  }
  const unrealizedUsd = (pos: PaperPosition): number => {
    const px = livePrices[pos.symbol];
    if (px === undefined) return 0;
    return computeSlicePnl(pos.entryPrice, px, pos.notionalUsd, pos.leverage, pos.remainingFraction);
  };
  const unrealizedR = (pos: PaperPosition): number => {
    const px = livePrices[pos.symbol];
    if (px === undefined) return 0;
    return computeR(pos.entryPrice, px, pos.initialStop);
  };
  const totalUnrealized = p.openPositions.reduce((a, pos) => a + unrealizedUsd(pos), 0);

  // Closed in last 24h
  const since24h = Date.now() - 86_400_000;
  const recentClosed = p.closedTrades.filter((t) => t.closedTs >= since24h);
  const recentPnl = recentClosed.reduce((a, t) => a + t.totalPnlUsd, 0);

  // Lifetime stats
  const wins = p.closedTrades.filter((t) => t.totalRMultiple > 0).length;
  const losses = p.closedTrades.length - wins;
  const totalR = p.closedTrades.reduce((a, t) => a + t.totalRMultiple, 0);
  const days = Math.max(1, Math.floor((Date.now() - p.startedAt) / 86_400_000));
  const pct = ((p.cash - p.initialCash) / p.initialCash) * 100;

  const lines: string[] = [];
  lines.push(`🤖 <b>Claude Paper — Day ${days} ochtend rapport</b>`);
  lines.push("");
  lines.push(`📊 <b>Book:</b> $${p.cash.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);
  if (totalUnrealized !== 0) {
    lines.push(`   Unrealized op open: ${fmtUsd(totalUnrealized)}`);
    lines.push(`   <i>Total inc. unrealized: $${(p.cash + totalUnrealized).toFixed(2)}</i>`);
  }
  if (recentClosed.length > 0) {
    lines.push(`   Sinds gisteren (closed): ${fmtUsd(recentPnl)} over ${recentClosed.length} trades`);
  }
  lines.push("");

  if (p.openPositions.length > 0) {
    lines.push(`💼 <b>Open: ${p.openPositions.length} posities</b>`);
    const sorted = [...p.openPositions].sort((a, b) => unrealizedUsd(b) - unrealizedUsd(a));
    for (const pos of sorted) {
      const ageDays = ((Date.now() - pos.openTs) / 86_400_000).toFixed(1);
      const px = livePrices[pos.symbol];
      const u = unrealizedUsd(pos);
      const r = unrealizedR(pos);
      const pxLine = px !== undefined ? `$${fmtPx(pos.entryPrice)} → $${fmtPx(px)}` : `entry $${fmtPx(pos.entryPrice)}`;
      lines.push(`  <b>${pos.asset.padEnd(6)}</b> ${fmtUsd(u)} (${fmtR(r)}) · ${pxLine} · ${ageDays}d · ${(pos.remainingFraction * 100).toFixed(0)}% open`);
    }
    lines.push("");
  }

  if (recentClosed.length > 0) {
    lines.push(`✅ <b>Closed laatste 24u (${recentClosed.length}):</b>`);
    for (const t of recentClosed) {
      lines.push(`  ${t.asset.padEnd(6)} ${t.finalExitReason.padEnd(8)} ${fmtR(t.totalRMultiple)} · ${fmtUsd(t.totalPnlUsd)}`);
    }
    lines.push("");
  }

  if (p.closedTrades.length > 0) {
    const avgR = totalR / p.closedTrades.length;
    lines.push(`📈 <b>Lifetime:</b> ${p.closedTrades.length} closed (${wins}W/${losses}L) · avg ${fmtR(avgR)} · totaal ${fmtR(totalR)}`);
  } else {
    lines.push(`📈 <b>Lifetime:</b> nog geen closed trades`);
  }

  await sendTelegram(lines.join("\n"), { parse_mode: "HTML" });
  p.lastDailySummary = today;
}

async function main(): Promise<void> {
  const p = loadPortfolio();
  process.stderr.write(`Paper portfolio: cash $${p.cash.toFixed(2)} · open ${p.openPositions.length} · closed ${p.closedTrades.length}\n`);
  await openNewPositions(p);
  await processOpenPositions(p);
  await maybePostDailySummary(p);
  savePortfolio(p);
  process.stderr.write(`Done. cash $${p.cash.toFixed(2)} · open ${p.openPositions.length} · closed ${p.closedTrades.length}\n`);
}

// Only run main() when invoked as a script — not when imported by a test
// to exercise the `triggered` helper. argv[1] is the entry-point script.
const isMain = (() => {
  try {
    const entry = process.argv[1] ?? "";
    return entry.endsWith("/paper-trader.ts") || entry.endsWith("/paper-trader.js");
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
