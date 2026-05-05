/**
 * Live position report → Telegram.
 *
 * 1. Fetch open positions from MEXC via signed private API
 * 2. For each, run multi-timeframe analyzeFutures()
 * 3. Generate a per-position recommendation (HOLD / TIGHTEN STOP / CLOSE PARTIAL / CLOSE ALL)
 * 4. Push formatted message to Telegram
 */
import { getOpenPositions } from "../src/clients/mexc-private.js";
import { getFuturesTicker } from "../src/clients/mexc-futures.js";
import { analyzeFutures } from "../src/analyze-futures.js";
import { sendTelegram } from "../src/clients/telegram.js";

interface ContractMeta { symbol: string; contractSize: number; }

async function getContractSizes(): Promise<Map<string, number>> {
  const resp = await fetch("https://contract.mexc.com/api/v1/contract/detail").then((r) => r.json());
  const out = new Map<string, number>();
  for (const c of resp.data as ContractMeta[]) out.set(c.symbol, c.contractSize ?? 1);
  return out;
}

interface Recommendation {
  action: "HOLD" | "TIGHTEN_STOP" | "CLOSE_PARTIAL" | "CLOSE_ALL";
  text: string;
  emoji: string;
}

async function main(): Promise<void> {
  process.stderr.write("Fetching positions...\n");
  const positions = await getOpenPositions();
  if (positions.length === 0) {
    await sendTelegram("📊 *Position Report*\n\nNo open positions.");
    return;
  }

  const contractSizes = await getContractSizes();
  process.stderr.write(`Got ${positions.length} positions, analyzing each...\n`);

  // Compute per-position PnL by joining with current ticker
  const enriched: Array<{
    p: typeof positions[number];
    side: "LONG" | "SHORT";
    asset: string;
    currentPrice: number;
    qtyBase: number;
    pnlUsd: number;
    pnlPctMargin: number;
    spotMovePct: number;
  }> = [];

  for (const p of positions) {
    const ticker = await getFuturesTicker(p.symbol);
    if (!ticker) continue;
    const side = p.positionType === 1 ? "LONG" : "SHORT";
    const cs = contractSizes.get(p.symbol) ?? 1;
    const qtyBase = p.holdVol * cs;
    const dir = side === "LONG" ? 1 : -1;
    const pnlUsd = (ticker.lastPrice - p.holdAvgPrice) * qtyBase * dir;
    const pnlPctMargin = (pnlUsd / p.im) * 100;
    const spotMovePct = ((ticker.lastPrice - p.holdAvgPrice) / p.holdAvgPrice) * 100 * dir;
    const asset = p.symbol.replace(/_USDT$/, "").replace(/^TONCOIN$/, "TON");
    enriched.push({ p, side, asset, currentPrice: ticker.lastPrice, qtyBase, pnlUsd, pnlPctMargin, spotMovePct });
  }

  // Analyze each unique asset (multi-timeframe)
  const analyses = new Map<string, Awaited<ReturnType<typeof analyzeFutures>>>();
  for (const e of enriched) {
    if (!analyses.has(e.asset)) {
      process.stderr.write(`  analyzing ${e.asset}... `);
      try {
        const a = await analyzeFutures(e.asset);
        analyses.set(e.asset, a);
        process.stderr.write(`${a.verdict.side} ${a.confluence.score}\n`);
      } catch (err) {
        process.stderr.write(`ERR ${err instanceof Error ? err.message : err}\n`);
      }
    }
  }

  // Build recommendation per position
  function recommend(e: typeof enriched[number]): Recommendation {
    const a = analyses.get(e.asset);
    const isWinner = e.pnlPctMargin >= 20;
    const isBigWinner = e.pnlPctMargin >= 50;
    const isLoser = e.pnlPctMargin <= -25;
    const isBigLoser = e.pnlPctMargin <= -40;
    const marginRatio = e.p.marginRatio * 100; // % of margin used in liq calc

    if (isBigLoser && a && (a.verdict.side === "FLAT" || (e.side === "LONG" && a.confluence.htfDirection === "bearish"))) {
      return { action: "CLOSE_ALL", emoji: "🔴", text: `Cut: ${e.pnlPctMargin.toFixed(0)}% loss + setup invalid (${a.verdict.side}/${a.confluence.htfDirection})` };
    }
    if (isBigLoser) {
      return { action: "CLOSE_ALL", emoji: "🔴", text: `Cut: ${e.pnlPctMargin.toFixed(0)}% loss, margin ratio ${marginRatio.toFixed(1)}%` };
    }
    if (isBigWinner && a?.funding && a.funding.regime === "euphoria") {
      return { action: "CLOSE_PARTIAL", emoji: "🟡", text: `Close 50%: +${e.pnlPctMargin.toFixed(0)}% with euphoric funding (${a.funding.regime}) = squeeze risk` };
    }
    if (isBigWinner && a && a.verdict.side === "FLAT") {
      return { action: "CLOSE_PARTIAL", emoji: "🟡", text: `Close 50%: +${e.pnlPctMargin.toFixed(0)}% but setup turned mixed — lock half` };
    }
    if (isWinner) {
      return { action: "TIGHTEN_STOP", emoji: "🟢", text: `Trail stop higher — locked +${e.pnlPctMargin.toFixed(0)}%, let runner run` };
    }
    if (a && a.verdict.side === "LONG" && a.confluence.aligned && e.side === "LONG") {
      return { action: "HOLD", emoji: "🟢", text: `Hold: setup still ${a.verdict.side} ${a.verdict.confidence} (composite ${a.confluence.score})` };
    }
    if (a && a.verdict.side === "SHORT" && a.confluence.aligned && e.side === "LONG") {
      return { action: "CLOSE_ALL", emoji: "🔴", text: `Close: setup flipped to SHORT (composite ${a.confluence.score})` };
    }
    if (a && a.verdict.side === "FLAT") {
      return { action: "TIGHTEN_STOP", emoji: "🟡", text: `Tighten: setup is FLAT (mixed signals), reduce risk` };
    }
    return { action: "HOLD", emoji: "🟢", text: `Hold: setup intact` };
  }

  // Compose message
  const lines: string[] = [];
  lines.push(`📊 *Position Report* — ${new Date().toISOString().slice(11, 16)} UTC`);
  lines.push("");

  enriched.sort((a, b) => b.pnlUsd - a.pnlUsd);
  let totalMargin = 0, totalPnl = 0;
  for (const e of enriched) {
    totalMargin += e.p.im;
    totalPnl += e.pnlUsd;
    const r = recommend(e);
    const a = analyses.get(e.asset);
    const pnlEmoji = e.pnlUsd >= 0 ? "🟢" : "🔴";
    const sign = e.pnlUsd >= 0 ? "+" : "";
    lines.push(`${pnlEmoji} *${e.asset}* ${e.side} 20x — ${sign}$${e.pnlUsd.toFixed(0)} (${sign}${e.pnlPctMargin.toFixed(1)}%)`);
    lines.push(`  Entry $${e.p.holdAvgPrice.toFixed(4)} → now $${e.currentPrice.toFixed(4)} (spot ${sign}${e.spotMovePct.toFixed(2)}%)`);
    lines.push(`  Liq $${e.p.liquidatePrice.toFixed(4)} · Margin $${e.p.im.toFixed(0)}`);
    if (a) {
      lines.push(`  MTF: ${a.confluence.htfDirection}/HTF · ${a.confluence.ltfDirection}/LTF · composite ${a.confluence.score}`);
      if (a.funding) lines.push(`  Funding: ${a.funding.regime} (${(a.funding.ratePerCycle * 100).toFixed(4)}%/cycle)`);
    }
    lines.push(`  ${r.emoji} *${r.action}*: ${r.text}`);
    lines.push("");
  }

  const totalSign = totalPnl >= 0 ? "+" : "";
  const totalEmoji = totalPnl >= 0 ? "🟢" : "🔴";
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`${totalEmoji} *TOTAL*: ${totalSign}$${totalPnl.toFixed(0)} on $${totalMargin.toFixed(0)} margin (${totalSign}${(totalPnl / totalMargin * 100).toFixed(1)}%)`);

  const message = lines.join("\n");
  process.stderr.write("\nSending to Telegram...\n");
  const result = await sendTelegram(message);
  if (result.ok) process.stderr.write(`✓ sent (message_id ${result.messageId})\n`);
  else process.stderr.write(`✗ failed: ${result.error}\n`);

  console.log(message);
}

main().catch((e) => { console.error(e); process.exit(1); });
