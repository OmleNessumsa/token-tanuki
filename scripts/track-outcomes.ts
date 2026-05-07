/**
 * Outcome tracker for the signal log. Runs hourly.
 *
 * For each signal without an outcome:
 *   - Pull MEXC daily candles since signal timestamp.
 *   - Walk bars: did high cross any TP? did low hit stop?
 *   - First event wins. If no event after horizonBars (=7), mark as "horizon"
 *     with R based on close vs entry/stop.
 *
 * Then rewrites the JSONL with updated outcomes.
 *
 * Usage: npx tsx scripts/track-outcomes.ts
 */

import { getFuturesKlines } from "../src/clients/mexc-futures.js";
import { readSignals, writeSignals, type SignalRecord, type SignalOutcome } from "../src/signal-log.js";

const HORIZON_BARS = 7;
const SLEEP_MS = 600;     // be polite to MEXC public API

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function computeOutcome(rec: SignalRecord, candlesSinceSignal: Array<{ t: number; h: number; l: number; c: number }>): SignalOutcome | null {
  if (!rec.stopPrice || !rec.tp1Price) return null;
  if (rec.naturalSide !== "LONG") return null;     // only LONG plans currently
  const entry = rec.entryPrice;
  const stop = rec.stopPrice;
  const initialRisk = entry - stop;
  if (initialRisk <= 0) return null;

  const horizonCutoff = Math.min(candlesSinceSignal.length, HORIZON_BARS);
  for (let i = 0; i < horizonCutoff; i++) {
    const bar = candlesSinceSignal[i]!;
    // Stop check (intra-bar low)
    if (bar.l <= stop) {
      return {
        exitReason: "stop",
        exitPrice: stop,
        exitTs: bar.t,
        rMultiple: -1,
        barsHeld: i + 1,
      };
    }
    // TP checks (intra-bar high) — first hit wins
    if (rec.tp1Price && bar.h >= rec.tp1Price) {
      const r = (rec.tp1Price - entry) / initialRisk;
      return { exitReason: "tp1", exitPrice: rec.tp1Price, exitTs: bar.t, rMultiple: r, barsHeld: i + 1 };
    }
    if (rec.tp2Price && bar.h >= rec.tp2Price) {
      const r = (rec.tp2Price - entry) / initialRisk;
      return { exitReason: "tp2", exitPrice: rec.tp2Price, exitTs: bar.t, rMultiple: r, barsHeld: i + 1 };
    }
    if (rec.tp3Price && bar.h >= rec.tp3Price) {
      const r = (rec.tp3Price - entry) / initialRisk;
      return { exitReason: "tp3", exitPrice: rec.tp3Price, exitTs: bar.t, rMultiple: r, barsHeld: i + 1 };
    }
  }
  // Horizon expiry: close-out at end of horizon
  if (candlesSinceSignal.length >= HORIZON_BARS) {
    const finalBar = candlesSinceSignal[HORIZON_BARS - 1]!;
    const r = (finalBar.c - entry) / initialRisk;
    return { exitReason: "horizon", exitPrice: finalBar.c, exitTs: finalBar.t, rMultiple: r, barsHeld: HORIZON_BARS };
  }
  return null;     // still pending
}

async function main(): Promise<void> {
  const records = readSignals();
  const open = records.filter((r) => r.outcome === null);
  if (open.length === 0) {
    process.stderr.write(`No open signals (total ${records.length}).\n`);
    return;
  }
  process.stderr.write(`Tracking ${open.length} open signal(s) of ${records.length} total...\n`);

  let updated = 0;
  for (const rec of open) {
    try {
      const ageHours = (Date.now() - rec.ts) / 3_600_000;
      if (ageHours < 24) continue;     // need at least 1 daily bar after signal
      const allCandles = await getFuturesKlines(rec.symbol, "Day1", 30);
      const since = allCandles.filter((c) => c.t > rec.ts);
      if (since.length === 0) continue;
      const outcome = computeOutcome(rec, since);
      if (outcome) {
        rec.outcome = outcome;
        updated++;
        process.stderr.write(`  ${rec.symbol.padEnd(18)} ${outcome.exitReason} R=${outcome.rMultiple.toFixed(2)} after ${outcome.barsHeld} bars\n`);
      }
    } catch (err) {
      process.stderr.write(`  ${rec.symbol} err: ${err instanceof Error ? err.message : err}\n`);
    }
    await sleep(SLEEP_MS);
  }
  if (updated > 0) writeSignals(records);
  process.stderr.write(`Updated ${updated} signal(s).\n`);

  // Quick rolling stats — for visibility in logs
  const closed = records.filter((r) => r.outcome !== null);
  if (closed.length > 0) {
    const fired = closed.filter((r) => r.fired);
    const shadow = closed.filter((r) => !r.fired);
    const avgR = (rs: SignalRecord[]) => rs.length === 0 ? 0 : rs.reduce((a, r) => a + (r.outcome?.rMultiple ?? 0), 0) / rs.length;
    process.stderr.write(`\nRolling stats over ${closed.length} closed signal(s):\n`);
    process.stderr.write(`  fired (Stage 2 ✅):  ${fired.length} signals · avg ${avgR(fired).toFixed(3)}R\n`);
    process.stderr.write(`  shadow (Stage 2 ❌): ${shadow.length} signals · avg ${avgR(shadow).toFixed(3)}R\n`);
    if (fired.length >= 5 && shadow.length >= 5) {
      const delta = avgR(fired) - avgR(shadow);
      process.stderr.write(`  delta: ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}R per trade in favor of ${delta >= 0 ? "FIRED (Stage 2 helps)" : "SHADOW (Stage 2 hurts)"}\n`);
    } else {
      process.stderr.write(`  (need ≥5 in each group for meaningful comparison)\n`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
