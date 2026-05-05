/**
 * Quick crypto market sentiment snapshot.
 * Sources:
 *   - Fear & Greed Index (alternative.me, free, no key)
 *   - BTC dominance + total market cap (CoinGecko, demo key)
 *   - Funding rates across top perps (MEXC, no key)
 *   - 24h winners/losers proxy from MEXC
 */
import { fetchJson } from "../src/http.js";
import { config } from "../src/config.js";
import { getFundingRate, analyzeFundingRate } from "../src/clients/mexc-futures.js";

interface FngEntry { value: string; value_classification: string; timestamp: string; }
interface FngResp { data: FngEntry[]; }

interface CgGlobalResp {
  data: {
    market_cap_percentage: Record<string, number>;
    total_market_cap: Record<string, number>;
    market_cap_change_percentage_24h_usd: number;
    active_cryptocurrencies: number;
  };
}

interface MexcTicker { symbol: string; lastPrice: number; amount24: number; riseFallRate: number; }
interface MexcTickerResp { success: boolean; data: MexcTicker[]; }

const TOP_PERPS = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "DOGE_USDT", "TONCOIN_USDT", "ADA_USDT", "BCH_USDT", "PEPE_USDT", "ENA_USDT"];

async function main(): Promise<void> {
  console.log("Fetching market sentiment data...\n");

  const [fng, cg, allTickers, ...fundings] = await Promise.all([
    fetchJson<FngResp>("https://api.alternative.me/fng/?limit=14"),
    fetchJson<CgGlobalResp>("https://api.coingecko.com/api/v3/global", config.coingeckoKey ? { headers: { "x-cg-demo-api-key": config.coingeckoKey } } : {}),
    fetchJson<MexcTickerResp>("https://contract.mexc.com/api/v1/contract/ticker"),
    ...TOP_PERPS.map((s) => getFundingRate(s)),
  ]);

  // ===== Fear & Greed =====
  const today = fng.data[0]!;
  const yesterday = fng.data[1];
  const week = fng.data[7];
  const trend = yesterday ? parseInt(today.value) - parseInt(yesterday.value) : 0;
  const weekTrend = week ? parseInt(today.value) - parseInt(week.value) : 0;

  console.log("═══════════════════════════════════════");
  console.log("  CRYPTO SENTIMENT — " + new Date().toISOString().slice(0, 16));
  console.log("═══════════════════════════════════════\n");

  console.log(`📊 FEAR & GREED INDEX`);
  console.log(`   Today:     ${today.value}/100  (${today.value_classification})`);
  if (yesterday) console.log(`   Yesterday: ${yesterday.value}/100  (${yesterday.value_classification})  ${trend >= 0 ? "+" : ""}${trend}`);
  if (week) console.log(`   7 days ago: ${week.value}/100  (${week.value_classification})  ${weekTrend >= 0 ? "+" : ""}${weekTrend}`);
  const fngVal = parseInt(today.value);
  const fngRead =
    fngVal < 25 ? "🔴 Extreme Fear — historically a buy zone"
    : fngVal < 45 ? "🟡 Fear — caution but not panic"
    : fngVal < 55 ? "⚪ Neutral"
    : fngVal < 75 ? "🟢 Greed — late-cycle warning"
    : "🚨 Extreme Greed — top warning";
  console.log(`   Read: ${fngRead}\n`);

  // ===== Market structure =====
  const btcD = cg.data.market_cap_percentage["btc"] ?? 0;
  const ethD = cg.data.market_cap_percentage["eth"] ?? 0;
  const totalMcap = cg.data.total_market_cap["usd"] ?? 0;
  const mcapChange = cg.data.market_cap_change_percentage_24h_usd;

  console.log(`🏛  MARKET STRUCTURE`);
  console.log(`   Total cap:  $${(totalMcap / 1e12).toFixed(2)}T  (24h ${mcapChange >= 0 ? "+" : ""}${mcapChange.toFixed(2)}%)`);
  console.log(`   BTC.D:      ${btcD.toFixed(2)}%`);
  console.log(`   ETH.D:      ${ethD.toFixed(2)}%`);
  console.log(`   Active coins: ${cg.data.active_cryptocurrencies.toLocaleString()}`);
  const btcDRead =
    btcD > 60 ? "🔴 BTC dominant — alt season unlikely"
    : btcD > 55 ? "🟡 BTC majority — alts can move but BTC leads"
    : btcD > 50 ? "⚪ Balanced — early alt rotation possible"
    : "🟢 Alts dominant — full altseason regime";
  console.log(`   Read: ${btcDRead}\n`);

  // ===== Funding rates across top perps =====
  console.log(`💸 FUNDING RATES (per 8h cycle, top perps)`);
  let euphoricCount = 0, crowdedCount = 0, neutralCount = 0, paidToLongCount = 0;
  for (let i = 0; i < TOP_PERPS.length; i++) {
    const sym = TOP_PERPS[i]!;
    const f = fundings[i];
    if (!f) { console.log(`   ${sym.padEnd(15)} no data`); continue; }
    const a = analyzeFundingRate(f);
    if (a.regime === "euphoria") euphoricCount++;
    else if (a.regime === "crowded_long") crowdedCount++;
    else if (a.regime === "paid_to_long") paidToLongCount++;
    else neutralCount++;
    const icon = a.regime === "euphoria" ? "🚨" : a.regime === "crowded_long" ? "⚠️ " : a.regime === "paid_to_long" ? "🟢" : "⚪";
    console.log(`   ${icon} ${sym.replace("_USDT", "").padEnd(8)} ${(f.fundingRate * 100).toFixed(4)}%/cycle  ${a.apr.toFixed(1)}% APR  ${a.regime}`);
  }
  console.log("");
  let positioningRead: string;
  if (euphoricCount >= 3) positioningRead = "🚨 EXTREME LONG POSITIONING — high reversal risk across the board";
  else if (crowdedCount >= 4) positioningRead = "⚠️  Crowded longs — squeeze risk if BTC drops";
  else if (paidToLongCount >= 3) positioningRead = "🟢 Shorts paying — contrarian bullish setup";
  else positioningRead = "⚪ Neutral funding — no extreme positioning";
  console.log(`   Read: ${positioningRead}\n`);

  // ===== Top movers =====
  const usdtPerps = allTickers.data.filter((t) => t.symbol.endsWith("_USDT")).filter((t) => t.amount24 > 50_000_000);
  const winners = [...usdtPerps].sort((a, b) => b.riseFallRate - a.riseFallRate).slice(0, 7);
  const losers = [...usdtPerps].sort((a, b) => a.riseFallRate - b.riseFallRate).slice(0, 7);

  console.log(`📈 TOP 7 GAINERS (24h, vol > $50M)`);
  for (const t of winners) console.log(`   ${t.symbol.padEnd(20)} ${(t.riseFallRate * 100 >= 0 ? "+" : "") + (t.riseFallRate * 100).toFixed(2)}%  vol $${(t.amount24 / 1e6).toFixed(0)}M`);
  console.log("");
  console.log(`📉 TOP 7 LOSERS (24h, vol > $50M)`);
  for (const t of losers) console.log(`   ${t.symbol.padEnd(20)} ${(t.riseFallRate * 100).toFixed(2)}%  vol $${(t.amount24 / 1e6).toFixed(0)}M`);
  console.log("");

  // ===== Composite sentiment score =====
  let score = 50;
  // F&G contributes ±20
  score += (fngVal - 50) * 0.4;
  // 24h market cap change ±10
  score += Math.max(-10, Math.min(10, mcapChange * 2));
  // Funding contribution ±10
  if (euphoricCount >= 3) score -= 15;
  else if (crowdedCount >= 4) score -= 8;
  else if (paidToLongCount >= 3) score += 10;
  // BTC.D contribution: high BTC.D ±5 (alts under pressure)
  if (btcD > 60) score -= 5;
  else if (btcD < 50) score += 5;
  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict: string;
  if (score >= 75) verdict = "🟢 RISK-ON — favorable for new longs";
  else if (score >= 55) verdict = "🟢 Mildly bullish — selective longs OK";
  else if (score >= 45) verdict = "⚪ Neutral — wait for direction";
  else if (score >= 30) verdict = "🟡 Cautious — reduce exposure, tighten stops";
  else verdict = "🔴 RISK-OFF — defensive, hedge or close longs";

  console.log("═══════════════════════════════════════");
  console.log(`  COMPOSITE SENTIMENT: ${score}/100`);
  console.log(`  ${verdict}`);
  console.log("═══════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exit(1); });
