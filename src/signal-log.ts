/**
 * Append-only signal log — captures every alert sent + every signal that
 * WOULD have fired but was suppressed by the Stage 2 gate (shadow log).
 *
 * Used by the forward-test outcome tracker to compute realized expectancy
 * per group (fired vs shadowed) over time, answering "does Stage 2 actually
 * help in the live market?".
 *
 * Storage: JSONL at $CRYPTOTRADER_STATE_DIR/signals.jsonl (default ~/.cryptotrader/).
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.CRYPTOTRADER_STATE_DIR ?? join(homedir(), ".cryptotrader");
const LOG_FILE = join(STATE_DIR, "signals.jsonl");

export interface SignalRecord {
  /** unique id: `${symbol}-${ts}` so duplicate suppression is cheap. */
  id: string;
  ts: number;
  symbol: string;          // e.g. "ICP_USDT"
  asset: string;           // e.g. "ICP"
  /** Side BEFORE Stage 2 gate (what the strategy "wanted" to do). */
  naturalSide: "LONG" | "SHORT" | "FLAT";
  /** Side AFTER Stage 2 gate. If naturalSide=LONG and side=FLAT, signal was shadowed. */
  side: "LONG" | "SHORT" | "FLAT";
  fired: boolean;          // true = sent to Telegram; false = shadow-only
  shadowReason: string | null;  // e.g. "stage2-gated"
  composite: number;
  stage2: boolean | null;
  aligned: boolean;
  htfDirection: string;
  ltfDirection: string;
  /** Snapshot of price + plan at the moment of signal generation. */
  entryPrice: number;
  stopPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  tp3Price: number | null;
  /** Realized outcome — populated later by track-outcomes.ts. */
  outcome: SignalOutcome | null;
}

export interface SignalOutcome {
  /** First event hit: "tp1" / "tp2" / "tp3" / "stop" / "horizon" (7d expired). */
  exitReason: "tp1" | "tp2" | "tp3" | "stop" | "horizon";
  exitPrice: number;
  exitTs: number;
  /** Realized R-multiple: profit / (entry - stop). */
  rMultiple: number;
  /** Bars elapsed (in MEXC daily candles) from signal to exit. */
  barsHeld: number;
}

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

export function appendSignal(rec: Omit<SignalRecord, "id">): void {
  ensureDir();
  const id = `${rec.symbol}-${rec.ts}`;
  const full: SignalRecord = { id, ...rec };
  appendFileSync(LOG_FILE, JSON.stringify(full) + "\n");
}

export function readSignals(): SignalRecord[] {
  if (!existsSync(LOG_FILE)) return [];
  const body = readFileSync(LOG_FILE, "utf8");
  const out: SignalRecord[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as SignalRecord); }
    catch { /* skip corrupted line */ }
  }
  return out;
}

/** Rewrite the entire log (used by outcome tracker after updating records). */
export function writeSignals(records: readonly SignalRecord[]): void {
  ensureDir();
  const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  writeFileSync(LOG_FILE, body);
}

export const SIGNAL_LOG_PATH = LOG_FILE;
