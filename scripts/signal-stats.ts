/**
 * Tenant signal-stats — wins/losses + R-multiples (and $ amounts) for any
 * tenant's signals.jsonl. Reads $CRYPTOTRADER_STATE_DIR.
 *
 * Usage:
 *   CRYPTOTRADER_STATE_DIR=~/.cryptotrader-roy   npx tsx scripts/signal-stats.ts
 *   CRYPTOTRADER_STATE_DIR=~/.cryptotrader-claude npx tsx scripts/signal-stats.ts
 *   npx tsx scripts/signal-stats.ts --since 2026-05-08 --risk-usd 36
 *
 * `--risk-usd` (default 36): dollar amount risked per signal at 1R. Matches
 * Claude paper-trader convention of $50 notional × 20× with ~3.6% stop.
 */
import { readSignals, type SignalRecord } from "../src/signal-log.js";

interface Stats {
  count: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalR: number;
  bestR: number;
  worstR: number;
  bestSym: string;
  worstSym: string;
}

function bucket(records: SignalRecord[]): Stats {
  const s: Stats = {
    count: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    totalR: 0,
    bestR: 0,
    worstR: 0,
    bestSym: "",
    worstSym: "",
  };
  for (const r of records) {
    const o = r.outcome;
    if (!o) continue;
    s.count++;
    s.totalR += o.rMultiple;
    if (o.rMultiple > 0.05) s.wins++;
    else if (o.rMultiple < -0.05) s.losses++;
    else s.breakeven++;
    if (o.rMultiple > s.bestR) {
      s.bestR = o.rMultiple;
      s.bestSym = r.symbol;
    }
    if (o.rMultiple < s.worstR) {
      s.worstR = o.rMultiple;
      s.worstSym = r.symbol;
    }
  }
  return s;
}

function dollar(usd: number): string {
  return (usd >= 0 ? "+$" : "-$") + Math.abs(usd).toFixed(2);
}

function fmt(s: Stats, riskUsd: number): string[] {
  if (s.count === 0) return ["(no closed signals)"];
  const winRate = ((s.wins / s.count) * 100).toFixed(1);
  const totalUsd = s.totalR * riskUsd;
  const avgUsd = totalUsd / s.count;
  return [
    `closed:    ${s.count}`,
    `wins:      ${s.wins} (${winRate}%)`,
    `losses:    ${s.losses}`,
    `break-even:${s.breakeven}`,
    `total:     ${s.totalR >= 0 ? "+" : ""}${s.totalR.toFixed(2)}R   (${dollar(totalUsd)})`,
    `avg/trade: ${(s.totalR / s.count).toFixed(3)}R   (${dollar(avgUsd)})`,
    `best:      +${s.bestR.toFixed(2)}R (${s.bestSym})   ${dollar(s.bestR * riskUsd)}`,
    `worst:     ${s.worstR.toFixed(2)}R (${s.worstSym})   ${dollar(s.worstR * riskUsd)}`,
  ];
}

function main(): void {
  const args = process.argv.slice(2);
  let sinceTs = 0;
  let riskUsd = 36;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since") sinceTs = Date.parse(args[++i] ?? "");
    else if (args[i] === "--risk-usd") riskUsd = Number(args[++i] ?? "36");
  }

  const all = readSignals().filter((r) => r.ts >= sinceTs);
  if (all.length === 0) {
    console.log("No signals in window.");
    return;
  }

  const fired = all.filter((r) => r.fired);
  const shadow = all.filter((r) => !r.fired);

  const stateDir = process.env.CRYPTOTRADER_STATE_DIR ?? "(default)";
  const earliest = new Date(Math.min(...all.map((r) => r.ts))).toISOString().slice(0, 10);
  const latest = new Date(Math.max(...all.map((r) => r.ts))).toISOString().slice(0, 10);

  console.log(`═══ Signal stats — ${stateDir} ═══`);
  console.log(`Window:        ${earliest} → ${latest}`);
  console.log(`Total signals: ${all.length}  (fired ${fired.length}, shadow ${shadow.length})`);
  console.log(`Risk per trade: $${riskUsd.toFixed(2)} per 1R`);

  console.log(`\n── FIRED (Stage 2 ✅, real trade plan) ──`);
  for (const line of fmt(bucket(fired), riskUsd)) console.log(line);

  console.log(`\n── SHADOW (Stage 2 ❌, gated to FLAT) ──`);
  for (const line of fmt(bucket(shadow), riskUsd)) console.log(line);

  const f = bucket(fired);
  const s = bucket(shadow);
  if (f.count >= 5 && s.count >= 5) {
    const delta = f.totalR / f.count - s.totalR / s.count;
    const verdict = delta >= 0 ? "FIRED beats SHADOW (Stage 2 helps)" : "SHADOW beats FIRED (Stage 2 hurts)";
    console.log(`\n── Stage 2 verdict ──`);
    console.log(`Δ avg R: ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}R per trade — ${verdict}`);
  } else {
    console.log(`\n(need ≥5 closed in each bucket for Stage 2 verdict)`);
  }

  const wins = fired.filter((r) => r.outcome && r.outcome.rMultiple > 0.05)
    .sort((a, b) => (b.outcome?.rMultiple ?? 0) - (a.outcome?.rMultiple ?? 0));
  const losses = fired.filter((r) => r.outcome && r.outcome.rMultiple < -0.05)
    .sort((a, b) => (a.outcome?.rMultiple ?? 0) - (b.outcome?.rMultiple ?? 0));
  if (wins.length > 0) {
    console.log(`\n── Fired wins (${wins.length}) ──`);
    for (const r of wins.slice(0, 5)) {
      const pnl = (r.outcome!.rMultiple) * riskUsd;
      console.log(`  ${r.symbol.padEnd(16)} +${r.outcome!.rMultiple.toFixed(2)}R  ${dollar(pnl)}  ${r.outcome!.exitReason}`);
    }
  }
  if (losses.length > 0) {
    console.log(`\n── Fired losses (${losses.length}) ──`);
    for (const r of losses.slice(0, 5)) {
      const pnl = (r.outcome!.rMultiple) * riskUsd;
      console.log(`  ${r.symbol.padEnd(16)} ${r.outcome!.rMultiple.toFixed(2)}R  ${dollar(pnl)}  ${r.outcome!.exitReason}`);
    }
  }
}

main();
