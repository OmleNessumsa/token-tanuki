import { analyzeToken } from "../src/analyze.js";

const TOKENS: Array<{ symbol: string; address: string }> = [
  // Ethereum ERC-20 (top-100 with deep DEX liquidity)
  { symbol: "WETH",   address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { symbol: "LINK",   address: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
  { symbol: "UNI",    address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" },
  { symbol: "AAVE",   address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9" },
  { symbol: "MKR",    address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2" },
  { symbol: "LDO",    address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32" },
  { symbol: "ONDO",   address: "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3" },
  { symbol: "INJ",    address: "0xe28b3B32B6c345A34Ff64674606124Dd5Aceca30" },
  { symbol: "ENS",    address: "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72" },
  { symbol: "ARB",    address: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1" },
  { symbol: "IMX",    address: "0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF" },
  { symbol: "FET",    address: "0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85" },
  { symbol: "GRT",    address: "0xc944E90C64B2c07662A292be6244BDf05Cda44a7" },
  { symbol: "RENDER", address: "0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24" },
  { symbol: "PEPE",   address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933" },
  { symbol: "SHIB",   address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE" },
  { symbol: "CRV",    address: "0xD533a949740bb3306d119CC777fa900bA034cd52" },
  { symbol: "COMP",   address: "0xc00e94Cb662C3520282E6f5717214004A7f26888" },

  // Solana SPL
  { symbol: "SOL",    address: "So11111111111111111111111111111111111111112" },
  { symbol: "BONK",   address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { symbol: "WIF",    address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  { symbol: "JUP",    address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "JTO",    address: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL" },
  { symbol: "PYTH",   address: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" },
  { symbol: "RAY",    address: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" },
];

interface Row {
  symbol: string;
  verdict: string;
  composite: number;
  trend: string;
  rsi: number | null;
  direction: string;
  liqUsd: number;
  change24h: number | null;
  reason: string;
  err?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const rows: Row[] = [];
  for (const t of TOKENS) {
    process.stderr.write(`scanning ${t.symbol}... `);
    try {
      const r = await analyzeToken(t.address);
      const direction = r.verdict.reasons.find((x) => x.startsWith("Direction:"))?.replace("Direction:", "").trim() ?? "?";
      rows.push({
        symbol: t.symbol,
        verdict: r.verdict.verdict,
        composite: r.verdict.composite,
        trend: r.chart.trend,
        rsi: r.chart.rsi,
        direction,
        liqUsd: r.pair?.liquidity?.usd ?? 0,
        change24h: r.pair?.priceChange?.["h24"] ?? null,
        reason: r.verdict.reasons[0] ?? "",
      });
      process.stderr.write(`${r.verdict.verdict} ${r.verdict.composite}\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({ symbol: t.symbol, verdict: "ERR", composite: 0, trend: "?", rsi: null, direction: "?", liqUsd: 0, change24h: null, reason: msg, err: msg });
      process.stderr.write(`ERR ${msg}\n`);
    }
    await sleep(2500); // pace for GeckoTerminal/GoPlus
  }

  // Sort: BUY > WAIT > AVOID > ERR; within group by composite desc
  const order: Record<string, number> = { BUY: 0, WAIT: 1, AVOID: 2, ERR: 3 };
  rows.sort((a, b) => (order[a.verdict]! - order[b.verdict]!) || (b.composite - a.composite));

  const fmt = (n: number | null, d = 1) => n === null ? "?" : n.toFixed(d);
  const fmtUsd = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
  const fmtPct = (n: number | null) => n === null ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

  console.log("");
  console.log("symbol".padEnd(8) + "verdict".padEnd(8) + "comp".padEnd(6) + "dir".padEnd(10) + "trend".padEnd(8) + "rsi".padEnd(6) + "24h".padEnd(10) + "liq".padEnd(10));
  console.log("─".repeat(70));
  for (const r of rows) {
    console.log(
      r.symbol.padEnd(8) +
      r.verdict.padEnd(8) +
      String(r.composite).padEnd(6) +
      r.direction.padEnd(10) +
      r.trend.padEnd(8) +
      fmt(r.rsi, 0).padEnd(6) +
      fmtPct(r.change24h).padEnd(10) +
      fmtUsd(r.liqUsd).padEnd(10),
    );
  }

  const buys = rows.filter((r) => r.verdict === "BUY");
  console.log("");
  if (buys.length > 0) {
    console.log(`Top BUY: ${buys[0]!.symbol} (composite ${buys[0]!.composite})`);
  } else {
    console.log("No BUY signals across the scanned set. Top WAIT:");
    const waits = rows.filter((r) => r.verdict === "WAIT").slice(0, 3);
    for (const w of waits) console.log(`  ${w.symbol} composite ${w.composite}, dir ${w.direction}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
