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
import { signRequest } from "../src/clients/blofin-private.js";
import { fetchJson } from "../src/http.js";

const BASE = "https://openapi.blofin.com";

interface Row { currency: string; balance: string; available: string; frozen: string }
interface Env { code: string; msg: string; data: Row[] }

async function fetchAccount(accountType: "spot" | "futures"): Promise<Row[]> {
  const path = `/api/v1/asset/balances?accountType=${accountType}`;
  const env = await fetchJson<Env>(`${BASE}${path}`, { headers: signRequest("GET", path) });
  if (env.code !== "0") throw new Error(`code=${env.code} msg=${env.msg}`);
  return env.data ?? [];
}

function renderNonZero(label: string, rows: Row[]): number {
  const sorted = rows.slice().sort((a, b) => Number(b.balance) - Number(a.balance));
  let n = 0;
  for (const r of sorted) {
    const bal = Number(r.balance);
    const avail = Number(r.available);
    const frozen = Number(r.frozen);
    if (bal === 0 && avail === 0 && frozen === 0) continue;
    if (n === 0) process.stdout.write(pc.bold(`  ${label}:\n`));
    process.stdout.write(
      `    ${r.currency.padEnd(8)}  balance=${bal.toFixed(6)}  available=${avail.toFixed(6)}  frozen=${frozen.toFixed(6)}\n`,
    );
    n++;
  }
  return n;
}

async function main(): Promise<void> {
  process.stdout.write(pc.bold("Blofin auth smoke — balances (spot + futures)\n\n"));
  let spot: Row[] = [];
  let futures: Row[] = [];
  try {
    [spot, futures] = await Promise.all([fetchAccount("spot"), fetchAccount("futures")]);
  } catch (e) {
    process.stderr.write(pc.red(`auth failed: ${e instanceof Error ? e.message : e}\n`));
    process.exit(1);
  }

  const spotN = renderNonZero("Spot wallet", spot);
  const futN = renderNonZero("Futures wallet", futures);

  if (spotN + futN === 0) {
    process.stdout.write(pc.dim("  (no non-zero balances on either account)\n"));
  }
  process.stdout.write("\n" + pc.green("  ✓ auth pipeline verified\n"));

  // Friendly nudge if funds are on the wrong side for trading our top-10
  // USDT-margined perps.
  const spotUsdc = spot.find((r) => r.currency === "USDC" && Number(r.balance) > 0);
  const futUsdt = futures.find((r) => r.currency === "USDT" && Number(r.balance) > 0);
  if (spotUsdc && !futUsdt) {
    process.stdout.write("\n" + pc.yellow(
      "  ⚠ USDC sits on spot, futures USDT is empty.\n" +
      "  ⚠ For live trading on USDT-margined perps: Convert USDC→USDT (spot)\n" +
      "  ⚠ then Transfer USDT from spot → futures wallet in the Blofin app.\n" +
      "  ⚠ Paper-trading does NOT require this — public prices are enough.\n",
    ));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
