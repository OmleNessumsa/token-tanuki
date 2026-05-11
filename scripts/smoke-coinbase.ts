/**
 * S2a smoke test — exercise coinbaseSpotAdapter end-to-end against live
 * Coinbase Advanced Trade public endpoints. Run with `npx tsx scripts/smoke-coinbase.ts`.
 */

import { coinbaseSpotAdapter as cb } from "../src/clients/coinbase-adapter.js";

async function main() {
  console.log("=== findCanonicalSymbol(BTC) ===");
  const sym = await cb.findCanonicalSymbol("BTC");
  console.log("→", sym);

  console.log("\n=== getTicker(BTC-USD) ===");
  const t = await cb.getTicker("BTC-USD");
  console.log(t);

  console.log("\n=== getKlines(BTC-USD, 1h, 10) ===");
  const c1h = await cb.getKlines("BTC-USD", "1h", 10);
  console.log("returned", c1h.length, "bars");
  console.log("first:", c1h[0]);
  console.log("last :", c1h[c1h.length - 1]);

  console.log("\n=== getKlines(BTC-USD, 4h, 5) — aggregated from 1h × 4 ===");
  const c4h = await cb.getKlines("BTC-USD", "4h", 5);
  console.log("returned", c4h.length, "4h bars");
  console.log("first:", c4h[0]);

  console.log("\n=== symbolExists(BTC-USD) ===");
  console.log(await cb.symbolExists("BTC-USD"));
  console.log("=== symbolExists(NONEXIST-USD) ===");
  console.log(await cb.symbolExists("NONEXIST-USD"));

  console.log("\n=== findCanonicalSymbol(MATIC) — should resolve to POL-USD ===");
  console.log("→", await cb.findCanonicalSymbol("MATIC"));

  console.log("\n=== findCanonicalSymbol(ETH/SOL/XRP/DOGE/ADA/AVAX/LINK/DOT) ===");
  for (const a of ["ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT"]) {
    console.log(`  ${a} → ${await cb.findCanonicalSymbol(a)}`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
