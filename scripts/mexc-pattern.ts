/**
 * MEXC trade-pattern analysis — diagnose where the edge leaks.
 *
 * Ratio-based diagnostics:
 *   - Avg win vs avg loss (asymmetry)
 *   - Profit factor (sum wins / |sum losses|)
 *   - Holding-time bias (do losers run longer than winners?)
 *   - Position-size bias (does he size up on losers?)
 *   - Top 10 single-trade disasters
 *   - Per-symbol profit factor (where the bleeding is concentrated)
 *
 * Usage:
 *   CRYPTOTRADER_ENV=.env.roy npx tsx scripts/mexc-pattern.ts
 *   CRYPTOTRADER_ENV=.env.roy npx tsx scripts/mexc-pattern.ts --pages 10
 */
import { getHistoryPositions, type MexcHistoryPosition } from "../src/clients/mexc-private.js";

interface Bucket {
  count: number;
  pnl: number;
  marginUsed: number;
  holdMinutes: number;
}

function emptyBucket(): Bucket {
  return { count: 0, pnl: 0, marginUsed: 0, holdMinutes: 0 };
}

// Derive margin used: MEXC zeros `im` on closed positions. We back it out from
// `realised / profitRatio` (PnL as a fraction of margin). Fall back to
// notional-÷-leverage when profitRatio is 0.
function deriveMargin(p: MexcHistoryPosition & { profitRatio: number }): number {
  if (p.profitRatio !== 0 && Number.isFinite(p.profitRatio)) {
    return Math.abs(p.realised / p.profitRatio);
  }
  return (p.closeVol * p.holdAvgPrice) / Math.max(1, p.leverage);
}

function addToBucket(b: Bucket, p: MexcHistoryPosition & { profitRatio: number }): void {
  b.count++;
  b.pnl += p.realised;
  b.marginUsed += deriveMargin(p);
  b.holdMinutes += (p.updateTime - p.createTime) / 60_000;
}

function avg(b: Bucket, field: "pnl" | "marginUsed" | "holdMinutes"): number {
  return b.count === 0 ? 0 : b[field] / b.count;
}

function formatHold(min: number): string {
  if (min < 60) return `${min.toFixed(0)}m`;
  if (min < 1440) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}

async function main() {
  const args = process.argv.slice(2);
  let pages = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pages") pages = Number(args[++i]);
  }

  console.log(`Fetching MEXC history (${pages} page(s))...`);
  const positions = await getHistoryPositions({ pages });
  if (positions.length === 0) {
    console.log("No closed positions.");
    return;
  }

  const wins: MexcHistoryPosition[] = [];
  const losses: MexcHistoryPosition[] = [];
  const breakeven: MexcHistoryPosition[] = [];
  const winB = emptyBucket();
  const lossB = emptyBucket();
  const beB = emptyBucket();

  for (const p of positions) {
    if (p.realised > 0.5) { wins.push(p); addToBucket(winB, p); }
    else if (p.realised < -0.5) { losses.push(p); addToBucket(lossB, p); }
    else { breakeven.push(p); addToBucket(beB, p); }
  }

  const totalPnl = winB.pnl + lossB.pnl + beB.pnl;
  const avgWin = avg(winB, "pnl");
  const avgLoss = avg(lossB, "pnl");
  const profitFactor = lossB.pnl !== 0 ? winB.pnl / Math.abs(lossB.pnl) : Infinity;
  const expectancy = totalPnl / positions.length;
  const winRate = winB.count / positions.length;

  console.log(`\n═══ Asymmetry diagnostics (${positions.length} trades) ═══`);
  console.log(`Win rate:           ${(winRate * 100).toFixed(1)}%  (${winB.count}W / ${lossB.count}L / ${beB.count}BE)`);
  console.log(`Total realized:     $${totalPnl.toFixed(2)}`);
  console.log(`Expectancy:         $${expectancy.toFixed(2)} per trade`);
  console.log(`Profit factor:      ${profitFactor.toFixed(2)}  ${profitFactor < 1 ? "❌ losing system" : profitFactor < 1.5 ? "⚠ thin edge" : "✅"}`);
  console.log(`Avg win:            +$${avgWin.toFixed(2)}`);
  console.log(`Avg loss:           $${avgLoss.toFixed(2)}`);
  console.log(`Win/Loss ratio:     ${(avgWin / Math.abs(avgLoss)).toFixed(2)}× ${avgWin / Math.abs(avgLoss) < 1 ? "❌ losers bigger than winners" : "✅"}`);
  console.log(`Required WR @ this ratio for breakeven: ${(100 * Math.abs(avgLoss) / (avgWin + Math.abs(avgLoss))).toFixed(1)}%`);

  console.log(`\n═══ Hold-time bias (do losers run too long?) ═══`);
  const winHold = avg(winB, "holdMinutes");
  const lossHold = avg(lossB, "holdMinutes");
  console.log(`Avg hold for wins:    ${formatHold(winHold)}`);
  console.log(`Avg hold for losses:  ${formatHold(lossHold)}`);
  if (lossHold > winHold * 1.3) {
    console.log(`⚠ Losers held ${(lossHold / winHold).toFixed(1)}× longer than winners — classic "hope-and-hold" tell.`);
  } else if (lossHold < winHold * 0.7) {
    console.log(`✅ Losers cut faster than winners ride — disciplined.`);
  } else {
    console.log(`(Roughly symmetric — hold-time isn't the leak.)`);
  }

  console.log(`\n═══ Position-size bias (sized up on bad ideas?) ═══`);
  const winMargin = avg(winB, "marginUsed");
  const lossMargin = avg(lossB, "marginUsed");
  console.log(`Avg margin on wins:   $${winMargin.toFixed(2)}`);
  console.log(`Avg margin on losses: $${lossMargin.toFixed(2)}`);
  if (lossMargin > winMargin * 1.2) {
    console.log(`⚠ Sizing up on losers (${((lossMargin / winMargin - 1) * 100).toFixed(0)}% bigger) — Kelly violation.`);
  } else if (lossMargin < winMargin * 0.85) {
    console.log(`✅ Smaller positions on losers, bigger on winners.`);
  } else {
    console.log(`(Sizing roughly equal across W/L.)`);
  }

  // Top 10 single disasters by USD
  const sortedLosses = [...losses].sort((a, b) => a.realised - b.realised).slice(0, 10);
  console.log(`\n═══ Top 10 single-trade disasters ═══`);
  console.log(`date         symbol          margin    PnL          held`);
  for (const p of sortedLosses) {
    const date = new Date(p.updateTime).toISOString().slice(5, 16).replace("T", " ");
    const held = formatHold((p.updateTime - p.createTime) / 60_000);
    const margin = deriveMargin(p);
    console.log(`${date}  ${p.symbol.padEnd(16)} $${margin.toFixed(0).padStart(6)}  $${p.realised.toFixed(2).padStart(9)}   ${held}`);
  }

  // Per-symbol profit factor
  type SymStats = { sym: string; n: number; w: number; l: number; pnl: number; sumWin: number; sumLoss: number };
  const bySym = new Map<string, SymStats>();
  for (const p of positions) {
    const s = bySym.get(p.symbol) ?? { sym: p.symbol, n: 0, w: 0, l: 0, pnl: 0, sumWin: 0, sumLoss: 0 };
    s.n++;
    s.pnl += p.realised;
    if (p.realised > 0.5) { s.w++; s.sumWin += p.realised; }
    else if (p.realised < -0.5) { s.l++; s.sumLoss += p.realised; }
    bySym.set(p.symbol, s);
  }
  const sigSyms = [...bySym.values()].filter((s) => s.n >= 3);
  const worstPF = sigSyms
    .map((s) => ({ ...s, pf: s.sumLoss !== 0 ? s.sumWin / Math.abs(s.sumLoss) : Infinity }))
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, 10);
  console.log(`\n═══ Worst symbols (≥3 trades, ranked by net PnL) ═══`);
  console.log(`symbol            n    W   L    PF      net`);
  for (const s of worstPF) {
    const pfStr = isFinite(s.pf) ? s.pf.toFixed(2) : "∞";
    console.log(`${s.sym.padEnd(16)} ${String(s.n).padStart(3)}  ${String(s.w).padStart(3)} ${String(s.l).padStart(3)}   ${pfStr.padStart(5)}   $${s.pnl.toFixed(2).padStart(8)}`);
  }

  // Concentration: how much of total losses comes from top 10% of losing trades?
  const sortedAllLosses = [...losses].sort((a, b) => a.realised - b.realised);
  const top10Cutoff = Math.max(1, Math.floor(sortedAllLosses.length * 0.1));
  const top10Loss = sortedAllLosses.slice(0, top10Cutoff).reduce((a, p) => a + p.realised, 0);
  const concPct = (top10Loss / lossB.pnl) * 100;
  console.log(`\n═══ Loss concentration ═══`);
  console.log(`Top 10% of losing trades (${top10Cutoff} of ${losses.length}) = ${concPct.toFixed(0)}% of total losses ($${top10Loss.toFixed(0)} of $${lossB.pnl.toFixed(0)})`);
  if (concPct > 50) {
    console.log(`⚠ Heavily concentrated — a handful of giant losses cause the damage.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
