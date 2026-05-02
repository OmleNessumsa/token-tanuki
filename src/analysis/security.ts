import type {
  GoPlusEvmToken,
  GoPlusSolanaToken,
  HoneypotResponse,
  RugcheckReport,
} from "../schemas.js";
import type { Chain } from "../chain.js";

export interface SecurityFinding {
  level: "fatal" | "warn" | "info" | "good";
  source: string;
  message: string;
}

export interface SecurityReport {
  findings: SecurityFinding[];
  fatals: SecurityFinding[];
  buyTax: number | null;
  sellTax: number | null;
  topHolderPct: number | null;
  lpLockedOrBurned: boolean | null;
  honeypot: boolean;
  score: number; // 0-100, higher = safer
}

const isFlagged = (v: string | undefined): boolean => v === "1" || v === "true";

const known_legit_authorities = new Set([
  // USDC, USDT, etc — not exhaustive; expand as needed.
  "BXXkv6z8ykpG1yuvUDPgh732wzVHB69RnB9YgSYh3itW", // USDC freeze authority
  "9SWy3pdcLTAkx8GPWVm4DqJ3D4d8w6SHyhjKgPTrYzWf", // USDC mint authority (placeholder)
]);

export interface EvmContext {
  pairAgeHours: number | null;
  pairLiquidityUsd: number | null;
  isV3Pair: boolean;
}

export function evaluateEvmSecurity(
  goplus: GoPlusEvmToken | null,
  honeypot: HoneypotResponse | null,
  pairAgeHoursOrCtx: number | null | EvmContext,
): SecurityReport {
  const ctx: EvmContext = typeof pairAgeHoursOrCtx === "object" && pairAgeHoursOrCtx !== null
    ? pairAgeHoursOrCtx
    : { pairAgeHours: pairAgeHoursOrCtx, pairLiquidityUsd: null, isV3Pair: false };
  const pairAgeHours = ctx.pairAgeHours;
  const isTrusted = goplus?.trust_list === "1";
  const isLongLivedBlueChip = (ctx.pairAgeHours ?? 0) > 24 * 365 && (ctx.pairLiquidityUsd ?? 0) > 1_000_000;
  const findings: SecurityFinding[] = [];
  const fatals: SecurityFinding[] = [];

  let buyTax: number | null = null;
  let sellTax: number | null = null;
  let topHolderPct: number | null = null;
  let lpLockedOrBurned: boolean | null = null;
  let isHoney = false;

  if (honeypot?.honeypotResult?.isHoneypot) {
    isHoney = true;
    fatals.push({
      level: "fatal",
      source: "honeypot.is",
      message: `Honeypot detected: ${honeypot.honeypotResult.honeypotReason ?? "sell simulation reverted"}`,
    });
  }
  if (honeypot?.simulationResult) {
    buyTax = honeypot.simulationResult.buyTax ?? null;
    sellTax = honeypot.simulationResult.sellTax ?? null;
    if (sellTax !== null && sellTax > 15) {
      fatals.push({ level: "fatal", source: "honeypot.is", message: `Sell tax ${sellTax.toFixed(1)}% > 15%` });
    } else if (sellTax !== null && sellTax > 5) {
      findings.push({ level: "warn", source: "honeypot.is", message: `Sell tax ${sellTax.toFixed(1)}%` });
    }
    if (buyTax !== null && buyTax > 15) {
      fatals.push({ level: "fatal", source: "honeypot.is", message: `Buy tax ${buyTax.toFixed(1)}% > 15%` });
    }
  }

  if (goplus) {
    if (isFlagged(goplus.is_honeypot)) {
      isHoney = true;
      fatals.push({ level: "fatal", source: "goplus", message: "Marked as honeypot" });
    }
    if (isFlagged(goplus.cannot_sell_all)) {
      fatals.push({ level: "fatal", source: "goplus", message: "cannot_sell_all = 1 (honeypot pattern)" });
    }
    if (isFlagged(goplus.cannot_buy)) {
      fatals.push({ level: "fatal", source: "goplus", message: "cannot_buy = 1" });
    }
    if (goplus.is_open_source !== undefined && !isFlagged(goplus.is_open_source) && (pairAgeHours ?? 0) > 24) {
      fatals.push({ level: "fatal", source: "goplus", message: "Contract source not verified (token > 24h old)" });
    }
    if (isFlagged(goplus.hidden_owner)) {
      fatals.push({ level: "fatal", source: "goplus", message: "Hidden owner detected" });
    }
    if (isFlagged(goplus.can_take_back_ownership)) {
      fatals.push({ level: "fatal", source: "goplus", message: "Owner can be reclaimed after renounce" });
    }
    if (isFlagged(goplus.owner_change_balance)) {
      fatals.push({ level: "fatal", source: "goplus", message: "Owner can rewrite balances" });
    }
    if (isFlagged(goplus.selfdestruct)) {
      fatals.push({ level: "fatal", source: "goplus", message: "selfdestruct enabled" });
    }
    if (isFlagged(goplus.is_mintable) && goplus.owner_address && goplus.owner_address !== "0x0000000000000000000000000000000000000000") {
      fatals.push({ level: "fatal", source: "goplus", message: "Mintable + owner not renounced" });
    }
    if (isFlagged(goplus.is_proxy) && !isTrusted) {
      findings.push({ level: "warn", source: "goplus", message: "Proxy contract (upgradeable)" });
    }
    if (isFlagged(goplus.transfer_pausable)) {
      findings.push({ level: "warn", source: "goplus", message: "Transfers can be paused" });
    }
    if (isFlagged(goplus.is_blacklisted)) {
      findings.push({ level: "warn", source: "goplus", message: "Blacklist function present" });
    }
    if (isFlagged(goplus.slippage_modifiable)) {
      const cur = sellTax ?? parseFloat(goplus.sell_tax ?? "0") * 100;
      if (cur > 5) fatals.push({ level: "fatal", source: "goplus", message: "Tax mutable AND current sell tax > 5%" });
      else findings.push({ level: "warn", source: "goplus", message: "Sell tax can be modified by owner" });
    }
    if (buyTax === null && goplus.buy_tax) buyTax = parseFloat(goplus.buy_tax) * 100;
    if (sellTax === null && goplus.sell_tax) sellTax = parseFloat(goplus.sell_tax) * 100;

    if (goplus.lp_holders && goplus.lp_holders.length > 0) {
      const lockedShare = goplus.lp_holders.reduce((acc, h) => {
        const pct = h.percent ? parseFloat(h.percent) : 0;
        const lockedFlag = h.is_locked === 1 || h.is_locked === "1";
        const isDead = h.address?.toLowerCase().endsWith("dead") || h.address === "0x0000000000000000000000000000000000000000";
        return acc + ((lockedFlag || isDead) ? pct : 0);
      }, 0);
      lpLockedOrBurned = lockedShare > 0.5;
      if (!lpLockedOrBurned) {
        // V3 NFT positions: lock/burn semantics differ; many independent LPs is normal.
        // Long-lived blue chips with deep liquidity: lock signal not meaningful.
        if (ctx.isV3Pair || isLongLivedBlueChip || isTrusted) {
          findings.push({ level: "warn", source: "goplus", message: `LP only ${(lockedShare * 100).toFixed(0)}% locked (V3/blue-chip — context applies)` });
        } else {
          fatals.push({ level: "fatal", source: "goplus", message: `LP not locked/burned (${(lockedShare * 100).toFixed(0)}% locked)` });
        }
      } else {
        findings.push({ level: "good", source: "goplus", message: `LP ${(lockedShare * 100).toFixed(0)}% locked/burned` });
      }
    }

    if (goplus.holders && goplus.holders.length > 0) {
      const filtered = goplus.holders.filter((h) => {
        const tag = (h.tag ?? "").toLowerCase();
        const addr = (h.address ?? "").toLowerCase();
        return !tag.includes("lock") && !tag.includes("dead") && !tag.includes("burn") && !tag.includes("uniswap") && !tag.includes("locker") && !addr.endsWith("dead");
      });
      const top = filtered[0];
      if (top?.percent) {
        const pct = parseFloat(top.percent) * 100;
        topHolderPct = pct;
        if (pct > 30) fatals.push({ level: "fatal", source: "goplus", message: `Top non-LP holder owns ${pct.toFixed(1)}%` });
        else if (pct > 15) findings.push({ level: "warn", source: "goplus", message: `Top non-LP holder owns ${pct.toFixed(1)}%` });
      }
    }
  }

  return composeReport({ findings, fatals, buyTax, sellTax, topHolderPct, lpLockedOrBurned, honeypot: isHoney });
}

export function evaluateSolanaSecurity(
  goplus: GoPlusSolanaToken | null,
  rugcheck: RugcheckReport | null,
): SecurityReport {
  const findings: SecurityFinding[] = [];
  const fatals: SecurityFinding[] = [];

  let topHolderPct: number | null = null;
  let lpLockedOrBurned: boolean | null = null;

  const mintAuth = goplus?.mintable?.authority ?? rugcheck?.mintAuthority ?? rugcheck?.token?.mintAuthority ?? null;
  const freezeAuth = goplus?.freezable?.authority ?? rugcheck?.freezeAuthority ?? rugcheck?.token?.freezeAuthority ?? null;

  if (mintAuth && mintAuth !== "" && !known_legit_authorities.has(mintAuth)) {
    fatals.push({ level: "fatal", source: "spl", message: `Mint authority active: ${shortAddr(mintAuth)} can print unlimited supply` });
  } else if (mintAuth === null) {
    findings.push({ level: "good", source: "spl", message: "Mint authority renounced" });
  }
  if (freezeAuth && freezeAuth !== "" && !known_legit_authorities.has(freezeAuth)) {
    fatals.push({ level: "fatal", source: "spl", message: `Freeze authority active: ${shortAddr(freezeAuth)} can freeze accounts` });
  } else if (freezeAuth === null) {
    findings.push({ level: "good", source: "spl", message: "Freeze authority renounced" });
  }

  if (goplus?.metadata?.mutable === true || goplus?.metadata?.mutable === "1" || goplus?.metadata?.mutable === 1) {
    findings.push({ level: "warn", source: "goplus", message: "Metadata mutable (name/symbol can change)" });
  }

  if (rugcheck?.risks) {
    for (const risk of rugcheck.risks) {
      const level = (risk.level ?? "").toLowerCase();
      if (level === "danger") {
        fatals.push({ level: "fatal", source: "rugcheck", message: `${risk.name}${risk.description ? ` — ${risk.description}` : ""}` });
      } else if (level === "warn") {
        findings.push({ level: "warn", source: "rugcheck", message: `${risk.name}${risk.description ? ` — ${risk.description}` : ""}` });
      }
    }
  }

  if (rugcheck?.lpLockedPct !== undefined) {
    lpLockedOrBurned = rugcheck.lpLockedPct >= 90;
    if (!lpLockedOrBurned) findings.push({ level: "warn", source: "rugcheck", message: `LP only ${rugcheck.lpLockedPct.toFixed(0)}% locked/burned` });
    else findings.push({ level: "good", source: "rugcheck", message: `LP ${rugcheck.lpLockedPct.toFixed(0)}% locked/burned` });
  }

  if (rugcheck?.topHolders && rugcheck.topHolders.length > 0) {
    const filtered = rugcheck.topHolders.filter((h) => !h.insider).slice(0, 10);
    const top = filtered[0];
    if (top?.pct !== undefined) {
      topHolderPct = top.pct;
      if (top.pct > 30) fatals.push({ level: "fatal", source: "rugcheck", message: `Top non-insider holder owns ${top.pct.toFixed(1)}%` });
      else if (top.pct > 15) findings.push({ level: "warn", source: "rugcheck", message: `Top holder owns ${top.pct.toFixed(1)}%` });
    }
    const insiderShare = rugcheck.topHolders.filter((h) => h.insider).reduce((acc, h) => acc + (h.pct ?? 0), 0);
    if (insiderShare > 40) {
      fatals.push({ level: "fatal", source: "rugcheck", message: `Insider cluster holds ${insiderShare.toFixed(1)}% (>40%)` });
    } else if (insiderShare > 20) {
      findings.push({ level: "warn", source: "rugcheck", message: `Insider cluster holds ${insiderShare.toFixed(1)}%` });
    }
  }

  if (rugcheck?.rugged === true) {
    fatals.push({ level: "fatal", source: "rugcheck", message: "Token already rugged" });
  }

  return composeReport({ findings, fatals, buyTax: null, sellTax: null, topHolderPct, lpLockedOrBurned, honeypot: false });
}

export function evaluateSecurity(
  chain: Chain,
  data: {
    goplusEvm?: GoPlusEvmToken | null;
    goplusSolana?: GoPlusSolanaToken | null;
    honeypot?: HoneypotResponse | null;
    rugcheck?: RugcheckReport | null;
    pairAgeHours?: number | null;
    pairLiquidityUsd?: number | null;
    isV3Pair?: boolean;
  },
): SecurityReport {
  if (chain === "ethereum") {
    return evaluateEvmSecurity(data.goplusEvm ?? null, data.honeypot ?? null, {
      pairAgeHours: data.pairAgeHours ?? null,
      pairLiquidityUsd: data.pairLiquidityUsd ?? null,
      isV3Pair: data.isV3Pair ?? false,
    });
  }
  return evaluateSolanaSecurity(data.goplusSolana ?? null, data.rugcheck ?? null);
}

function composeReport(args: {
  findings: SecurityFinding[];
  fatals: SecurityFinding[];
  buyTax: number | null;
  sellTax: number | null;
  topHolderPct: number | null;
  lpLockedOrBurned: boolean | null;
  honeypot: boolean;
}): SecurityReport {
  const { findings, fatals } = args;
  let score = 100;
  if (fatals.length > 0) {
    score = 0;
  } else {
    for (const f of findings) {
      if (f.level === "warn") score -= 12;
      else if (f.level === "good") score += 3;
    }
    score = Math.max(0, Math.min(100, score));
  }
  return {
    findings: [...findings, ...fatals],
    fatals,
    buyTax: args.buyTax,
    sellTax: args.sellTax,
    topHolderPct: args.topHolderPct,
    lpLockedOrBurned: args.lpLockedOrBurned,
    honeypot: args.honeypot,
    score,
  };
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
