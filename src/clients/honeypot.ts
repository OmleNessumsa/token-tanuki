import { endpoints } from "../config.js";
import { fetchJson } from "../http.js";
import { HoneypotResponse, type HoneypotResponse as Honeypot } from "../schemas.js";

const EVM_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  bsc: 56,
  base: 8453,
};

export async function isHoneypot(address: string, chain = "ethereum"): Promise<Honeypot | null> {
  const chainID = EVM_CHAIN_IDS[chain];
  if (chainID === undefined) return null;
  const url = `${endpoints.honeypot}/v2/IsHoneypot?address=${address}&chainID=${chainID}`;
  try {
    const raw = await fetchJson<unknown>(url);
    const parsed = HoneypotResponse.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
