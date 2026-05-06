/**
 * Interactive Telegram bot — polls getUpdates, handles commands + button taps.
 *
 * Commands:
 *   /start       — welcome + main menu
 *   /positions   — live position report
 *   /scan        — prompt for symbol → analyze
 *   /help        — show commands
 *
 * Inline buttons: tap a coin in any message → bot sends full trade card.
 *
 * Per-chat conversation state for prompts (e.g. "what symbol?")
 */

import { config } from "./config.js";
import { fetchJson } from "./http.js";
import { sendTelegram } from "./clients/telegram.js";
import { analyzeFutures } from "./analyze-futures.js";
import { generateTradePlan } from "./analysis/trade-plan.js";
import { getOpenPositions } from "./clients/mexc-private.js";
import { getFuturesTicker } from "./clients/mexc-futures.js";

type ChatState =
  | { kind: "idle" }
  | { kind: "awaiting_scan_symbol"; ts: number };

const chatState = new Map<number, ChatState>();
const STATE_TTL_MS = 5 * 60_000;

interface TgUser { id: number; first_name?: string; username?: string; }
interface TgChat { id: number; type: string; }
interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; date: number; text?: string; }
interface TgCallback { id: string; from: TgUser; message?: TgMessage; data: string; }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback; }
interface GetUpdatesResp { ok: boolean; result: TgUpdate[]; }

interface InlineKeyboardButton { text: string; callback_data?: string; }
interface ReplyMarkup { inline_keyboard: InlineKeyboardButton[][]; }

async function tgCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return fetchJson<T>(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await tgCall("answerCallbackQuery", { callback_query_id: callbackId, text }).catch(() => undefined);
}

async function sendKbd(chatId: number, text: string, kbd: ReplyMarkup): Promise<void> {
  await tgCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: kbd,
  }).catch((e: unknown) => log(`sendKbd error: ${e}`));
}

function log(msg: string): void {
  process.stderr.write(`[bot ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

function fmtPx(n: number): string {
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

const MAIN_MENU: ReplyMarkup = {
  inline_keyboard: [
    [{ text: "📊 Positions", callback_data: "cmd:positions" }, { text: "🔎 Scan symbol", callback_data: "cmd:scan" }],
    [{ text: "🔥 Top setups", callback_data: "cmd:top" }, { text: "💡 Help", callback_data: "cmd:help" }],
  ],
};

async function sendMainMenu(chatId: number): Promise<void> {
  await sendKbd(chatId, "🤖 <b>Cryptotrader bot</b>\n\nWat wil je doen?", MAIN_MENU);
}

async function sendHelp(chatId: number): Promise<void> {
  const text = [
    "<b>Commands</b>",
    "/positions — live PnL + actions per open trade",
    "/scan — analyseer een symbol (prompt)",
    "/top — toon huidige top setups",
    "",
    "<b>Of typ direct een symbol:</b>",
    "<code>BCH</code> · <code>SOL</code> · <code>FARTCOIN</code> — krijg de trade card",
    "",
    "<b>Push alerts</b>",
    "Je krijgt vanzelf:",
    "• Position report elke 30 min (via cron — nog te activeren)",
    "• Nieuwe high-conviction setups zodra ze verschijnen",
  ].join("\n");
  await sendKbd(chatId, text, MAIN_MENU);
}

/** Build a trade card formatted for Telegram, with retry-with-stop button. */
async function buildTradeCard(asset: string): Promise<{ text: string; keyboard: ReplyMarkup } | null> {
  const a = await analyzeFutures(asset);
  if (!a.perpSymbol) {
    return {
      text: `❌ <b>${asset}</b> — geen MEXC perp listing gevonden`,
      keyboard: { inline_keyboard: [[{ text: "« Menu", callback_data: "cmd:start" }]] },
    };
  }
  const plan = generateTradePlan({ analysis: a, accountUsd: 10000, leverage: 20, riskPctPerTrade: 1 });
  const lines: string[] = [];
  const sideEmoji = a.verdict.side === "LONG" ? "🟢" : a.verdict.side === "SHORT" ? "🔴" : "⚪";
  lines.push(`${sideEmoji} <b>${asset}</b> · ${a.verdict.side} ${a.verdict.confidence} · composite ${a.confluence.score}/100`);
  if (a.ticker) {
    const ch24 = a.ticker.riseFallRate * 100;
    const sign = ch24 >= 0 ? "+" : "";
    lines.push(`Price $${fmtPx(a.ticker.lastPrice)} · 24h ${sign}${ch24.toFixed(2)}%`);
  }
  if (a.funding) lines.push(`Funding: ${a.funding.regime} (${(a.funding.ratePerCycle * 100).toFixed(4)}%/cycle)`);
  const dirGlyph = (d: string) => d === "bullish" ? "▲" : d === "bearish" ? "▼" : "=";
  lines.push(`MTF: ${a.timeframes.map((t) => `${t.timeframe}${dirGlyph(t.direction)}${t.chart.score}`).join(" ")}`);

  if (plan && a.ticker) {
    const current = a.ticker.lastPrice;
    const deltaPct = ((current - plan.entry.ideal) / plan.entry.ideal) * 100;
    const status = plan.side === "LONG"
      ? (deltaPct > 1.5 ? "🚨 LATE" : deltaPct > 0.5 ? "⚠ chase" : deltaPct >= -0.5 ? "✅ IN ZONE" : "💎 EARLY")
      : (deltaPct < -1.5 ? "🚨 LATE" : deltaPct < -0.5 ? "⚠ chase" : deltaPct <= 0.5 ? "✅ IN ZONE" : "💎 EARLY");
    const sign = deltaPct >= 0 ? "+" : "";
    lines.push("");
    lines.push(`<b>Plan @ 20x / $10k:</b>`);
    lines.push(`Entry $${fmtPx(plan.entry.ideal)} · now $${fmtPx(current)} (${sign}${deltaPct.toFixed(2)}%) ${status}`);
    lines.push(`Stop $${fmtPx(plan.stop.price)} (${plan.stop.distancePct.toFixed(2)}% ${plan.side === "LONG" ? "below" : "above"})`);

    // Multi-TP — show TP1/TP2/TP3 with suggested partial-close % (50/30/20 scale-out)
    const tps = plan.targets.slice(0, 3);
    const tpClosePct = [50, 30, 20];
    if (tps.length > 0) {
      lines.push(`<b>Targets:</b>`);
      for (let i = 0; i < tps.length; i++) {
        const t = tps[i]!;
        const movePct = ((t.price - current) / current) * 100 * (plan.side === "LONG" ? 1 : -1);
        lines.push(`  TP${i + 1} $${fmtPx(t.price)} · ${t.rr.toFixed(2)}R · +${movePct.toFixed(1)}% · close ${tpClosePct[i]}%`);
      }
      const expectedR = tps.reduce((acc, t, i) => acc + (t.rr * (tpClosePct[i] ?? 0) / 100), 0);
      lines.push(`<i>Weighted expected: ${expectedR.toFixed(2)}R if all TPs hit per plan</i>`);
    }
    lines.push(`Size ${plan.positionSizing.units.toFixed(2)} ${asset} = $${plan.positionSizing.notionalUsd.toFixed(0)} · margin $${plan.positionSizing.marginUsd.toFixed(0)}`);
  }

  const keyboard: ReplyMarkup = {
    inline_keyboard: [
      [{ text: "🔄 Refresh", callback_data: `card:${asset}` }, { text: "« Menu", callback_data: "cmd:start" }],
    ],
  };
  return { text: lines.join("\n"), keyboard };
}

async function handleScanSymbol(chatId: number, asset: string): Promise<void> {
  await tgCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  const card = await buildTradeCard(asset.toUpperCase());
  if (!card) {
    await sendKbd(chatId, `Iets misging bij analyseren van ${asset}`, MAIN_MENU);
    return;
  }
  await sendKbd(chatId, card.text, card.keyboard);
}

interface ContractMeta { symbol: string; contractSize: number; }
const contractSizesCache: { ts: number; map: Map<string, number> } = { ts: 0, map: new Map() };
async function getContractSizes(): Promise<Map<string, number>> {
  if (Date.now() - contractSizesCache.ts < 60 * 60_000 && contractSizesCache.map.size > 0) return contractSizesCache.map;
  const resp = await fetchJson<{ data: ContractMeta[] }>("https://contract.mexc.com/api/v1/contract/detail");
  contractSizesCache.map = new Map();
  for (const c of resp.data) contractSizesCache.map.set(c.symbol, c.contractSize ?? 1);
  contractSizesCache.ts = Date.now();
  return contractSizesCache.map;
}

async function handlePositions(chatId: number): Promise<void> {
  await tgCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  try {
    const positions = await getOpenPositions();
    if (positions.length === 0) {
      await sendKbd(chatId, "📊 Geen open posities.", MAIN_MENU);
      return;
    }
    const cs = await getContractSizes();
    const lines: string[] = [`📊 <b>Live positions</b> (${positions.length})`, ""];
    let totalMargin = 0, totalPnl = 0;
    const posCards: Array<{ asset: string; pnlUsd: number; pnlPct: number }> = [];
    for (const p of positions) {
      const ticker = await getFuturesTicker(p.symbol);
      if (!ticker) continue;
      const side = p.positionType === 1 ? "LONG" : "SHORT";
      const dir = side === "LONG" ? 1 : -1;
      const qtyBase = p.holdVol * (cs.get(p.symbol) ?? 1);
      const pnlUsd = (ticker.lastPrice - p.holdAvgPrice) * qtyBase * dir;
      const pnlPct = (pnlUsd / p.im) * 100;
      const asset = p.symbol.replace(/_USDT$/, "").replace(/^TONCOIN$/, "TON");
      posCards.push({ asset, pnlUsd, pnlPct });
      totalMargin += p.im;
      totalPnl += pnlUsd;
    }
    posCards.sort((a, b) => b.pnlUsd - a.pnlUsd);
    for (const c of posCards) {
      const e = c.pnlUsd >= 0 ? "🟢" : "🔴";
      const s = c.pnlUsd >= 0 ? "+" : "";
      lines.push(`${e} <b>${c.asset}</b> ${s}$${c.pnlUsd.toFixed(0)} (${s}${c.pnlPct.toFixed(0)}%)`);
    }
    lines.push("");
    const totalEmoji = totalPnl >= 0 ? "🟢" : "🔴";
    const totalSign = totalPnl >= 0 ? "+" : "";
    lines.push(`<b>Total</b>: ${totalEmoji} ${totalSign}$${totalPnl.toFixed(0)} (${totalSign}${(totalPnl / totalMargin * 100).toFixed(1)}% margin)`);
    // Build clickable rows for each position
    const buttons: InlineKeyboardButton[][] = [];
    for (let i = 0; i < posCards.length; i += 2) {
      const row: InlineKeyboardButton[] = [{ text: posCards[i]!.asset, callback_data: `card:${posCards[i]!.asset}` }];
      if (posCards[i + 1]) row.push({ text: posCards[i + 1]!.asset, callback_data: `card:${posCards[i + 1]!.asset}` });
      buttons.push(row);
    }
    buttons.push([{ text: "🔄 Refresh", callback_data: "cmd:positions" }, { text: "« Menu", callback_data: "cmd:start" }]);
    await sendKbd(chatId, lines.join("\n"), { inline_keyboard: buttons });
  } catch (e) {
    await sendKbd(chatId, `❌ Fout: ${e instanceof Error ? e.message : String(e)}`, MAIN_MENU);
  }
}

async function handleScanPrompt(chatId: number): Promise<void> {
  chatState.set(chatId, { kind: "awaiting_scan_symbol", ts: Date.now() });
  await sendKbd(chatId, "🔎 Type een symbol (bv. <code>BCH</code>, <code>SOL</code>, <code>FARTCOIN</code>):", {
    inline_keyboard: [[{ text: "Cancel", callback_data: "cmd:start" }]],
  });
}

async function handleTop(chatId: number): Promise<void> {
  await sendKbd(chatId, "🔥 <i>Top setups scan duurt ~3 min — alerts verschijnen automatisch in deze chat zodra nieuwe signalen verschijnen.</i>\n\nVoor een specifieke coin: gebruik <b>Scan</b> of typ het symbol.", MAIN_MENU);
}

async function processUpdate(u: TgUpdate): Promise<void> {
  if (u.message?.text) {
    const msg = u.message;
    const text = msg.text!.trim();
    const chatId = msg.chat.id;
    log(`msg from ${msg.from?.username ?? msg.from?.id}: ${text.slice(0, 40)}`);
    if (text === "/start") return sendMainMenu(chatId);
    if (text === "/help") return sendHelp(chatId);
    if (text === "/positions") return handlePositions(chatId);
    if (text === "/scan") return handleScanPrompt(chatId);
    if (text === "/top") return handleTop(chatId);
    // Conversational state: awaiting symbol
    const state = chatState.get(chatId);
    if (state?.kind === "awaiting_scan_symbol" && Date.now() - state.ts < STATE_TTL_MS) {
      chatState.set(chatId, { kind: "idle" });
      return handleScanSymbol(chatId, text.replace(/[^A-Za-z0-9]/g, ""));
    }
    // Plain ticker: try to analyze
    if (/^[A-Za-z0-9]{2,15}$/.test(text)) {
      return handleScanSymbol(chatId, text);
    }
    return sendKbd(chatId, "❓ Begrijp ik niet. Tik een knop of typ /help", MAIN_MENU);
  }
  if (u.callback_query) {
    const cb = u.callback_query;
    const chatId = cb.message?.chat.id;
    if (!chatId) return;
    log(`callback: ${cb.data}`);
    await answerCallback(cb.id);
    if (cb.data === "cmd:start") return sendMainMenu(chatId);
    if (cb.data === "cmd:help") return sendHelp(chatId);
    if (cb.data === "cmd:positions") return handlePositions(chatId);
    if (cb.data === "cmd:scan") return handleScanPrompt(chatId);
    if (cb.data === "cmd:top") return handleTop(chatId);
    if (cb.data?.startsWith("card:")) {
      const asset = cb.data.slice(5);
      return handleScanSymbol(chatId, asset);
    }
  }
}

export async function runBot(): Promise<void> {
  if (!config.telegramToken) {
    console.error("TELEGRAM_BOT_TOKEN not set");
    process.exit(1);
  }
  log(`bot starting...`);
  let offset = 0;
  while (true) {
    try {
      const url = `https://api.telegram.org/bot${config.telegramToken}/getUpdates?timeout=25&offset=${offset}`;
      const resp = await fetchJson<GetUpdatesResp>(url, { timeoutMs: 30_000 });
      if (resp.ok && resp.result.length > 0) {
        for (const u of resp.result) {
          offset = Math.max(offset, u.update_id + 1);
          await processUpdate(u).catch((e) => log(`update error: ${e}`));
        }
      }
    } catch (e) {
      log(`poll error: ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
