/**
 * One-shot Blofin top-30 scanner. Runs the multi-TF futures pipeline against
 * the Blofin perpetual adapter for each asset in BLOFIN_TOP30_ASSETS, then
 * prints a compact table.
 *
 * Different from scan-coinbase:
 *   - Fires LONG **and** SHORT (Blofin is futures — supportsShort=true).
 *   - mode="futures" with non-trivial leverage (default 5×). trade-plan
 *     auto-reduces leverage when the stop wouldn't fit in the liq buffer.
 *   - Stage 2 gate: LONG requires stage2=true, SHORT requires stage2=false
 *     (symmetric "trend regime aligned" check). Override with
 *     --allow-non-stage2.
 *   - Asset universe: BLOFIN_ACTIVE_ASSETS (curated top-30 — 10 majors +
 *     stalwarts + L1s + L2s + DeFi + AI; memes/tail-coins excluded).
 *
 * Run:
 *   npx tsx scripts/scan-blofin.ts                       # dry-run
 *   npx tsx scripts/scan-blofin.ts --fire                # write signals
 *   npx tsx scripts/scan-blofin.ts --high-only --fire    # high conf only
 *   npx tsx scripts/scan-blofin.ts --leverage 10 --fire  # override leverage
 */

import pc from "picocolors";
import { analyzeFutures, type FuturesAnalysis } from "../src/analyze-futures.js";
import { generateTradePlan } from "../src/analysis/trade-plan.js";
import { blofinFuturesAdapter } from "../src/clients/blofin-adapter.js";
import { loadPortfolio } from "../src/paper-portfolio.js";
import type { PaperTrade } from "../src/paper-portfolio.js";
import { appendSignal, isOnCooldown, readSignals } from "../src/signal-log.js";
import { BLOFIN_ACTIVE_ASSETS, BLOFIN_TOP30_ASSETS } from "../src/whitelist.js";

const DEFAULT_COOLDOWN_HOURS = 6;
const DEFAULT_LEVERAGE = 5;
/** Drawdown circuit-breaker: ≥N stop-outs on the same asset within window → suspend. */
const DRAWDOWN_STOPS_THRESHOLD = 2;
const DRAWDOWN_WINDOW_HOURS = 48;

function parseNumericFlag(argv: readonly string[], flag: string, def: number): number {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx === argv.length - 1) return def;
  const raw = argv[idx + 1];
  const n = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function colorSide(side: string): string {
  if (side === "LONG") return pc.bgGreen(pc.black(` LONG  `));
  if (side === "SHORT") return pc.bgRed(pc.white(` SHORT `));
  return pc.bgYellow(pc.black(` FLAT  `));
}

function colorScore(s: number): string {
  const txt = String(s).padStart(3);
  if (s >= 65) return pc.green(txt);
  if (s >= 50) return pc.yellow(txt);
  return pc.red(txt);
}

function bar(s: number, width = 8): string {
  const filled = Math.max(0, Math.min(width, Math.round((s / 100) * width)));
  const b = "█".repeat(filled) + "░".repeat(width - filled);
  return s >= 65 ? pc.green(b) : s >= 50 ? pc.yellow(b) : pc.red(b);
}

function dirGlyph(d: "bullish" | "bearish" | "neutral"): string {
  return d === "bullish" ? pc.green("▲") : d === "bearish" ? pc.red("▼") : pc.yellow("·");
}

function fmtTfRow(a: FuturesAnalysis): string {
  return a.timeframes.map((t) => `${t.timeframe}${dirGlyph(t.direction)}${String(Math.round(t.chart.score)).padStart(2)}`).join(" ");
}

function fmtPrice(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1000) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

/**
 * Per-asset drawdown circuit breaker.
 *
 * Counts stop-out closes for `asset` within the last `windowMs` milliseconds.
 * A "stop-out" is a closed trade whose final exit reason is "stop". When the
 * count hits `threshold`, the asset is suspended — paper-trader keeps
 * managing existing positions but the scanner stops opening new ones until
 * the window expires.
 *
 * Motivation: 3 XLM longs (May 30-31, 2026) re-entered every 6-22h on a
 * failing post-pump thesis; all stopped out. Cooldown prevents same-tick
 * re-fires but doesn't prevent tunnel-vision into a broken setup.
 */
function recentStopCount(trades: readonly PaperTrade[], asset: string, windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  return trades.filter((t) => t.asset === asset && t.closedTs >= cutoff && t.finalExitReason === "stop").length;
}

/**
 * Stage-2 gate per side.
 *   LONG  → require stage2=true  (close > 150d SMA, uptrend regime)
 *   SHORT → require stage2=false (close ≤ 150d SMA, downtrend regime)
 * Returns null on missing data so the caller can skip with the right reason.
 */
function stageOk(side: string, stage2: boolean | null): { ok: boolean; reason: string } {
  if (stage2 === null) return { ok: false, reason: "Stage ? (no data)" };
  if (side === "LONG"  && stage2 === true)  return { ok: true,  reason: "Stage 2 ✓" };
  if (side === "SHORT" && stage2 === false) return { ok: true,  reason: "Stage 4 ✓" };
  return {
    ok: false,
    reason: side === "LONG" ? "LONG without Stage 2 ✓" : "SHORT in uptrend regime",
  };
}

async function main(): Promise<void> {
  const fire = process.argv.includes("--fire");
  const minConfidence = process.argv.includes("--high-only") ? "high" : "medium";
  const cooldownHours = parseNumericFlag(process.argv, "--cooldown-hours", DEFAULT_COOLDOWN_HOURS);
  const leverage = parseNumericFlag(process.argv, "--leverage", DEFAULT_LEVERAGE);
  const allowAllAssets = process.argv.includes("--all-assets");
  const allowNonStage2 = process.argv.includes("--allow-non-stage2");

  const started = Date.now();
  process.stdout.write(pc.bold(`Scanning Blofin top-${BLOFIN_TOP30_ASSETS.length} perps — multi-TF (5m/15m/1h/4h/1d)\n`));
  if (fire) {
    process.stdout.write(
      pc.dim(
        `Fire mode: ${minConfidence}+ LONG/SHORT · stage gate=${allowNonStage2 ? "off" : "on"} · ` +
          `assets=${allowAllAssets ? `top-${BLOFIN_TOP30_ASSETS.length}` : BLOFIN_ACTIVE_ASSETS.join("+")} · ` +
          `cooldown=${cooldownHours}h · leverage=${leverage}×\n`,
      ),
    );
  }
  process.stdout.write("\n");

  // Concurrency cap — Blofin allows 500 req/min IP but each asset takes
  // ~7 calls (5 klines + 1 ticker + 1 funding). At 30 assets × 7 calls = 210
  // calls per scan. With CONCURRENCY=5 that's 6 sequential batches of 35
  // calls each — well under the 500/min cap and finishes in ~5-8s.
  const CONCURRENCY = 5;
  const results: FuturesAnalysis[] = [];
  for (let i = 0; i < BLOFIN_TOP30_ASSETS.length; i += CONCURRENCY) {
    const batch = BLOFIN_TOP30_ASSETS.slice(i, i + CONCURRENCY);
    const out = await Promise.all(
      batch.map(async (asset) => {
        try {
          return await analyzeFutures(asset, blofinFuturesAdapter);
        } catch (e) {
          return { asset, error: e instanceof Error ? e.message : String(e) } as unknown as FuturesAnalysis;
        }
      }),
    );
    results.push(...out);
  }

  // Sort: signals (LONG+SHORT) first by confluence score, then FLAT.
  const ranked = results.slice().sort((a, b) => {
    const sideRank = (s: string) => (s === "LONG" || s === "SHORT" ? 0 : 1);
    const ra = sideRank(a.verdict?.side ?? "FLAT");
    const rb = sideRank(b.verdict?.side ?? "FLAT");
    if (ra !== rb) return ra - rb;
    return (b.confluence?.score ?? 0) - (a.confluence?.score ?? 0);
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // Header
  const cols = [
    "Side  ".padEnd(8),
    "Symbol".padEnd(11),
    "Last".padEnd(11),
    "24h".padEnd(8),
    "Comp",
    "Bar".padEnd(8),
    "Conf".padEnd(7),
    "HTF/LTF".padEnd(14),
    "Stg2".padEnd(5),
    "TF detail (5m/15m/1h/4h/1d)",
  ];
  process.stdout.write(pc.dim(cols.join("  ")) + "\n");
  process.stdout.write(pc.dim("─".repeat(120)) + "\n");

  for (const a of ranked) {
    if (!a.verdict) {
      process.stdout.write(pc.red(`${a.asset} — error\n`));
      continue;
    }
    const ch = (a.ticker?.riseFallRate ?? 0) * 100;
    const chColored = ch >= 0 ? pc.green(`+${ch.toFixed(2)}%`) : pc.red(`${ch.toFixed(2)}%`);
    const stage2 = a.stage2 === true ? pc.green("✓") : a.stage2 === false ? pc.red("✗") : pc.dim("?");
    const conf = a.verdict.confidence;
    const confColor = conf === "high" ? pc.green : conf === "medium" ? pc.yellow : pc.dim;
    const cells = [
      colorSide(a.verdict.side),
      (a.perpSymbol ?? "—").padEnd(11),
      fmtPrice(a.ticker?.lastPrice).padEnd(11),
      chColored.padEnd(16),
      colorScore(a.confluence.score),
      bar(a.confluence.score),
      confColor(conf.padEnd(7)),
      `${a.confluence.htfDirection.slice(0, 4)}/${a.confluence.ltfDirection.slice(0, 4)}`.padEnd(14),
      stage2.padEnd(8),
      fmtTfRow(a),
    ];
    process.stdout.write(cells.join("  ") + "\n");
  }

  // Summary
  const longs  = ranked.filter((a) => a.verdict?.side === "LONG");
  const shorts = ranked.filter((a) => a.verdict?.side === "SHORT");
  const flats  = ranked.filter((a) => a.verdict?.side === "FLAT");
  process.stdout.write("\n");
  process.stdout.write(pc.bold("Summary:") + "\n");
  const universe = BLOFIN_TOP30_ASSETS.length;
  process.stdout.write(`  LONG signals  : ${longs.length}/${universe}\n`);
  process.stdout.write(`  SHORT signals : ${shorts.length}/${universe}\n`);
  process.stdout.write(`  FLAT          : ${flats.length}/${universe}\n`);
  process.stdout.write(pc.dim(`  scan elapsed  : ${elapsed}s\n`));

  // Fire signals to log on demand (read-only otherwise).
  if (fire) {
    const existingRecords = readSignals();
    const portfolio = loadPortfolio();
    const cooldownMs = cooldownHours * 3600 * 1000;
    const drawdownWindowMs = DRAWDOWN_WINDOW_HOURS * 3600 * 1000;
    const activeSet = new Set(BLOFIN_ACTIVE_ASSETS);
    const eligible = ranked.filter(
      (a) =>
        (a.verdict?.side === "LONG" || a.verdict?.side === "SHORT") &&
        (a.verdict.confidence === "high" ||
          (minConfidence === "medium" && a.verdict.confidence === "medium")),
    );
    let fired = 0;
    process.stdout.write("\n" + pc.bold("Fire candidates:") + "\n");
    for (const a of eligible) {
      if (!a.perpSymbol) continue;
      if (!allowAllAssets && !activeSet.has(a.asset)) {
        process.stdout.write(
          `  ${pc.dim(`skip ${a.perpSymbol}: ${a.asset} not in active set`)}\n`,
        );
        continue;
      }
      if (!allowNonStage2) {
        const gate = stageOk(a.verdict.side, a.stage2);
        if (!gate.ok) {
          process.stdout.write(`  ${pc.dim(`skip ${a.perpSymbol}: ${gate.reason}`)}\n`);
          continue;
        }
      }
      if (isOnCooldown(existingRecords, a.perpSymbol, cooldownMs)) {
        process.stdout.write(
          `  ${pc.dim(`skip ${a.perpSymbol}: cooldown (<${cooldownHours}h since last fire)`)}\n`,
        );
        continue;
      }
      const recentStops = recentStopCount(portfolio.closedTrades, a.asset, drawdownWindowMs);
      if (recentStops >= DRAWDOWN_STOPS_THRESHOLD) {
        process.stdout.write(
          `  ${pc.dim(`skip ${a.perpSymbol}: drawdown-suspended (${recentStops} stop-outs in last ${DRAWDOWN_WINDOW_HOURS}h)`)}\n`,
        );
        continue;
      }
      const plan = generateTradePlan({
        analysis: a,
        accountUsd: 1000,
        leverage,
        mode: "futures",
        // Sub-1.5% stops on 5m-scanner alt fires got whipsawed in 5 of 6 paper
        // SHORTs (May 22-25). The one winner (DOT, +2.27R) had the only ≥1.5%
        // stop. Floor the rest to the same distance.
        minStopDistancePct: 1.5,
        // Stops > 4% mean ATR has exploded (post-pump / post-crash regime).
        // Three XLM longs (May 30-31) fired with 6-10% stops right after a
        // +23.55% pump and all stopped out within 24h. Refuse those plans
        // entirely — a coin too volatile for our risk-budget isn't tradeable.
        maxStopDistancePct: 4.0,
      });
      if (!plan || !a.perpSymbol || !a.ticker) {
        process.stdout.write(`  ${pc.dim(`skip ${a.perpSymbol}: no plan`)}\n`);
        continue;
      }
      appendSignal({
        ts: Date.now(),
        symbol: a.perpSymbol,
        asset: a.asset,
        exchange: "blofin-futures",
        mode: "futures",
        naturalSide: a.naturalSide,
        side: a.verdict.side,
        fired: true,
        shadowReason: null,
        composite: a.confluence.score,
        stage2: a.stage2,
        aligned: a.confluence.aligned,
        htfDirection: a.confluence.htfDirection,
        ltfDirection: a.confluence.ltfDirection,
        entryPrice: a.ticker.lastPrice,
        stopPrice: plan.stop.price,
        tp1Price: plan.targets[0]?.price ?? null,
        tp2Price: plan.targets[1]?.price ?? null,
        tp3Price: plan.targets[2]?.price ?? null,
        outcome: null,
      });
      process.stdout.write(
        `  ${pc.green("fired")} ${a.perpSymbol} ${a.verdict.side} ${a.verdict.confidence} ` +
          `entry=${a.ticker.lastPrice} stop=${plan.stop.price.toFixed(6)} ` +
          `tp1=${plan.targets[0]?.price?.toFixed(6) ?? "-"}\n`,
      );
      fired++;
    }
    process.stdout.write(pc.dim(`  ${fired} signal(s) appended to signal log\n`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
