/**
 * MEXC live trading history stats — wins/losses, win rate, total realized PnL.
 *
 * Usage:
 *   npx tsx scripts/mexc-history.ts            # last ~500 closed positions
 *   npx tsx scripts/mexc-history.ts SOL_USDT   # filter by symbol
 *   npx tsx scripts/mexc-history.ts --pages 10 # more history
 */
import { getHistoryPositions, type MexcHistoryPosition } from "../src/clients/mexc-private.js";

interface Stats {
  count: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalPnl: number;
  bestPnl: number;
  worstPnl: number;
  bestSymbol: string;
  worstSymbol: string;
}

function bucket(positions: MexcHistoryPosition[]): Stats {
  const s: Stats = {
    count: positions.length,
    wins: 0,
    losses: 0,
    breakeven: 0,
    totalPnl: 0,
    bestPnl: 0,
    worstPnl: 0,
    bestSymbol: "",
    worstSymbol: "",
  };
  for (const p of positions) {
    s.totalPnl += p.realised;
    if (p.realised > 0.01) s.wins++;
    else if (p.realised < -0.01) s.losses++;
    else s.breakeven++;
    if (p.realised > s.bestPnl) {
      s.bestPnl = p.realised;
      s.bestSymbol = p.symbol;
    }
    if (p.realised < s.worstPnl) {
      s.worstPnl = p.realised;
      s.worstSymbol = p.symbol;
    }
  }
  return s;
}

function fmt(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

async function main() {
  const args = process.argv.slice(2);
  let symbol: string | undefined;
  let pages = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pages") pages = Number(args[++i]);
    else if (args[i] && !args[i]?.startsWith("--")) symbol = args[i];
  }

  console.log(`Fetching MEXC closed positions${symbol ? ` for ${symbol}` : ""} (${pages} page(s))...`);
  const positions = await getHistoryPositions({ symbol, pages });
  if (positions.length === 0) {
    console.log("No closed positions found.");
    return;
  }

  const sorted = [...positions].sort((a, b) => b.updateTime - a.updateTime);
  const oldest = new Date(sorted[sorted.length - 1]!.updateTime).toISOString().slice(0, 10);
  const newest = new Date(sorted[0]!.updateTime).toISOString().slice(0, 10);

  const all = bucket(positions);
  const winRate = ((all.wins / all.count) * 100).toFixed(1);
  const avgPnl = all.totalPnl / all.count;

  console.log(`\n═══ MEXC closed positions (${oldest} → ${newest}) ═══`);
  console.log(`Total trades:    ${all.count}`);
  console.log(`Wins:            ${all.wins} (${winRate}%)`);
  console.log(`Losses:          ${all.losses}`);
  console.log(`Break-even:      ${all.breakeven}`);
  console.log(`Total realized:  $${fmt(all.totalPnl)}`);
  console.log(`Avg per trade:   $${fmt(avgPnl)}`);
  console.log(`Best trade:      $${fmt(all.bestPnl)}  (${all.bestSymbol})`);
  console.log(`Worst trade:     $${fmt(all.worstPnl)}  (${all.worstSymbol})`);

  const bySymbol = new Map<string, MexcHistoryPosition[]>();
  for (const p of positions) {
    const arr = bySymbol.get(p.symbol) ?? [];
    arr.push(p);
    bySymbol.set(p.symbol, arr);
  }
  const rows = [...bySymbol.entries()]
    .map(([sym, list]) => ({ sym, ...bucket(list) }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  console.log(`\n═══ Per symbol ═══`);
  console.log("symbol           trades  W   L   pnl");
  for (const r of rows) {
    console.log(
      `${r.sym.padEnd(16)} ${String(r.count).padStart(5)}  ${String(r.wins).padStart(3)} ${String(r.losses).padStart(3)}   $${fmt(r.totalPnl)}`,
    );
  }

  console.log(`\n═══ Last 10 closed ═══`);
  for (const p of sorted.slice(0, 10)) {
    const date = new Date(p.updateTime).toISOString().slice(5, 16).replace("T", " ");
    const side = p.positionType === 1 ? "L" : "S";
    const tag = p.realised > 0.01 ? "W" : p.realised < -0.01 ? "L" : "B";
    console.log(
      `${date}  ${p.symbol.padEnd(16)} ${side} ${p.leverage}x  $${fmt(p.realised).padStart(8)}  ${tag}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
