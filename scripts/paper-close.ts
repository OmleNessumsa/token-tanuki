/**
 * Manual discretionary close for a paper-trader position.
 *
 * Usage:
 *   npx tsx scripts/paper-close.ts SYMBOL "reason"
 *   npx tsx scripts/paper-close.ts ZEC "composite faded to 58"
 *   npx tsx scripts/paper-close.ts ALL "blanket cut on btc dump"
 */
import { getFuturesTicker } from "../src/clients/mexc-futures.js";
import { sendTelegram } from "../src/clients/telegram.js";
import {
  loadPortfolio, savePortfolio, computeR, computeSlicePnl,
  type PaperPosition, type PaperTrade, type ScaleOut,
} from "../src/paper-portfolio.js";

function fmtPx(n: number): string { return n >= 1 ? n.toFixed(4) : n.toFixed(6); }
function fmtR(r: number): string { return (r >= 0 ? "+" : "") + r.toFixed(2) + "R"; }
function fmtUsd(n: number): string { return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2); }

async function closeOne(pos: PaperPosition, reason: string): Promise<{ trade: PaperTrade | null; slice: ScaleOut | null }> {
  const ticker = await getFuturesTicker(pos.symbol);
  if (!ticker) return { trade: null, slice: null };
  const price = ticker.lastPrice;
  const r = computeR(pos.entryPrice, price, pos.initialStop);
  const pnl = computeSlicePnl(pos.entryPrice, price, pos.notionalUsd, pos.leverage, pos.remainingFraction);
  const slice: ScaleOut = {
    ts: Date.now(), price, fraction: pos.remainingFraction,
    reason: "discretion", rMultiple: r, pnlUsd: pnl,
  };
  pos.scaleOuts.push(slice);
  pos.remainingFraction = 0;

  const totalR = pos.scaleOuts.reduce((a, s) => a + s.rMultiple * s.fraction, 0);
  const totalPnl = pos.scaleOuts.reduce((a, s) => a + s.pnlUsd, 0);
  const trade: PaperTrade = {
    id: pos.id, signalId: pos.signalId, symbol: pos.symbol, asset: pos.asset, side: "LONG",
    openTs: pos.openTs, closedTs: Date.now(), entryPrice: pos.entryPrice,
    notionalUsd: pos.notionalUsd, leverage: pos.leverage,
    finalExitReason: "discretion", scaleOuts: pos.scaleOuts,
    totalRMultiple: totalR, totalPnlUsd: totalPnl,
  };
  await sendTelegram([
    `🤖 <b>Claude Paper</b> — ✂️ DISCRETIONARY CLOSE ${pos.asset}`,
    `@ $${fmtPx(price)} · ${fmtR(totalR)} · ${fmtUsd(totalPnl)}`,
    `Reason: ${reason}`,
  ].join("\n"), { parse_mode: "HTML" });
  return { trade, slice };
}

async function main(): Promise<void> {
  const target = process.argv[2];
  const reason = process.argv[3] ?? "no reason given";
  if (!target) {
    console.error("usage: paper-close.ts SYMBOL_OR_ALL \"reason\"");
    process.exit(1);
  }
  const p = loadPortfolio();
  const matches = target === "ALL"
    ? p.openPositions.slice()
    : p.openPositions.filter((pos) => pos.asset === target.toUpperCase() || pos.symbol === target.toUpperCase());
  if (matches.length === 0) {
    console.error(`no open paper position matching "${target}"`);
    return;
  }
  for (const pos of matches) {
    const { trade } = await closeOne(pos, reason);
    if (trade) {
      p.closedTrades.push(trade);
      p.cash += trade.totalPnlUsd;
      p.openPositions = p.openPositions.filter((x) => x.id !== pos.id);
      console.log(`closed ${pos.asset} @ ${trade.scaleOuts[trade.scaleOuts.length - 1]!.price} → R=${trade.totalRMultiple.toFixed(2)} pnl=$${trade.totalPnlUsd.toFixed(2)}`);
    }
  }
  savePortfolio(p);
}

main().catch((e) => { console.error(e); process.exit(1); });
