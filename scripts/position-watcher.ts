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
import { getFuturesTicker, getFundingRate, analyzeFundingRate, getFuturesKlines } from "../src/clients/mexc-futures.js";
import { atr, swings } from "../src/analysis/indicators.js";
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
  /** Timestamp of last alert per channel — drives cooldowns to avoid spam */
  lastAlertedBuffer?: number;
  lastAlertedFunding?: number;
  lastAlertedNoSL?: number;
  /** Buffer % at the moment of the last alert — used to suppress notifications when the threat is unchanged. */
  lastAlertedBufferPct?: number;
}

interface State { positions: Record<string, PositionState>; }

/** Cooldown per severity — time before the SAME category can re-alert if buffer is also materially worse. */
const COOLDOWN_MS: Record<BufferCategory, number> = {
  safe: Infinity,
  warning: 12 * 3600_000,     // 12 hours — informational
  urgent: 2 * 3600_000,       // 2 hours — actionable
  emergency: 1 * 3600_000,    // 1 hour — act now (still re-fires only if buffer drops further)
};
/** Within the same category, only re-alert if buffer dropped at least this much since last alert (in pp). */
const REALERT_BUFFER_DROP_PP = 0.5;
const FUNDING_COOLDOWN_MS = 12 * 3600_000;  // 12 hours
const NO_SL_COOLDOWN_MS = 24 * 3600_000;    // 24 hours

function load(): State {
  if (!existsSync(FILE)) return { positions: {} };
  try { return JSON.parse(readFileSync(FILE, "utf8")) as State; }
  catch { return { positions: {} }; }
}
function save(s: State): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2));
}

/**
 * Categorize liq buffer with HYSTERESIS — to escape a category, you need to
 * cross the boundary by 1pp. Avoids ping-ponging when buffer oscillates around
 * a threshold (e.g. TAO going 4.78 → 5.00 → 4.92 firing 2x).
 */
function categorizeBuffer(pct: number, prev: BufferCategory): BufferCategory {
  // Worsening direction: strict thresholds
  // Improving direction: needs +1pp clear of the threshold
  const inEmergency = pct < 2 || (prev === "emergency" && pct < 3);
  if (inEmergency) return "emergency";
  const inUrgent = pct < 3 || (prev === "urgent" && pct < 4);
  if (inUrgent) return "urgent";
  const inWarning = pct < 5 || (prev === "warning" && pct < 6);
  if (inWarning) return "warning";
  return "safe";
}

/**
 * Suggested stop-loss for an OPEN position. Takes the tighter of:
 *   - structure-based: most recent swing low/high + 0.5×ATR buffer
 *   - ATR-based: current price ± 2×ATR
 * Capped to fit inside liquidation budget (90% of liq distance).
 *
 * For a LONG that's already in profit, suggests at minimum break-even.
 */
async function suggestStopLoss(
  symbol: string,
  side: "LONG" | "SHORT",
  entryPrice: number,
  currentPrice: number,
  liqPrice: number,
): Promise<{ price: number; rationale: string } | null> {
  const candles = await getFuturesKlines(symbol, "Min60", 100);
  if (candles.length < 20) return null;
  const atrSeries = atr(candles, 14);
  const lastAtr = atrSeries[atrSeries.length - 1] ?? 0;
  if (lastAtr <= 0) return null;

  const sw = swings(candles, 3);
  const lastSwingLow = [...sw].reverse().find((s) => s.kind === "low")?.price ?? null;
  const lastSwingHigh = [...sw].reverse().find((s) => s.kind === "high")?.price ?? null;

  const inProfit = side === "LONG" ? currentPrice > entryPrice : currentPrice < entryPrice;
  const liqDist = Math.abs(currentPrice - liqPrice);
  const safeMaxDist = liqDist * 0.9;

  let candidates: Array<{ price: number; label: string }> = [];
  if (side === "LONG") {
    candidates.push({ price: currentPrice - 2 * lastAtr, label: "2×ATR" });
    if (lastSwingLow !== null && lastSwingLow < currentPrice) {
      candidates.push({ price: lastSwingLow - 0.5 * lastAtr, label: "swing low − ATR/2" });
    }
    if (inProfit) candidates.push({ price: entryPrice, label: "break-even" });
    // Tightest (= closest to current, but not too tight) wins
    candidates.sort((a, b) => b.price - a.price);
  } else {
    candidates.push({ price: currentPrice + 2 * lastAtr, label: "2×ATR" });
    if (lastSwingHigh !== null && lastSwingHigh > currentPrice) {
      candidates.push({ price: lastSwingHigh + 0.5 * lastAtr, label: "swing high + ATR/2" });
    }
    if (inProfit) candidates.push({ price: entryPrice, label: "break-even" });
    candidates.sort((a, b) => a.price - b.price);
  }

  // Pick the candidate with the smallest distance to current that still fits within liq buffer
  for (const c of candidates) {
    const dist = Math.abs(currentPrice - c.price);
    if (dist <= safeMaxDist) return { price: c.price, rationale: c.label };
  }
  // None fit → cap at 80% of liq distance
  const cappedPrice = side === "LONG" ? currentPrice - safeMaxDist * 0.9 : currentPrice + safeMaxDist * 0.9;
  return { price: cappedPrice, rationale: "liq-buffer cap (no structure stop fits)" };
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
    const prev = state.positions[p.symbol];
    const bufferCat = categorizeBuffer(liqBufferPct, prev?.bufferCategory ?? "safe");

    const stopOrders = await getStopOrders(p.symbol);
    const hasSL = stopOrders.some((o) => o.positionId === p.positionId && o.state === 1 && (o.side === 4 || o.side === 2));

    const fundingInfo = await getFundingRate(p.symbol);
    const fundingAnalysis = fundingInfo ? analyzeFundingRate(fundingInfo) : null;
    const fundingRegime = fundingAnalysis?.regime ?? "unknown";

    const asset = p.symbol.replace(/_USDT$/, "").replace(/^TONCOIN$/, "TON");
    const now = Date.now();

    // Determine which alerts to fire
    const alertLines: string[] = [];
    let severity: BufferCategory = "safe";
    let firedBuffer = false;
    let firedFunding = false;
    let firedNoSL = false;

    // 1) Buffer alerts — fire on:
    //    (a) worsening transition (warning → urgent → emergency)
    //    (b) buffer dropped by REALERT_BUFFER_DROP_PP since last alert AND cooldown elapsed
    // Otherwise stay silent (avoids ping-pong spam when buffer hovers in the same band).
    const prevCat = prev?.bufferCategory ?? "safe";
    const worsened = sortRank(bufferCat) < sortRank(prevCat);
    const cooldownMs = COOLDOWN_MS[bufferCat];
    const elapsed = !prev?.lastAlertedBuffer || (now - prev.lastAlertedBuffer) >= cooldownMs;
    const bufferDroppedEnough = prev?.lastAlertedBufferPct === undefined ||
      (prev.lastAlertedBufferPct - liqBufferPct) >= REALERT_BUFFER_DROP_PP;
    const shouldFireBuffer = bufferCat !== "safe" && (worsened || (elapsed && bufferDroppedEnough));

    if (shouldFireBuffer) {
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
      firedBuffer = true;
    }

    // 2) Funding regime worsened — alert max once per 12h
    const prevFundingSev = prev ? (FUNDING_SEVERITY[prev.fundingRegime] ?? 1) : 1;
    const newFundingSev = FUNDING_SEVERITY[fundingRegime] ?? 1;
    const fundingWorsened = newFundingSev > prevFundingSev && newFundingSev >= 3;
    const fundingCooldownElapsed = !prev?.lastAlertedFunding || (now - prev.lastAlertedFunding) >= FUNDING_COOLDOWN_MS;
    if (fundingWorsened && fundingCooldownElapsed) {
      const emoji = fundingRegime === "euphoria" ? "🚨" : "⚠️";
      alertLines.push(`${emoji} <b>Funding ${fundingRegime}</b> on ${asset} — was ${prev?.fundingRegime ?? "fresh"}`);
      if (fundingAnalysis) alertLines.push(fundingAnalysis.description);
      alertLines.push(`👉 Consider partial close — squeeze risk rising`);
      if (sortRank(severity) > sortRank("warning")) severity = "warning";
      firedFunding = true;
    }

    // 3) Missing SL — first detection OR every 24h reminder
    const noSlNew = !hasSL && (prev === undefined || prev.hasSL === true);
    const noSlReminder = !hasSL && prev?.hasSL === false && (!prev.lastAlertedNoSL || (now - prev.lastAlertedNoSL) >= NO_SL_COOLDOWN_MS);
    if (noSlNew || noSlReminder) {
      const side = dir === 1 ? "LONG" : "SHORT";
      const suggestion = await suggestStopLoss(p.symbol, side, p.holdAvgPrice, ticker.lastPrice, p.liquidatePrice);
      alertLines.push(`🛑 <b>No stop-loss</b> on ${asset} ($${p.im.toFixed(0)} margin at risk)`);
      if (suggestion) {
        const distPct = Math.abs(suggestion.price - ticker.lastPrice) / ticker.lastPrice * 100;
        const dec = suggestion.price >= 1 ? (suggestion.price >= 1000 ? 2 : 4) : 6;
        alertLines.push(`👉 Suggested SL: <b>$${suggestion.price.toFixed(dec)}</b> (${distPct.toFixed(2)}% ${side === "LONG" ? "below" : "above"}, ${suggestion.rationale})`);
      } else {
        alertLines.push(`👉 Set TP/SL → Market SL → trigger near current`);
      }
      if (sortRank(severity) > sortRank("warning")) severity = "warning";
      firedNoSL = true;
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
      lastChecked: now,
      lastAlertedBuffer: firedBuffer ? now : prev?.lastAlertedBuffer,
      lastAlertedBufferPct: firedBuffer ? liqBufferPct : prev?.lastAlertedBufferPct,
      lastAlertedFunding: firedFunding ? now : prev?.lastAlertedFunding,
      lastAlertedNoSL: firedNoSL ? now : prev?.lastAlertedNoSL,
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
