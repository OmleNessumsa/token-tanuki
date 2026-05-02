import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadEnv(): void {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  const body = readFileSync(path, "utf8");
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

export const config = {
  birdeyeKey: process.env.BIRDEYE_API_KEY ?? "",
  heliusKey: process.env.HELIUS_API_KEY ?? "",
  etherscanKey: process.env.ETHERSCAN_API_KEY ?? "",
  goplusToken: process.env.GOPLUS_ACCESS_TOKEN ?? "",
} as const;

export const endpoints = {
  dexscreener: "https://api.dexscreener.com",
  geckoterminal: "https://api.geckoterminal.com/api/v2",
  goplus: "https://api.gopluslabs.io",
  honeypot: "https://api.honeypot.is",
  rugcheck: "https://api.rugcheck.xyz/v1",
  birdeye: "https://public-api.birdeye.so",
  helius: "https://mainnet.helius-rpc.com",
  etherscan: "https://api.etherscan.io/v2/api",
} as const;
