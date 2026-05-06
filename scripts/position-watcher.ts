/**
 * Position health watcher → Telegram alerts.
 *
 * Monitors every open position and pushes alerts on state TRANSITIONS:
 *   - Liq buffer drops below threshold (5% / 3% / 2%)
 *   - Funding regime worsens (neutral → crowded_long → euphoria)
 *   - Position has no stop-loss configured
 *
 * State file ~/.cryptotrader/position-watch.json prevents repeat-alerting on the
 * same condition; a new alert fires only when the state CHANGES.
 *
 * Runs every 5 min via systemd timer.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getOpenPositions, getStopOrders } from "../src/clients/mexc-private.js";
import { getFuturesTicker, getFundingRate, analyzeFundingRate } from "../src/clients/mexc-futures.js";
import { sendTelegram } from "../src/clients/telegram.js";

const STATE_DIR = process.env.CRYPTOTRADER_STATE_DIR ?? join(homedir(), ".cryptotrader");
const FILE = join(STATE_DIR, "position-watch.json");

type BufferCategory = "safe" | "warning" | "urgent" | "emergency";

interface PositionState {
  positionId: number;
  symbol: string;
  bufferCategory: BufferCategory;
  fundingRegime: string;
  hasSL: boolean;
  lastChecked: number;
}

interface State { positions: Record<string, PositionState>; }

function load(): State {
  if (!existsSync(FILE)) return { positions: {} };
  try { return JSON.parse(readFileSync(FILE, "utf8")) as State; }
  catch { return { positions: {} }; }
}
function save(s: State): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2));
}

function categorizeBuffer(pct: number): BufferCategory {
  if (pct < 2) return "emergency";
  if (pct < 3) return "urgent";
  if (pct < 5) return "warning";
  return "safe";
}

const FUNDING_SEVERITY: Record<string, number> = {
  paid_to_long: 0,
  neutral: 1,
  normal_bull: 2,
  crowded_long: 3,
  euphoria: 4,
};

function sortRank(cat: BufferCategory): number {
  return { emergency: 0, urgent: 1, warning: 2, safe: 3 }[cat];
}

async function main(): Promise<void> {
  const state = load();
  const positions = await getOpenPositions();
  if (positions.length === 0) {
    state.positions = {};
    save(state);
    return;
  }

  const detail = await fetch("https://contract.mexc.com/api/v1/contract/detail").then((r) => r.json()) as { data: Array<{ symbol: string; contractSize: number }> };
  const csMap = new Map(detail.data.map((d) => [d.symbol, d.contractSize ?? 1]));

  const alerts: Array<{ severity: BufferCategory; symbol: string; lines: string[] }> = [];

  for (const p of positions) {
    const ticker = await getFuturesTicker(p.symbol);
    if (!ticker) continue;
    const cs = csMap.get(p.symbol) ?? 1;
    const dir = p.positionType === 1 ? 1 : -1;
    const qty = p.holdVol * cs;
    const pnl = (ticker.lastPrice - p.holdAvgPrice) * qty * dir;
    const liqBufferPct = ((ticker.lastPrice - p.liquidatePrice) / ticker.lastPrice * 100 * dir);
    const bufferCat = categorizeBuffer(liqBufferPct);

    const stopOrders = await getStopOrders(p.symbol);
    const hasSL = stopOrders.some((o) => o.positionId === p.positionId && o.state === 1 && (o.side === 4 || o.side === 2));

    const fundingInfo = await getFundingRate(p.symbol);
    const fundingAnalysis = fundingInfo ? analyzeFundingRate(fundingInfo) : null;
    const fundingRegime = fundingAnalysis?.regime ?? "unknown";

    const asset = p.symbol.replace(/_USDT$/, "").replace(/^TONCOIN$/, "TON");
    const prev = state.positions[p.symbol];

    // Determine which alerts to fire
    const alertLines: string[] = [];
    let severity: BufferCategory = "safe";

    // 1) Buffer alerts — fire when state worsens
    const prevCat = prev?.bufferCategory ?? "safe";
    if (sortRank(bufferCat) < sortRank(prevCat)) {
      // worsened
      const emoji = bufferCat === "emergency" ? "🔴" : bufferCat === "urgent" ? "🚨" : "⚠️";
      const action = bufferCat === "emergency"
        ? "ACT NOW: cut or add margin immediately"
        : bufferCat === "urgent"
          ? "Decide: add margin or cut within minutes"
          : "Consider adding margin to widen liq buffer";
      alertLines.push(`${emoji} <b>Liq buffer ${bufferCat.toUpperCase()}</b> on ${asset}`);
      alertLines.push(`Current $${ticker.lastPrice.toFixed(ticker.lastPrice >= 1 ? 4 : 6)} · Liq $${p.liquidatePrice.toFixed(p.liquidatePrice >= 1 ? 4 : 6)}`);
      alertLines.push(`Buffer: ${liqBufferPct.toFixed(2)}% · PnL $${pnl.toFixed(0)} · Margin $${p.im.toFixed(0)}`);
      alertLines.push(`👉 ${action}`);
      severity = bufferCat;
    }

    // 2) Funding regime worsened
    const prevFundingSev = prev ? (FUNDING_SEVERITY[prev.fundingRegime] ?? 1) : 1;
    const newFundingSev = FUNDING_SEVERITY[fundingRegime] ?? 1;
    if (newFundingSev > prevFundingSev && newFundingSev >= 3) {
      const emoji = fundingRegime === "euphoria" ? "🚨" : "⚠️";
      alertLines.push(`${emoji} <b>Funding ${fundingRegime}</b> on ${asset} — was ${prev?.fundingRegime ?? "fresh"}`);
      if (fundingAnalysis) alertLines.push(fundingAnalysis.description);
      alertLines.push(`👉 Consider partial close — squeeze risk rising`);
      if (sortRank(severity) > sortRank("warning")) severity = "warning";
    }

    // 3) Missing SL — fire once when first detected (don't re-spam if user keeps it off)
    if (!hasSL && (prev === undefined || prev.hasSL === true)) {
      // either new position or SL was just removed
      alertLines.push(`🛑 <b>No stop-loss</b> on ${asset} ($${p.im.toFixed(0)} margin at risk)`);
      alertLines.push(`👉 Set TP/SL → Market SL → trigger price near current`);
      if (sortRank(severity) > sortRank("warning")) severity = "warning";
    }

    if (alertLines.length > 0) {
      alerts.push({ severity, symbol: asset, lines: alertLines });
    }

    state.positions[p.symbol] = {
      positionId: p.positionId,
      symbol: p.symbol,
      bufferCategory: bufferCat,
      fundingRegime,
      hasSL,
      lastChecked: Date.now(),
    };
  }

  // Prune state for closed positions
  const openSymbols = new Set(positions.map((p) => p.symbol));
  for (const sym of Object.keys(state.positions)) {
    if (!openSymbols.has(sym)) delete state.positions[sym];
  }

  save(state);

  if (alerts.length === 0) {
    process.stderr.write("✓ all positions healthy, no transitions\n");
    return;
  }

  // Compose digest message — one Telegram per run, multiple alerts grouped
  alerts.sort((a, b) => sortRank(a.severity) - sortRank(b.severity));
  const lines: string[] = [];
  lines.push(`🛡️ <b>Position health alert</b> (${alerts.length} issue${alerts.length > 1 ? "s" : ""})`);
  lines.push("");
  for (const a of alerts) {
    lines.push(...a.lines);
    lines.push("");
  }
  const result = await sendTelegram(lines.join("\n").trim(), { parse_mode: "HTML" });
  process.stderr.write(result.ok ? `✓ alert sent (${alerts.length} issues)\n` : `✗ ${result.error}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
