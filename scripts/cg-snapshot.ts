/**
 * Quick CoinGlass connectivity + snapshot test.
 *
 * Usage:
 *   npx tsx scripts/cg-snapshot.ts BTC
 *   npx tsx scripts/cg-snapshot.ts ZEC
 */
import { getSnapshot } from "../src/clients/coinglass.js";

async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? "BTC").toUpperCase();
  process.stderr.write(`Fetching CoinGlass snapshot for ${symbol}...\n\n`);
  const snap = await getSnapshot(symbol);

  console.log(`═══ CoinGlass snapshot — ${snap.symbol} ═══\n`);

  if (snap.funding) {
    const { maxPct, minPct, medianPct, sources } = snap.funding;
    console.log(`Funding rate (${sources} exchanges):`);
    console.log(`  median: ${medianPct.toFixed(4)}% per 8h  (annualized ≈ ${(medianPct * 3 * 365).toFixed(1)}%)`);
    console.log(`  range:  ${minPct.toFixed(4)}% .. ${maxPct.toFixed(4)}%`);
    if (medianPct > 0.05) console.log(`  ⚠ overcrowded longs — squeeze-down risk`);
    else if (medianPct < -0.03) console.log(`  ⚠ overcrowded shorts — squeeze-up risk`);
    else console.log(`  neutral`);
  } else {
    console.log("Funding: n/a");
  }

  console.log("");
  if (snap.oiChangePct24h !== null) {
    const sign = snap.oiChangePct24h >= 0 ? "+" : "";
    console.log(`OI change 24h:    ${sign}${snap.oiChangePct24h.toFixed(2)}%`);
  } else {
    console.log("OI change 24h:    n/a");
  }

  if (snap.liqSkew24h) {
    const longPct = (snap.liqSkew24h.longShare * 100).toFixed(0);
    const totM = (snap.liqSkew24h.totalUsd / 1_000_000).toFixed(1);
    console.log(`Liq skew 24h:     ${longPct}% long-liqs / ${100 - Number(longPct)}% short-liqs · $${totM}M total`);
  } else {
    console.log("Liq skew 24h:     n/a");
  }

  if (snap.takerPressure24h !== null) {
    const v = snap.takerPressure24h;
    const arrow = v > 0.1 ? "↑ buyers" : v < -0.1 ? "↓ sellers" : "→ balanced";
    console.log(`Taker pressure:   ${(v * 100).toFixed(1)}%  ${arrow}`);
  } else {
    console.log("Taker pressure:   n/a");
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
