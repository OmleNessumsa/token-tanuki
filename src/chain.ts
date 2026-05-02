export type Chain = "ethereum" | "solana";

const ETH_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function detectChain(address: string): Chain | null {
  const trimmed = address.trim();
  if (ETH_RE.test(trimmed)) return "ethereum";
  if (SOL_RE.test(trimmed)) return "solana";
  return null;
}

export function normalizeAddress(address: string, chain: Chain): string {
  const trimmed = address.trim();
  return chain === "ethereum" ? trimmed.toLowerCase() : trimmed;
}

export const NETWORK_SLUGS = {
  dexscreener: { ethereum: "ethereum", solana: "solana" },
  geckoterminal: { ethereum: "eth", solana: "solana" },
  birdeye: { ethereum: "ethereum", solana: "solana" },
  goplusEvmChainId: { ethereum: 1 },
} as const;
