/**
 * Read-only auth smoke test: reads .env, signs a single GET to /asset/balances,
 * prints a compact account summary. Use to verify credentials + HMAC pipeline
 * before relying on private endpoints from the adapter.
 *
 * Run: npx tsx scripts/smoke-blofin.ts
 *
 * Exit codes:
 *   0 — balances fetched cleanly
 *   1 — auth or network failure (full error printed to stderr)
 */

import pc from "picocolors";
import { getBalances } from "../src/clients/blofin-private.js";

async function main(): Promise<void> {
  process.stdout.write(pc.bold("Blofin auth smoke — futures balances\n\n"));
  let rows;
  try {
    rows = await getBalances("futures");
  } catch (e) {
    process.stderr.write(pc.red(`auth failed: ${e instanceof Error ? e.message : e}\n`));
    process.exit(1);
  }

  if (rows.length === 0) {
    process.stdout.write(pc.dim("  (account has no balance rows — fund USDT to start trading)\n"));
    return;
  }

  // Show non-zero balances first; zeros at the end if present.
  const sorted = rows.slice().sort((a, b) => Number(b.balance) - Number(a.balance));
  let nonZero = 0;
  for (const r of sorted) {
    const bal = Number(r.balance);
    const avail = Number(r.available);
    const frozen = Number(r.frozen);
    if (bal === 0 && avail === 0 && frozen === 0) continue;
    process.stdout.write(
      `  ${r.currency.padEnd(8)}  balance=${bal.toFixed(6)}  available=${avail.toFixed(6)}  frozen=${frozen.toFixed(6)}\n`,
    );
    nonZero++;
  }
  if (nonZero === 0) {
    process.stdout.write(pc.dim(`  (${rows.length} rows, all zero — fund USDT to start trading)\n`));
  } else {
    process.stdout.write("\n" + pc.green(`  ✓ auth pipeline verified — ${nonZero} non-zero balance row(s)\n`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
