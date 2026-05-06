/**
 * Live position report → Telegram (compact, single-message format).
 *
 * Output is one tight message:
 *   📊 Positions — +$X (+Y%)
 *   🟢 SOL +$874 (+66%) → TRAIL
 *   ...
 *   <urgent action box if any>
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

type Action = "HOLD" | "TRAIL" | "CUT_HALF" | "CUT" | "WATCH";

const ACTION_GLYPH: Record<Action, string> = {
  HOLD:     "→ HOLD",
  TRAIL:    "→ TRAIL",
  CUT_HALF: "→ CUT 50%",
  CUT:      "🚨 CUT NOW",
  WATCH:    "⚠ WATCH",
};

async function main(): Promise<void> {
  process.stderr.write("Fetching positions...\n");
  const positions = await getOpenPositions();
  if (positions.length === 0) {
    await sendTelegram("📊 No open positions.");
    return;
  }
  const contractSizes = await getContractSizes();

  interface Row {
    asset: string; side: "LONG" | "SHORT"; pnlUsd: number; pnlPctMargin: number;
    spotMovePct: number; marginRatio: number; action: Action; note: string;
    composite: number;
  }

  const rows: Row[] = [];
  let totalMargin = 0, totalPnl = 0;

  for (const p of positions) {
    const ticker = await getFuturesTicker(p.symbol);
    if (!ticker) continue;
    const side = p.positionType === 1 ? "LONG" : "SHORT";
    const cs = contractSizes.get(p.symbol) ?? 1;
    const dir = side === "LONG" ? 1 : -1;
    const qtyBase = p.holdVol * cs;
    const pnlUsd = (ticker.lastPrice - p.holdAvgPrice) * qtyBase * dir;
    const pnlPctMargin = (pnlUsd / p.im) * 100;
    const spotMovePct = ((ticker.lastPrice - p.holdAvgPrice) / p.holdAvgPrice) * 100 * dir;
    const asset = p.symbol.replace(/_USDT$/, "").replace(/^TONCOIN$/, "TON");

    process.stderr.write(`  ${asset}... `);
    let composite = 0;
    let action: Action = "HOLD";
    let note = "";
    try {
      const a = await analyzeFutures(asset);
      composite = a.confluence.score;
      const setupBullish = a.verdict.side === "LONG" && a.confluence.aligned;
      const setupBearish = a.verdict.side === "SHORT" && a.confluence.aligned;
      const setupFlat = a.verdict.side === "FLAT";
      const fundingHot = a.funding?.regime === "euphoria" || a.funding?.regime === "crowded_long";

      if (pnlPctMargin <= -40 && (setupFlat || (side === "LONG" && setupBearish))) {
        action = "CUT"; note = `setup ${setupFlat ? "flat" : "flipped"}, big loss`;
      } else if (pnlPctMargin <= -40) {
        action = "CUT"; note = "loss too deep, recovery unlikely";
      } else if (pnlPctMargin >= 50 && fundingHot) {
        action = "CUT_HALF"; note = `take half: ${a.funding!.regime} funding = squeeze risk`;
      } else if (pnlPctMargin >= 50 && setupFlat) {
        action = "CUT_HALF"; note = "lock half: setup turned mixed";
      } else if (pnlPctMargin >= 20) {
        action = "TRAIL"; note = "in profit, tighten stop higher";
      } else if (side === "LONG" && setupBearish) {
        action = "CUT"; note = `setup flipped to SHORT (composite ${composite})`;
      } else if (setupFlat) {
        action = "WATCH"; note = "setup mixed, no clear edge";
      } else if (setupBullish && side === "LONG") {
        action = "HOLD"; note = `setup intact (composite ${composite})`;
      }
    } catch {
      note = "analysis failed";
    }

    rows.push({ asset, side, pnlUsd, pnlPctMargin, spotMovePct, marginRatio: p.marginRatio * 100, action, note, composite });
    totalMargin += p.im;
    totalPnl += pnlUsd;
    process.stderr.write(`${ACTION_GLYPH[action]}\n`);
  }

  // Sort: urgent actions first (CUT > CUT_HALF > WATCH > TRAIL > HOLD), then by PnL
  const ACTION_RANK: Record<Action, number> = { CUT: 0, CUT_HALF: 1, WATCH: 2, TRAIL: 3, HOLD: 4 };
  rows.sort((a, b) => ACTION_RANK[a.action] - ACTION_RANK[b.action] || b.pnlUsd - a.pnlUsd);

  // Compose compact message
  const totalEmoji = totalPnl >= 0 ? "🟢" : "🔴";
  const totalSign = totalPnl >= 0 ? "+" : "";
  const lines: string[] = [];
  lines.push(`📊 <b>Positions</b> ${totalEmoji} ${totalSign}$${totalPnl.toFixed(0)} (${totalSign}${(totalPnl / totalMargin * 100).toFixed(1)}% margin)`);
  lines.push("");

  for (const r of rows) {
    const e = r.pnlUsd >= 0 ? "🟢" : "🔴";
    const s = r.pnlUsd >= 0 ? "+" : "";
    lines.push(`${e} <b>${r.asset}</b> ${s}$${r.pnlUsd.toFixed(0)} (${s}${r.pnlPctMargin.toFixed(0)}%) ${ACTION_GLYPH[r.action]}`);
  }

  // Urgent action callouts at bottom (only if any)
  const urgent = rows.filter((r) => r.action === "CUT" || r.action === "CUT_HALF");
  if (urgent.length > 0) {
    lines.push("");
    lines.push("⚡ <b>Action needed:</b>");
    for (const u of urgent) {
      lines.push(`  • ${u.asset} — ${u.note}`);
    }
  }

  const msg = lines.join("\n");
  process.stderr.write("\nSending to Telegram...\n");
  const result = await sendTelegram(msg, { parse_mode: "HTML" });
  if (result.ok) process.stderr.write(`✓ sent\n`);
  else process.stderr.write(`✗ ${result.error}\n`);

  console.log(msg);
}

main().catch((e) => { console.error(e); process.exit(1); });
