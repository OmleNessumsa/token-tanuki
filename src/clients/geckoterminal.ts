import { endpoints } from "../config.js";
import { fetchJson } from "../http.js";
import { GeckoOhlcvResponse, type OhlcvCandle } from "../schemas.js";
import type { Chain } from "../chain.js";
import { NETWORK_SLUGS } from "../chain.js";

export type Timeframe = "minute" | "hour" | "day";

export interface OhlcvRequest {
  chain: Chain;
  poolAddress: string;
  timeframe: Timeframe;
  aggregate?: number;
  limit?: number;
}

const HEADERS = { Accept: "application/json;version=20230302" };

export async function getOhlcv(req: OhlcvRequest): Promise<OhlcvCandle[]> {
  const slug = NETWORK_SLUGS.geckoterminal[req.chain];
  const params = new URLSearchParams({
    aggregate: String(req.aggregate ?? 1),
    limit: String(Math.min(req.limit ?? 200, 1000)),
    currency: "usd",
    token: "base",
  });
  const url = `${endpoints.geckoterminal}/networks/${slug}/pools/${req.poolAddress}/ohlcv/${req.timeframe}?${params}`;
  try {
    const raw = await fetchJson<unknown>(url, { headers: HEADERS });
    const parsed = GeckoOhlcvResponse.safeParse(raw);
    if (!parsed.success) return [];
    return [...parsed.data.data.attributes.ohlcv_list].sort((a, b) => a[0] - b[0]);
  } catch {
    return [];
  }
}
