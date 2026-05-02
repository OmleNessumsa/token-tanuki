import pc from "picocolors";
import type { AnalysisResult } from "./analyze.js";

export function formatVerdict(result: AnalysisResult): string {
  const { pair, security, phase, chart, verdict } = result;
  const lines: string[] = [];

  const verdictColor =
    verdict.verdict === "BUY" ? pc.bgGreen(pc.black(` ${verdict.verdict} `))
    : verdict.verdict === "WAIT" ? pc.bgYellow(pc.black(` ${verdict.verdict} `))
    : pc.bgRed(pc.white(` ${verdict.verdict} `));

  lines.push("");
  lines.push(`${verdictColor}  composite ${verdict.composite}/100`);
  lines.push("");

  if (pair) {
    const sym = `${pair.baseToken.symbol}/${pair.quoteToken.symbol}`;
    const liq = pair.liquidity?.usd ?? 0;
    const vol = pair.volume?.h24 ?? 0;
    const age = pair.pairCreatedAt ? hoursAgo(pair.pairCreatedAt) : "?";
    lines.push(pc.bold(`${pair.baseToken.name} (${sym})`));
    lines.push(`  ${pc.dim(result.chain.toUpperCase())} · ${pc.dim(pair.dexId)} · ${pc.dim(pair.pairAddress)}`);
    lines.push(`  Price: $${pair.priceUsd ?? "?"} · Liq: $${formatUsd(liq)} · 24h vol: $${formatUsd(vol)} · Age: ${age}`);
    if (pair.txns?.h24) lines.push(`  24h txns: ${pair.txns.h24.buys} buys / ${pair.txns.h24.sells} sells`);
    if (pair.priceChange) {
      const pcs = pair.priceChange;
      lines.push(`  Change: 5m ${fmtPct(pcs["m5"])} · 1h ${fmtPct(pcs["h1"])} · 24h ${fmtPct(pcs["h24"])}`);
    }
    lines.push("");
  }

  lines.push(pc.bold(`Security ${barScore(security.score)} ${security.score}/100`));
  if (security.fatals.length === 0 && security.findings.filter((f) => f.level === "warn").length === 0) {
    lines.push(pc.green("  ✓ no major issues found"));
  }
  for (const f of security.findings) {
    const icon = f.level === "fatal" ? pc.red("✗") : f.level === "warn" ? pc.yellow("⚠") : pc.green("✓");
    lines.push(`  ${icon} [${f.source}] ${f.message}`);
  }
  if (security.buyTax !== null || security.sellTax !== null) {
    lines.push(`  taxes: buy ${security.buyTax?.toFixed(1) ?? "?"}% / sell ${security.sellTax?.toFixed(1) ?? "?"}%`);
  }
  lines.push("");

  lines.push(pc.bold(`Phase: ${phase.phase} (${phase.buyability})`));
  lines.push(`  ${phase.reason}`);
  if (phase.ageHours !== null) lines.push(`  age: ${phase.ageHours.toFixed(1)}h · drawdown from ATH: ${(phase.ddFromAth * 100).toFixed(1)}%`);
  lines.push("");

  lines.push(pc.bold(`Chart ${barScore(chart.score)} ${chart.score}/100`));
  for (const note of chart.notes) lines.push(`  · ${note}`);
  lines.push("");

  lines.push(pc.bold("Reasoning:"));
  for (const r of verdict.reasons) lines.push(`  · ${r}`);
  if (verdict.caveats.length > 0) {
    lines.push("");
    lines.push(pc.bold(pc.yellow("Caveats:")));
    for (const c of verdict.caveats) lines.push(`  ${pc.yellow("⚠")} ${c}`);
  }

  return lines.join("\n");
}

function fmtPct(n: number | undefined): string {
  if (n === undefined) return "?";
  const s = `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  return n >= 0 ? pc.green(s) : pc.red(s);
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

function hoursAgo(unixMs: number): string {
  const h = (Date.now() - unixMs) / 3_600_000;
  if (h < 1) return `${(h * 60).toFixed(0)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function barScore(n: number): string {
  const filled = Math.round(n / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  if (n >= 70) return pc.green(bar);
  if (n >= 40) return pc.yellow(bar);
  return pc.red(bar);
}
