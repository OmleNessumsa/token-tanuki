import { config, endpoints } from "../config.js";
import { fetchJson } from "../http.js";
import {
  GoPlusEvmResponse,
  GoPlusSolanaResponse,
  type GoPlusEvmToken,
  type GoPlusSolanaToken,
} from "../schemas.js";

function authHeaders(): Record<string, string> {
  return config.goplusToken ? { Authorization: `Bearer ${config.goplusToken}` } : {};
}

export async function getEvmTokenSecurity(
  chainId: number,
  address: string,
): Promise<GoPlusEvmToken | null> {
  const url = `${endpoints.goplus}/api/v1/token_security/${chainId}?contract_addresses=${address}`;
  try {
    const raw = await fetchJson<unknown>(url, { headers: authHeaders() });
    const parsed = GoPlusEvmResponse.safeParse(raw);
    if (!parsed.success || !parsed.data.result) return null;
    const lower = address.toLowerCase();
    return parsed.data.result[lower] ?? Object.values(parsed.data.result)[0] ?? null;
  } catch {
    return null;
  }
}

export async function getSolanaTokenSecurity(mint: string): Promise<GoPlusSolanaToken | null> {
  const url = `${endpoints.goplus}/api/v1/solana/token_security?contract_addresses=${mint}`;
  try {
    const raw = await fetchJson<unknown>(url, { headers: authHeaders() });
    const parsed = GoPlusSolanaResponse.safeParse(raw);
    if (!parsed.success || !parsed.data.result) return null;
    return parsed.data.result[mint] ?? Object.values(parsed.data.result)[0] ?? null;
  } catch {
    return null;
  }
}
