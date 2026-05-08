/**
 * On-demand paper portfolio report.
 *
 * Usage:
 *   npx tsx scripts/paper-report.ts          # human-readable to stdout
 *   npx tsx scripts/paper-report.ts --send   # post to Telegram
 */
import { loadPortfolio } from "../src/paper-portfolio.js";
import { sendTelegram } from "../src/clients/telegram.js";

function fmtPx(n: number): string { return n >= 1 ? n.toFixed(4) : n.toFixed(6); }
function fmtR(r: number): string { return (r >= 0 ? "+" : "") + r.toFixed(2) + "R"; }
function fmtUsd(n: number): string { return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2); }

function build(): string {
  const p = loadPortfolio();
  const days = Math.max(1, Math.floor((Date.now() - p.startedAt) / 86_400_000));
  const wins = p.closedTrades.filter((t) => t.totalRMultiple > 0);
  const losses = p.closedTrades.filter((t) => t.totalRMultiple <= 0);
  const totalR = p.closedTrades.reduce((a, t) => a + t.totalRMultiple, 0);
  const pct = ((p.cash - p.initialCash) / p.initialCash) * 100;
  const winR = wins.length > 0 ? wins.reduce((a, t) => a + t.totalRMultiple, 0) / wins.length : 0;
  const lossR = losses.length > 0 ? losses.reduce((a, t) => a + t.totalRMultiple, 0) / losses.length : 0;

  const lines: string[] = [];
  lines.push(`🤖 <b>Claude Paper — Day ${days} report</b>`);
  lines.push(`Book: $${p.cash.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);
  lines.push("");
  lines.push(`<b>Closed: ${p.closedTrades.length}</b> (${wins.length}W/${losses.length}L)`);
  if (p.closedTrades.length > 0) {
    lines.push(`  Total ${fmtR(totalR)}`);
    if (wins.length > 0) lines.push(`  Avg winner ${fmtR(winR)}`);
    if (losses.length > 0) lines.push(`  Avg loser ${fmtR(lossR)}`);
    if (wins.length > 0 && losses.length > 0) {
      const payoff = Math.abs(winR / lossR);
      lines.push(`  Payoff ratio ${payoff.toFixed(2)}`);
    }
  }
  lines.push("");
  lines.push(`<b>Open: ${p.openPositions.length}</b>`);
  for (const pos of p.openPositions) {
    const age = ((Date.now() - pos.openTs) / 86_400_000).toFixed(1);
    lines.push(`  ${pos.asset.padEnd(6)} entry $${fmtPx(pos.entryPrice)} · stop $${fmtPx(pos.currentStop)} · ${age}d · ${(pos.remainingFraction * 100).toFixed(0)}% open`);
  }
  if (p.closedTrades.length > 0) {
    lines.push("");
    lines.push(`<b>Recent closed:</b>`);
    for (const t of p.closedTrades.slice(-10)) {
      lines.push(`  ${t.asset.padEnd(6)} ${t.finalExitReason.padEnd(8)} ${fmtR(t.totalRMultiple)} ${fmtUsd(t.totalPnlUsd)}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const text = build();
  console.log(text.replace(/<[^>]+>/g, ""));   // strip HTML for stdout

  if (process.argv.includes("--send")) {
    const r = await sendTelegram(text, { parse_mode: "HTML" });
    if (!r.ok) console.error(`telegram error: ${r.error}`);
    else console.error(`sent message_id=${r.messageId}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
