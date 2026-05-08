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

import { getFuturesTicker } from "../src/clients/mexc-futures.js";
import { sendTelegram } from "../src/clients/telegram.js";
import { readSignals } from "../src/signal-log.js";
import {
  loadPortfolio, savePortfolio, computeSlicePnl, computeR,
  type PaperPortfolio, type PaperPosition, type PaperTrade, type ScaleOut, type ScaleOutReason,
} from "../src/paper-portfolio.js";

const NOTIONAL_PER_TRADE = 50;
const LEVERAGE = 20;
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
  const stopDistPct = ((pos.entryPrice - pos.initialStop) / pos.entryPrice * 100).toFixed(2);
  const tp1Pct = ((pos.tp1Price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2);
  const lines = [
    `🤖 <b>Claude Paper</b> — 📈 OPEN ${pos.asset} LONG`,
    `Entry $${fmtPx(pos.entryPrice)} · Notional $${pos.notionalUsd.toFixed(0)} × ${pos.leverage}× = $${(pos.notionalUsd * pos.leverage).toFixed(0)} expo`,
    `Stop $${fmtPx(pos.initialStop)} (-${stopDistPct}%)`,
    `TP1 $${fmtPx(pos.tp1Price)} (+${tp1Pct}%) · TP2 $${fmtPx(pos.tp2Price)} · TP3 $${fmtPx(pos.tp3Price)}`,
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
  const trade: PaperTrade = {
    id: pos.id,
    signalId: pos.signalId,
    symbol: pos.symbol,
    asset: pos.asset,
    side: "LONG",
    openTs: pos.openTs,
    closedTs: Date.now(),
    entryPrice: pos.entryPrice,
    notionalUsd: pos.notionalUsd,
    leverage: pos.leverage,
    finalExitReason: finalReason,
    scaleOuts: pos.scaleOuts,
    totalRMultiple: totalR,
    totalPnlUsd,
  };
  p.closedTrades.push(trade);
  p.cash += totalPnlUsd;
  p.openPositions = p.openPositions.filter((x) => x.id !== pos.id);
  return trade;
}

async function recordSlice(pos: PaperPosition, fraction: number, price: number, reason: ScaleOutReason): Promise<ScaleOut> {
  const r = computeR(pos.entryPrice, price, pos.initialStop);
  const pnl = computeSlicePnl(pos.entryPrice, price, pos.notionalUsd, pos.leverage, fraction);
  const slice: ScaleOut = { ts: Date.now(), price, fraction, reason, rMultiple: r, pnlUsd: pnl };
  pos.scaleOuts.push(slice);
  pos.remainingFraction = Math.max(0, pos.remainingFraction - fraction);
  return slice;
}

async function processOpenPositions(p: PaperPortfolio): Promise<void> {
  for (const pos of [...p.openPositions]) {
    try {
      const ticker = await getFuturesTicker(pos.symbol);
      if (!ticker) continue;
      const current = ticker.lastPrice;
      pos.lastChecked = Date.now();

      // Order of checks: stop first (worst case), then TPs in order, then horizon.
      if (current <= pos.currentStop) {
        const slice = await recordSlice(pos, pos.remainingFraction, pos.currentStop, "stop");
        await postScaleOut(pos, slice);
        const trade = finalizeIfDone(pos, p, "stop");
        if (trade) await postFullClose(trade, p);
        continue;
      }

      const tpsHit = pos.scaleOuts.filter((s) => s.reason === "tp1" || s.reason === "tp2" || s.reason === "tp3").length;
      if (tpsHit === 0 && current >= pos.tp1Price) {
        const slice = await recordSlice(pos, 0.5, pos.tp1Price, "tp1");
        pos.currentStop = pos.entryPrice;
        await postScaleOut(pos, slice);
      }
      if (tpsHit <= 1 && current >= pos.tp2Price && pos.scaleOuts.find((s) => s.reason === "tp1")) {
        const slice = await recordSlice(pos, 0.3, pos.tp2Price, "tp2");
        pos.currentStop = pos.tp1Price;
        await postScaleOut(pos, slice);
      }
      if (tpsHit <= 2 && current >= pos.tp3Price && pos.scaleOuts.find((s) => s.reason === "tp2")) {
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
  const newOnes = signals.filter((s) =>
    s.fired && s.side === "LONG" && s.stopPrice !== null && s.tp1Price !== null &&
    !p.alreadyTradedSignalIds.includes(s.id),
  );
  for (const sig of newOnes) {
    const stop = sig.stopPrice!;
    const tp1 = sig.tp1Price!;
    const oneR = sig.entryPrice - stop;
    // Fallbacks: TP2 = entry + 2R, TP3 = entry + 3R if not provided
    const tp2 = sig.tp2Price ?? sig.entryPrice + 2 * oneR;
    const tp3 = sig.tp3Price ?? sig.entryPrice + 3 * oneR;
    const pos: PaperPosition = {
      id: sig.id,
      signalId: sig.id,
      symbol: sig.symbol,
      asset: sig.asset,
      side: "LONG",
      openTs: sig.ts,
      entryPrice: sig.entryPrice,
      notionalUsd: NOTIONAL_PER_TRADE,
      leverage: LEVERAGE,
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
  // Only at 09:00 UTC ± 10 min
  const hour = new Date().getUTCHours();
  const minute = new Date().getUTCMinutes();
  if (hour !== 9 || minute > 10) return;

  const wins = p.closedTrades.filter((t) => t.totalRMultiple > 0).length;
  const losses = p.closedTrades.length - wins;
  const totalR = p.closedTrades.reduce((a, t) => a + t.totalRMultiple, 0);
  const days = Math.max(1, Math.floor((Date.now() - p.startedAt) / 86_400_000));
  const pct = ((p.cash - p.initialCash) / p.initialCash) * 100;
  const lines = [
    `🤖 <b>Claude Paper</b> — Day ${days} summary`,
    `Book: $${p.cash.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`,
    `Closed trades: ${p.closedTrades.length} (${wins}W/${losses}L) · total ${fmtR(totalR)}`,
    `Open positions: ${p.openPositions.length}`,
  ];
  if (p.openPositions.length > 0) {
    lines.push("");
    for (const pos of p.openPositions) {
      const ageDays = ((Date.now() - pos.openTs) / 86_400_000).toFixed(1);
      lines.push(`  ${pos.asset.padEnd(6)} entry $${fmtPx(pos.entryPrice)} · stop $${fmtPx(pos.currentStop)} · ${ageDays}d · ${(pos.remainingFraction * 100).toFixed(0)}% open`);
    }
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

main().catch((e) => { console.error(e); process.exit(1); });
