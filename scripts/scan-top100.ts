import { analyzeToken } from "../src/analyze.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ScanTarget {
  rank: number;
  symbol: string;
  name: string;
  chain: "ethereum" | "solana";
  address: string;
}

// Curated list: top-100-ish coins (May 2026 ranks, approximate) that have an
// ETH or SOL contract address and that we want analyzed. Excludes BTC, ETH,
// stablecoins, and L1-native tokens with no canonical ERC-20/SPL deployment.
const TARGETS: ScanTarget[] = [
  { rank: 16, symbol: "LEO",    name: "LEO Token",       chain: "ethereum", address: "0x2AF5D2aD76741191D15Dfe7bF6aC92d4Bd912Ca3" },
  { rank: 20, symbol: "LINK",   name: "Chainlink",       chain: "ethereum", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
  { rank: 22, symbol: "SHIB",   name: "Shiba Inu",       chain: "ethereum", address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE" },
  { rank: 28, symbol: "UNI",    name: "Uniswap",         chain: "ethereum", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" },
  { rank: 30, symbol: "MNT",    name: "Mantle",          chain: "ethereum", address: "0x3c3a81e81dc49A522A592e7622A7E711c06bf354" },
  { rank: 31, symbol: "PEPE",   name: "Pepe",            chain: "ethereum", address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933" },
  { rank: 32, symbol: "CRO",    name: "Cronos",          chain: "ethereum", address: "0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b" },
  { rank: 33, symbol: "AAVE",   name: "Aave",            chain: "ethereum", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9" },
  { rank: 38, symbol: "RENDER", name: "Render",          chain: "ethereum", address: "0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24" },
  { rank: 39, symbol: "ARB",    name: "Arbitrum",        chain: "ethereum", address: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1" },
  { rank: 40, symbol: "ENS",    name: "Ethereum Name Service", chain: "ethereum", address: "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72" },
  { rank: 41, symbol: "BONK",   name: "Bonk",            chain: "solana",   address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { rank: 44, symbol: "POL",    name: "Polygon Ecosystem Token", chain: "ethereum", address: "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6" },
  { rank: 45, symbol: "WIF",    name: "dogwifhat",       chain: "solana",   address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  { rank: 46, symbol: "FET",    name: "Fetch.ai",        chain: "ethereum", address: "0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85" },
  { rank: 47, symbol: "INJ",    name: "Injective",       chain: "ethereum", address: "0xe28b3B32B6c345A34Ff64674606124Dd5Aceca30" },
  { rank: 52, symbol: "IMX",    name: "Immutable",       chain: "ethereum", address: "0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF" },
  { rank: 54, symbol: "JUP",    name: "Jupiter",         chain: "solana",   address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { rank: 55, symbol: "MKR",    name: "Maker",           chain: "ethereum", address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2" },
  { rank: 57, symbol: "LDO",    name: "Lido DAO",        chain: "ethereum", address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32" },
  { rank: 58, symbol: "THETA",  name: "Theta Network",   chain: "ethereum", address: "0x3883f5e181fccaF8410FA61e12b59BAd963fb645" },
  { rank: 59, symbol: "ONDO",   name: "Ondo",            chain: "ethereum", address: "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3" },
  { rank: 62, symbol: "GRT",    name: "The Graph",       chain: "ethereum", address: "0xc944E90C64B2c07662A292be6244BDf05Cda44a7" },
  { rank: 63, symbol: "PYTH",   name: "Pyth Network",    chain: "solana",   address: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" },
  { rank: 65, symbol: "WLD",    name: "Worldcoin",       chain: "ethereum", address: "0x163f8C2467924be0ae7B5347228CABF260318753" },
  { rank: 66, symbol: "PENDLE", name: "Pendle",          chain: "ethereum", address: "0x808507121B80c02388fAd14726482e061B8da827" },
  { rank: 67, symbol: "STRK",   name: "Starknet",        chain: "ethereum", address: "0xCa14007Eff0dB1f8135f4C25B34De49AB0d42766" },
  { rank: 68, symbol: "JTO",    name: "Jito",            chain: "solana",   address: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL" },
  { rank: 69, symbol: "ENA",    name: "Ethena",          chain: "ethereum", address: "0x57e114B691Db790C35207b2e685D4A43181e6061" },
  { rank: 70, symbol: "RAY",    name: "Raydium",         chain: "solana",   address: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" },
  { rank: 71, symbol: "AXS",    name: "Axie Infinity",   chain: "ethereum", address: "0xBB0E17EF65F82Ab018d8EDd776e8DD940327B28b" },
  { rank: 73, symbol: "MANA",   name: "Decentraland",    chain: "ethereum", address: "0x0F5D2fB29fb7d3CFeE444a200298f468908cC942" },
  { rank: 74, symbol: "SAND",   name: "The Sandbox",     chain: "ethereum", address: "0x3845badAde8e6dFF049820680d1F14bD3903a5d0" },
  { rank: 75, symbol: "APE",    name: "ApeCoin",         chain: "ethereum", address: "0x4d224452801ACEd8B2F0aebE155379bb5D594381" },
  { rank: 76, symbol: "CHZ",    name: "Chiliz",          chain: "ethereum", address: "0x3506424F91fD33084466F402d5D97f05F8e3b4AF" },
  { rank: 77, symbol: "DYDX",   name: "dYdX",            chain: "ethereum", address: "0x92D6C1e31e14520e676a687F0a93788B716BEff5" },
  { rank: 78, symbol: "CRV",    name: "Curve DAO",       chain: "ethereum", address: "0xD533a949740bb3306d119CC777fa900bA034cd52" },
  { rank: 79, symbol: "MORPHO", name: "Morpho",          chain: "ethereum", address: "0x58D97B57BB95320F9a05dC918Aef65434969c2B2" },
  { rank: 82, symbol: "RPL",    name: "Rocket Pool",     chain: "ethereum", address: "0xD33526068D116cE69F19A9ee46F0bd304F21A51f" },
  { rank: 83, symbol: "SUSHI",  name: "SushiSwap",       chain: "ethereum", address: "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2" },
  { rank: 84, symbol: "ZRO",    name: "LayerZero",       chain: "ethereum", address: "0x6985884C4392D348587B19cb9eAAf157F13271cd" },
  { rank: 85, symbol: "COMP",   name: "Compound",        chain: "ethereum", address: "0xc00e94Cb662C3520282E6f5717214004A7f26888" },
  { rank: 86, symbol: "1INCH",  name: "1inch",           chain: "ethereum", address: "0x111111111117dC0aa78b770fA6A738034120C302" },
  { rank: 87, symbol: "GALA",   name: "Gala",            chain: "ethereum", address: "0xd1d2Eb1B1e90B638588728b4130137D262C87cae" },
  { rank: 88, symbol: "BLUR",   name: "Blur",            chain: "ethereum", address: "0x5283D291DBCF85356A21bA090E6db59121208b44" },
  { rank: 90, symbol: "OP",     name: "Optimism",        chain: "ethereum", address: "0x4200000000000000000000000000000000000042" },
  { rank: 91, symbol: "PEOPLE", name: "ConstitutionDAO", chain: "ethereum", address: "0x7A58c0Be72BE218B41C608b7Fe7C5bB630736C71" },
  { rank: 95, symbol: "FLOKI",  name: "Floki",           chain: "ethereum", address: "0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E" },
  { rank: 96, symbol: "SNX",    name: "Synthetix",       chain: "ethereum", address: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F" },
  { rank: 97, symbol: "JASMY",  name: "JasmyCoin",       chain: "ethereum", address: "0x7420B4b9a0110cdC71fB720908340C03F9Bc03EC" },
  { rank: 98, symbol: "FXS",    name: "Frax Share",      chain: "ethereum", address: "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0" },
  { rank: 99, symbol: "BAT",    name: "Basic Attention", chain: "ethereum", address: "0x0D8775F648430679A709E98d2b0Cb6250d2887EF" },
  { rank: 100, symbol: "ZK",    name: "ZKsync",          chain: "ethereum", address: "0x66a039Bf9bdaaA94135Ca2D2caf9DEED2D4D8aFf" },
];

interface ScanRow {
  rank: number;
  symbol: string;
  name: string;
  chain: "ethereum" | "solana";
  verdict: string;
  composite: number;
  trend: string;
  rsi: number | null;
  direction: string;
  liqUsd: number;
  change24h: number | null;
  reasons: string[];
  errors: string;
}

async function main(): Promise<void> {
  const rows: ScanRow[] = [];
  process.stderr.write(`scanning ${TARGETS.length} top-100 tokens (excluding BTC/ETH/stables)...\n\n`);

  for (let i = 0; i < TARGETS.length; i++) {
    const t = TARGETS[i]!;
    process.stderr.write(`[${(i + 1).toString().padStart(2)}/${TARGETS.length}] #${t.rank.toString().padStart(3)} ${t.symbol.padEnd(8)} (${t.chain})... `);
    try {
      const r = await analyzeToken(t.address);
      const direction = r.verdict.reasons.find((x) => x.startsWith("Direction:"))?.replace("Direction:", "").trim() ?? "?";
      rows.push({
        rank: t.rank,
        symbol: t.symbol,
        name: t.name,
        chain: t.chain,
        verdict: r.verdict.verdict,
        composite: r.verdict.composite,
        trend: r.chart.trend,
        rsi: r.chart.rsi,
        direction,
        liqUsd: r.pair?.liquidity?.usd ?? 0,
        change24h: r.pair?.priceChange?.["h24"] ?? null,
        reasons: r.verdict.reasons.slice(0, 3),
        errors: "",
      });
      process.stderr.write(`${r.verdict.verdict} ${r.verdict.composite}\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({
        rank: t.rank, symbol: t.symbol, name: t.name, chain: t.chain,
        verdict: "ERR", composite: 0, trend: "?", rsi: null, direction: "?",
        liqUsd: 0, change24h: null, reasons: [], errors: msg.slice(0, 100),
      });
      process.stderr.write(`ERR ${msg.slice(0, 60)}\n`);
    }
    await sleep(3500);
  }

  const order: Record<string, number> = { BUY: 0, WAIT: 1, AVOID: 2, ERR: 3 };
  rows.sort((a, b) => (order[a.verdict]! - order[b.verdict]!) || (b.composite - a.composite));

  console.log("");
  console.log("Top-100 scan (ex BTC/ETH/stables) — " + new Date().toISOString().slice(0, 16));
  console.log("");
  const fmt = (n: number | null, d = 1) => n === null ? "?" : n.toFixed(d);
  const fmtUsd = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
  const fmtPct = (n: number | null) => n === null ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  console.log("rank ".padEnd(6) + "symbol".padEnd(8) + "verdict".padEnd(8) + "comp".padEnd(6) + "dir".padEnd(10) + "trend".padEnd(8) + "rsi".padEnd(6) + "24h".padEnd(10) + "liq".padEnd(10) + "chain");
  console.log("─".repeat(90));
  for (const r of rows) {
    console.log(
      `#${r.rank}`.padEnd(6) +
      r.symbol.padEnd(8) +
      r.verdict.padEnd(8) +
      String(r.composite).padEnd(6) +
      r.direction.padEnd(10) +
      r.trend.padEnd(8) +
      fmt(r.rsi, 0).padEnd(6) +
      fmtPct(r.change24h).padEnd(10) +
      fmtUsd(r.liqUsd).padEnd(10) +
      r.chain,
    );
  }

  const buys = rows.filter((r) => r.verdict === "BUY");
  const waits = rows.filter((r) => r.verdict === "WAIT");
  const avoids = rows.filter((r) => r.verdict === "AVOID");
  const errs = rows.filter((r) => r.verdict === "ERR");

  console.log("");
  console.log(`Summary: ${buys.length} BUY · ${waits.length} WAIT · ${avoids.length} AVOID · ${errs.length} ERR`);
  console.log("");
  if (buys.length > 0) {
    console.log("=== BUY signals ===");
    for (const b of buys) {
      console.log(`  #${b.rank} ${b.symbol} (${b.name}) — composite ${b.composite}`);
      for (const reason of b.reasons) console.log(`      · ${reason}`);
    }
    console.log("");
  }
  if (waits.length > 0 && waits.length <= 10) {
    console.log("=== WAIT (top 10) ===");
    for (const w of waits.slice(0, 10)) {
      console.log(`  #${w.rank} ${w.symbol} composite ${w.composite}, dir ${w.direction}, ${fmtPct(w.change24h)} 24h`);
    }
  } else if (waits.length > 0) {
    console.log("=== WAIT (top 10 of " + waits.length + ") ===");
    for (const w of waits.slice(0, 10)) {
      console.log(`  #${w.rank} ${w.symbol} composite ${w.composite}, dir ${w.direction}, ${fmtPct(w.change24h)} 24h`);
    }
  }

  const fs = await import("node:fs");
  const outPath = `/tmp/scan-top100-${Date.now()}.json`;
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  console.log("");
  console.log(`Full JSON: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
