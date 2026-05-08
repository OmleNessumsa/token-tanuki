/**
 * Paper-trader pattern analyzer.
 *
 * Joins closed paper trades to their signal records and looks for features
 * that distinguish winners from losers. Reports patterns with material
 * separation (delta in feature distribution between W and L groups).
 *
 * Usage:
 *   npx tsx scripts/paper-analyze.ts          # human-readable to stdout
 *   npx tsx scripts/paper-analyze.ts --send   # post insights to Telegram
 *
 * Designed to run weekly on Sunday 07:00 UTC (cron timer).
 *
 * NOTE: Needs ≥5 winners AND ≥5 losers to produce meaningful insights.
 * Below that threshold it just reports counts and waits for more data.
 */

import { readSignals, type SignalRecord, type SignalFeatures } from "../src/signal-log.js";
import { loadPortfolio, type PaperTrade } from "../src/paper-portfolio.js";
import { sendTelegram } from "../src/clients/telegram.js";

interface JoinedTrade { trade: PaperTrade; signal: SignalRecord; feat: SignalFeatures; }

function joinTrades(): JoinedTrade[] {
  const port = loadPortfolio();
  const sigs = new Map<string, SignalRecord>();
  for (const s of readSignals()) sigs.set(s.id, s);
  const out: JoinedTrade[] = [];
  for (const t of port.closedTrades) {
    const s = sigs.get(t.signalId);
    if (!s || !s.features) continue;     // skip pre-feature-snapshot trades
    out.push({ trade: t, signal: s, feat: s.features });
  }
  return out;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pct(xs: readonly boolean[]): number {
  return xs.length === 0 ? 0 : xs.filter(Boolean).length / xs.length;
}

interface Insight { feature: string; lossValue: string; winValue: string; commentary: string; }

function compareNumeric<T>(name: string, losers: T[], winners: T[], extract: (t: T) => number | null, fmt: (n: number) => string = (n) => n.toFixed(2), threshold = 0.15): Insight | null {
  const lossValues = losers.map(extract).filter((x): x is number => x !== null && Number.isFinite(x));
  const winValues = winners.map(extract).filter((x): x is number => x !== null && Number.isFinite(x));
  if (lossValues.length < 3 || winValues.length < 3) return null;
  const lossMean = mean(lossValues);
  const winMean = mean(winValues);
  const denom = Math.max(Math.abs(lossMean), Math.abs(winMean), 1);
  const relDelta = Math.abs(winMean - lossMean) / denom;
  if (relDelta < threshold) return null;
  const direction = winMean > lossMean ? "↑ in winners" : "↓ in winners";
  return {
    feature: name,
    lossValue: fmt(lossMean),
    winValue: fmt(winMean),
    commentary: `${direction} (gap ${(relDelta * 100).toFixed(0)}%)`,
  };
}

function compareBoolean<T>(name: string, losers: T[], winners: T[], extract: (t: T) => boolean): Insight | null {
  const lossPct = pct(losers.map(extract));
  const winPct = pct(winners.map(extract));
  if (Math.abs(winPct - lossPct) < 0.2) return null;     // need 20pp gap
  return {
    feature: name,
    lossValue: `${(lossPct * 100).toFixed(0)}% of L`,
    winValue: `${(winPct * 100).toFixed(0)}% of W`,
    commentary: winPct > lossPct ? "more common in winners" : "more common in losers",
  };
}

function compareCategorical<T>(name: string, losers: T[], winners: T[], extract: (t: T) => string): Insight[] {
  const loss: Record<string, number> = {};
  const win: Record<string, number> = {};
  for (const x of losers) { const v = extract(x); loss[v] = (loss[v] ?? 0) + 1; }
  for (const x of winners) { const v = extract(x); win[v] = (win[v] ?? 0) + 1; }
  const cats = new Set([...Object.keys(loss), ...Object.keys(win)]);
  const out: Insight[] = [];
  for (const c of cats) {
    const lpct = (loss[c] ?? 0) / Math.max(losers.length, 1);
    const wpct = (win[c] ?? 0) / Math.max(winners.length, 1);
    if (Math.abs(wpct - lpct) < 0.25) continue;
    out.push({
      feature: `${name}=${c}`,
      lossValue: `${(lpct * 100).toFixed(0)}% of L`,
      winValue: `${(wpct * 100).toFixed(0)}% of W`,
      commentary: wpct > lpct ? "more common in winners" : "more common in losers",
    });
  }
  return out;
}

function buildReport(): string {
  const joined = joinTrades();
  const losers = joined.filter((j) => j.trade.totalRMultiple < 0);
  const winners = joined.filter((j) => j.trade.totalRMultiple > 0);
  const lines: string[] = [];
  lines.push(`📚 <b>Claude Paper — pattern review</b>`);
  lines.push(`Closed trades met features: ${joined.length} (${winners.length}W / ${losers.length}L)`);
  lines.push("");

  if (winners.length < 5 || losers.length < 5) {
    lines.push(`<i>Niet genoeg data voor patronen — minimum 5 in elk (W/L). Wacht op meer trades.</i>`);
    if (joined.length > 0) {
      lines.push("");
      lines.push(`Lifetime: avg R = ${(joined.reduce((a, j) => a + j.trade.totalRMultiple, 0) / joined.length).toFixed(2)}`);
    }
    return lines.join("\n");
  }

  // Numeric features
  const insights: Insight[] = [];
  const numNcomposite = compareNumeric("composite", losers, winners, (j) => j.signal.composite, (n) => n.toFixed(0));
  if (numNcomposite) insights.push(numNcomposite);
  const numFunding = compareNumeric("fundingRatePct", losers, winners, (j) => j.feat.fundingRatePct, (n) => n.toFixed(4) + "%");
  if (numFunding) insights.push(numFunding);
  const numTrendT = compareNumeric("trendTemplateRatio", losers, winners, (j) => j.feat.trendTemplateRatio, (n) => (n * 100).toFixed(0) + "%");
  if (numTrendT) insights.push(numTrendT);
  const numRsi = compareNumeric("rsi1h", losers, winners, (j) => j.feat.rsi1h);
  if (numRsi) insights.push(numRsi);
  for (const tf of ["5m", "15m", "1h", "4h", "1d"]) {
    const s = compareNumeric(`tfScore.${tf}`, losers, winners, (j) => j.feat.tfScores[tf] ?? null, (n) => n.toFixed(0));
    if (s) insights.push(s);
  }

  // Boolean
  const breakoutI = compareBoolean("hasBreakout", losers, winners, (j) => j.feat.hasBreakout);
  if (breakoutI) insights.push(breakoutI);
  const volI = compareBoolean("hasVolumeConfirmation", losers, winners, (j) => j.feat.hasVolumeConfirmation);
  if (volI) insights.push(volI);
  const stage2I = compareBoolean("stage2", losers, winners, (j) => j.signal.stage2 === true);
  if (stage2I) insights.push(stage2I);

  // Categorical
  insights.push(...compareCategorical("fundingRegime", losers, winners, (j) => j.feat.fundingRegime ?? "unknown"));
  insights.push(...compareCategorical("intermarketRegime", losers, winners, (j) => j.feat.intermarketRegime));
  insights.push(...compareCategorical("dayOfWeek", losers, winners, (j) => `d${j.feat.dayOfWeek}`));
  insights.push(...compareCategorical("htfDirection", losers, winners, (j) => j.signal.htfDirection));
  insights.push(...compareCategorical("ltfDirection", losers, winners, (j) => j.signal.ltfDirection));

  if (insights.length === 0) {
    lines.push(`<i>Geen statistisch interessante features gevonden — winners en losers ogen vergelijkbaar.</i>`);
  } else {
    lines.push(`<b>Patronen gevonden:</b>`);
    for (const i of insights.slice(0, 10)) {
      lines.push(`  • <code>${i.feature}</code>: L=${i.lossValue} · W=${i.winValue} — ${i.commentary}`);
    }
  }

  // Lifetime stats
  lines.push("");
  const totalR = joined.reduce((a, j) => a + j.trade.totalRMultiple, 0);
  const totalPnl = joined.reduce((a, j) => a + j.trade.totalPnlUsd, 0);
  lines.push(`<b>Aggregate:</b> avg ${(totalR / joined.length).toFixed(2)}R · totaal ${totalR >= 0 ? "+" : ""}${totalR.toFixed(1)}R · ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(0)}`);

  return lines.join("\n");
}

async function main(): Promise<void> {
  const text = buildReport();
  console.log(text.replace(/<[^>]+>/g, ""));
  if (process.argv.includes("--send")) {
    const r = await sendTelegram(text, { parse_mode: "HTML" });
    if (!r.ok) console.error(`telegram error: ${r.error}`);
    else console.error(`sent message_id=${r.messageId}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
