#!/usr/bin/env node
import { analyzeToken } from "./analyze.js";
import { formatVerdict } from "./format.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printHelp();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const json = args.includes("--json");
  const address = args.find((a) => !a.startsWith("--"));
  if (!address) {
    printHelp();
    process.exit(1);
  }

  try {
    const result = await analyzeToken(address);
    if (json) {
      const { candles: _candles, ...rest } = result;
      process.stdout.write(JSON.stringify(rest, null, 2) + "\n");
    } else {
      process.stdout.write(formatVerdict(result) + "\n");
    }
    process.exit(result.verdict.verdict === "AVOID" ? 2 : 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
  }
}

function printHelp(): void {
  process.stdout.write(
`cryptotrader — give it a token address, get a buy/wait/avoid verdict.

Usage:
  cryptotrader <address> [--json]

Examples:
  cryptotrader 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48     # USDC on Ethereum
  cryptotrader EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   # USDC on Solana

Exit codes:
  0  BUY or WAIT
  1  invocation error
  2  AVOID
`);
}

main();
