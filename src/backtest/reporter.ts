/**
 * Markdown report generator for the backtest harness v2.
 *
 * Renders `WalkForwardResult[]` to a Markdown document matching the tone of
 * `docs/BACKTEST_RESULTS.md` (concrete, honest, no marketing language). Also
 * emits a copy-pasteable JSON block for the highest-OOS-expectancy certified
 * config — consumed by `paper-trader.ts` (manual step).
 *
 * PURE-ish: this module performs filesystem I/O for the report file ONLY via
 * `renderReport`. `renderCertifiedConfigJson` is pure (returns a string). No
 * network, no clocks beyond the metadata the caller hands in. No mutation of
 * inputs.
 *
 * Companion docs:
 * - docs/BACKTEST_HARNESS_V2_PRD.md §4, §10
 * - docs/BACKTEST_V2_ARCHITECTURE.md §reporter.ts
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { configId, type BacktestConfigV2 } from "./grid.js";
import type { WalkForwardResult } from "./walk-forward.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportOptions {
  outputPath: string;
  runMetadata: {
    startedAt: string;      // ISO
    durationSec: number;
    gridSize: number;
    universeTopN: number;
    windowStartMs: number;
    windowEndMs: number;
  };
  certificationGates: {
    minOosExpectancy: number;   // 0.10
    minOosSharpe: number;       // 1.0
    maxDrawdownR: number;       // 20
    maxTopSymbolShare: number;  // 0.50
  };
}

// ---------------------------------------------------------------------------
// Certification logic
// ---------------------------------------------------------------------------

/** Per-gate pass/fail breakdown for one config. */
interface GateReport {
  oosExpectancyPass: boolean;
  oosSharpePass: boolean;
  maxDrawdownPass: boolean;
  concentrationPass: boolean;
  overfittingPass: boolean;
  allPass: boolean;
}

/**
 * Aggregate OOS metrics across folds 1-3 (excludes the agg fold).
 *
 * - `oosSharpe`: unweighted mean of fold sharpes. A simple aggregation; the
 *   architecture allows the reporter to pick its own; mean of per-fold Sharpe
 *   is what makes the gate intuitive ("avg OOS Sharpe > 1.0").
 * - `maxDrawdownR`: the WORST of the per-fold OOS drawdowns. We want the gate
 *   to trip if any single fold blew up; averaging would hide that.
 * - `topSymbolShare`: the WORST (largest) per-fold concentration.
 */
interface OosAggregate {
  expectancy: number;
  sharpe: number;
  maxDrawdownR: number;
  topSymbolShare: number;
}

function oosAggregateOf(r: WalkForwardResult): OosAggregate {
  const nonAgg = r.folds.filter((f) => f.fold.id !== "agg");
  if (nonAgg.length === 0) {
    return { expectancy: 0, sharpe: 0, maxDrawdownR: 0, topSymbolShare: 0 };
  }
  const meanSharpe = nonAgg.reduce((s, f) => s + f.testStats.sharpe, 0) / nonAgg.length;
  let worstDd = 0;
  let worstShare = 0;
  for (const f of nonAgg) {
    if (f.testStats.maxDrawdownR > worstDd) worstDd = f.testStats.maxDrawdownR;
    if (f.testStats.topSymbolShare > worstShare) worstShare = f.testStats.topSymbolShare;
  }
  return {
    expectancy: r.oosMeanExpectancy,
    sharpe: meanSharpe,
    maxDrawdownR: worstDd,
    topSymbolShare: worstShare,
  };
}

function evaluateGates(
  r: WalkForwardResult,
  gates: ReportOptions["certificationGates"],
): GateReport {
  const agg = oosAggregateOf(r);
  const oosExpectancyPass = agg.expectancy > gates.minOosExpectancy;
  const oosSharpePass = agg.sharpe > gates.minOosSharpe;
  const maxDrawdownPass = agg.maxDrawdownR < gates.maxDrawdownR;
  const concentrationPass = agg.topSymbolShare <= gates.maxTopSymbolShare;
  // Overfitting gate: IS/OOS delta must NOT exceed 0.50 (architect's red flag).
  const overfittingPass = r.isOosDelta <= 0.5;
  return {
    oosExpectancyPass,
    oosSharpePass,
    maxDrawdownPass,
    concentrationPass,
    overfittingPass,
    allPass:
      oosExpectancyPass &&
      oosSharpePass &&
      maxDrawdownPass &&
      concentrationPass &&
      overfittingPass,
  };
}

function isCertified(r: WalkForwardResult, gates: ReportOptions["certificationGates"]): boolean {
  return evaluateGates(r, gates).allPass;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return n > 0 ? "+Inf" : "-Inf";
  const s = n.toFixed(digits);
  return n > 0 && !s.startsWith("+") ? "+" + s : s;
}

function fmtPct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtBool(b: boolean): string {
  return b ? "pass" : "FAIL";
}

function fmtCheck(b: boolean): string {
  return b ? "yes" : "no";
}

function fmtConfigSummary(cfg: BacktestConfigV2): string {
  const s2 = cfg.requireStage2 ? "stage2" : "no-s2";
  const br = cfg.requireBreakout ? " breakout" : "";
  return `c${cfg.thresholdComposite} ${s2} atr${cfg.stopAtrMult.toFixed(1)} h${cfg.horizonBars} cd${cfg.cooldownBars}${br}`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderHeader(opts: ReportOptions): string {
  const { runMetadata: m } = opts;
  const lines: string[] = [];
  lines.push("# Backtest v2 — Results");
  lines.push("");
  lines.push(`**Generated:** ${m.startedAt}`);
  lines.push("");
  lines.push("## Run metadata");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| Window | ${fmtDate(m.windowStartMs)} → ${fmtDate(m.windowEndMs)} |`);
  lines.push(`| Window length | ${((m.windowEndMs - m.windowStartMs) / 86_400_000).toFixed(1)} days |`);
  lines.push(`| Grid size | ${m.gridSize} configs |`);
  lines.push(`| Universe size | top-${m.universeTopN} |`);
  lines.push(`| Wall-clock | ${m.durationSec.toFixed(1)}s |`);
  lines.push("");
  return lines.join("\n");
}

function renderCertificationGates(opts: ReportOptions, results: readonly WalkForwardResult[]): string {
  const gates = opts.certificationGates;
  const certifiedCount = results.filter((r) => isCertified(r, gates)).length;
  const lines: string[] = [];
  lines.push("## Certification gates");
  lines.push("");
  lines.push("A config is **certified** only if it passes every gate below.");
  lines.push("");
  lines.push("| Gate | Threshold |");
  lines.push("|---|---|");
  lines.push(`| OOS mean expectancy | > ${fmt(gates.minOosExpectancy, 2)} R/trade |`);
  lines.push(`| OOS mean Sharpe | > ${gates.minOosSharpe.toFixed(2)} |`);
  lines.push(`| OOS max drawdown | < ${gates.maxDrawdownR.toFixed(1)} R |`);
  lines.push(`| Single-symbol share | <= ${fmtPct(gates.maxTopSymbolShare, 0)} |`);
  lines.push(`| IS-OOS delta | <= 50% |`);
  lines.push("");
  lines.push(`**Certified configs:** ${certifiedCount} of ${results.length}.`);
  lines.push("");
  return lines.join("\n");
}

function renderRankedTable(results: readonly WalkForwardResult[], opts: ReportOptions): string {
  const gates = opts.certificationGates;
  const ranked = [...results].sort((a, b) => oosAggregateOf(b).expectancy - oosAggregateOf(a).expectancy);
  const lines: string[] = [];
  lines.push("## Ranked configs");
  lines.push("");
  lines.push("Sorted by out-of-sample mean expectancy descending. IS-OOS delta > 50% is the architect's overfitting red flag (marked `RED`).");
  lines.push("");
  lines.push("| Rank | Config ID | Side | Summary | IS exp | OOS exp | IS-OOS delta | OOS Sharpe | OOS max DD | Top sym share | Certified |");
  lines.push("|---:|---|---|---|---:|---:|---:|---:|---:|---:|:---:|");
  ranked.forEach((r, i) => {
    const agg = oosAggregateOf(r);
    const certified = isCertified(r, gates);
    const deltaCell = r.isOosDelta > 0.5
      ? `${fmtPct(r.isOosDelta, 0)} (RED)`
      : fmtPct(r.isOosDelta, 0);
    lines.push(
      `| ${i + 1} | \`${configId(r.config)}\` | ${r.config.side} | ${fmtConfigSummary(r.config)} | ${fmt(r.isMeanExpectancy, 3)} | ${fmt(agg.expectancy, 3)} | ${deltaCell} | ${fmt(agg.sharpe, 2)} | ${agg.maxDrawdownR.toFixed(2)} | ${fmtPct(agg.topSymbolShare, 1)} | ${fmtCheck(certified)} |`,
    );
  });
  lines.push("");
  return lines.join("\n");
}

function renderTop3PerSymbol(results: readonly WalkForwardResult[]): string {
  if (results.length === 0) return "";
  const ranked = [...results].sort((a, b) => oosAggregateOf(b).expectancy - oosAggregateOf(a).expectancy);
  const top3 = ranked.slice(0, Math.min(3, ranked.length));
  const lines: string[] = [];
  lines.push("## Top-3 configs — per-symbol OOS breakdown");
  lines.push("");
  lines.push("Aggregated across folds 1-3 (test windows). Excludes the aggregate sanity fold.");
  lines.push("");
  for (const r of top3) {
    lines.push(`### ${configId(r.config)}`);
    lines.push("");
    // Build per-symbol aggregation from non-agg test trades.
    const nonAgg = r.folds.filter((f) => f.fold.id !== "agg");
    const bySym = new Map<string, { trades: number; totalR: number }>();
    for (const f of nonAgg) {
      for (const t of f.testTrades) {
        const sym = (t as { symbol?: string }).symbol ?? "UNKNOWN";
        const prev = bySym.get(sym) ?? { trades: 0, totalR: 0 };
        prev.trades += 1;
        prev.totalR += t.rMultiple;
        bySym.set(sym, prev);
      }
    }
    if (bySym.size === 0) {
      lines.push("_No OOS trades._");
      lines.push("");
      continue;
    }
    const rows = Array.from(bySym.entries())
      .map(([symbol, s]) => ({ symbol, ...s, expectancy: s.totalR / Math.max(1, s.trades) }))
      .sort((a, b) => b.totalR - a.totalR);
    lines.push("| Symbol | Trades | Expectancy | Total R |");
    lines.push("|---|---:|---:|---:|");
    for (const row of rows) {
      lines.push(`| ${row.symbol} | ${row.trades} | ${fmt(row.expectancy, 3)} | ${fmt(row.totalR, 2)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderConcentrationCheck(results: readonly WalkForwardResult[]): string {
  // Flag any config whose top-symbol-share (in any non-agg fold) exceeds 50%.
  const flagged: Array<{ config: BacktestConfigV2; foldId: string; share: number }> = [];
  for (const r of results) {
    for (const f of r.folds) {
      if (f.fold.id === "agg") continue;
      if (f.testStats.topSymbolShare > 0.5) {
        flagged.push({ config: r.config, foldId: f.fold.id, share: f.testStats.topSymbolShare });
      }
    }
  }
  const lines: string[] = [];
  lines.push("## Concentration check");
  lines.push("");
  if (flagged.length === 0) {
    lines.push("No config has a single symbol contributing > 50% of OOS R in any fold. Pass.");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("The following configs failed the concentration kill-switch (> 50% R from one symbol in at least one OOS fold). Treat their headline numbers as unrepresentative.");
  lines.push("");
  lines.push("| Config ID | Fold | Top symbol share |");
  lines.push("|---|---|---:|");
  for (const x of flagged) {
    lines.push(`| \`${configId(x.config)}\` | ${x.foldId} | ${fmtPct(x.share, 1)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderCertifiedSection(
  results: readonly WalkForwardResult[],
  opts: ReportOptions,
): string {
  const gates = opts.certificationGates;
  const certified = results.filter((r) => isCertified(r, gates));
  const lines: string[] = [];
  lines.push("## Certified configs");
  lines.push("");
  if (certified.length === 0) {
    lines.push("**No config passed all certification gates.**");
    lines.push("");
    lines.push("This is a legitimate outcome of an honest backtest, not a failure of the harness. The system either has no edge on this universe + window, or the gates are calibrated tighter than the signal can clear.");
    lines.push("");
    lines.push("Do NOT relax the gates in search of a pass. Either:");
    lines.push("");
    lines.push("- Investigate WHY no config certified (concentration? overfitting? all configs have OOS expectancy at-zero?). The ranked table above shows the per-gate failure pattern.");
    lines.push("- Accept \"no edge found\" and escalate to a v3 ticket (different timeframe, different signal, different universe).");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`**${certified.length} config(s) passed all gates.**`);
  lines.push("");
  lines.push("| Config ID | OOS expectancy | OOS Sharpe | OOS max DD | Top sym share |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const r of certified) {
    const agg = oosAggregateOf(r);
    lines.push(
      `| \`${configId(r.config)}\` | ${fmt(agg.expectancy, 3)} | ${fmt(agg.sharpe, 2)} | ${agg.maxDrawdownR.toFixed(2)} | ${fmtPct(agg.topSymbolShare, 1)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderPerGateBreakdown(
  results: readonly WalkForwardResult[],
  opts: ReportOptions,
): string {
  const gates = opts.certificationGates;
  const lines: string[] = [];
  lines.push("## Per-gate breakdown (top-10 by OOS expectancy)");
  lines.push("");
  const top = [...results]
    .sort((a, b) => oosAggregateOf(b).expectancy - oosAggregateOf(a).expectancy)
    .slice(0, Math.min(10, results.length));
  lines.push("| Config ID | OOS exp gate | OOS Sharpe gate | OOS DD gate | Concentration gate | Overfitting gate |");
  lines.push("|---|:---:|:---:|:---:|:---:|:---:|");
  for (const r of top) {
    const g = evaluateGates(r, gates);
    lines.push(
      `| \`${configId(r.config)}\` | ${fmtBool(g.oosExpectancyPass)} | ${fmtBool(g.oosSharpePass)} | ${fmtBool(g.maxDrawdownPass)} | ${fmtBool(g.concentrationPass)} | ${fmtBool(g.overfittingPass)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API — renderReport
// ---------------------------------------------------------------------------

/**
 * Render the full Markdown report to `opts.outputPath`. Creates parent
 * directories as needed. Overwrites any existing file.
 */
export async function renderReport(
  results: readonly WalkForwardResult[],
  opts: ReportOptions,
): Promise<void> {
  const sections: string[] = [
    renderHeader(opts),
    renderCertificationGates(opts, results),
    renderRankedTable(results, opts),
    renderPerGateBreakdown(results, opts),
    renderTop3PerSymbol(results),
    renderConcentrationCheck(results),
    renderCertifiedSection(results, opts),
  ];
  const body = sections.filter((s) => s.length > 0).join("\n");
  const dir = path.dirname(opts.outputPath);
  if (dir.length > 0) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(opts.outputPath, body, "utf-8");
}

// ---------------------------------------------------------------------------
// Public API — renderCertifiedConfigJson
// ---------------------------------------------------------------------------

/**
 * Return a copy-pasteable JSON block for the highest-OOS-expectancy CERTIFIED
 * config in `results`. Returns the empty string when no config qualifies.
 *
 * "Certified" here uses the architect's default gate values
 * (minOosExpectancy 0.10, minOosSharpe 1.0, maxDrawdownR 20,
 * maxTopSymbolShare 0.50, isOosDelta <= 0.5). Callers that need the same gate
 * thresholds as their report should ensure both use the same defaults.
 */
export function renderCertifiedConfigJson(results: readonly WalkForwardResult[]): string {
  const defaults: ReportOptions["certificationGates"] = {
    minOosExpectancy: 0.1,
    minOosSharpe: 1.0,
    maxDrawdownR: 20,
    maxTopSymbolShare: 0.5,
  };
  const certified = results.filter((r) => isCertified(r, defaults));
  if (certified.length === 0) return "";
  certified.sort((a, b) => oosAggregateOf(b).expectancy - oosAggregateOf(a).expectancy);
  const winner = certified[0]!;
  const cfg = winner.config;
  // Mirror the runtime BacktestConfigV2 shape. Stable key order for diff-friendliness.
  const obj = {
    configId: configId(cfg),
    side: cfg.side,
    thresholdComposite: cfg.thresholdComposite,
    requireStage2: cfg.requireStage2,
    requireBreakout: cfg.requireBreakout,
    stopAtrMult: cfg.stopAtrMult,
    horizonBars: cfg.horizonBars,
    cooldownBars: cfg.cooldownBars,
    warmupBars: cfg.warmupBars,
    stage2SmaPeriod: cfg.stage2SmaPeriod,
    metrics: {
      oosMeanExpectancy: winner.oosMeanExpectancy,
      isOosDelta: winner.isOosDelta,
    },
  };
  return JSON.stringify(obj, null, 2);
}
