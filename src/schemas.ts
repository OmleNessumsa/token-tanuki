import { z } from "zod";

const numLike = z.union([z.number(), z.string()]).transform((v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
});

export const DexScreenerPair = z.object({
  chainId: z.string(),
  dexId: z.string(),
  url: z.string().optional(),
  pairAddress: z.string(),
  baseToken: z.object({ address: z.string(), name: z.string(), symbol: z.string() }),
  quoteToken: z.object({ address: z.string(), name: z.string(), symbol: z.string() }),
  priceUsd: z.string().optional(),
  priceNative: z.string().optional(),
  txns: z.record(z.object({ buys: z.number(), sells: z.number() })).optional(),
  volume: z.record(numLike).optional(),
  priceChange: z.record(numLike).optional(),
  liquidity: z.object({ usd: z.number().optional(), base: z.number().optional(), quote: z.number().optional() }).optional(),
  fdv: z.number().optional(),
  marketCap: z.number().optional(),
  pairCreatedAt: z.number().optional(),
  labels: z.array(z.string()).optional(),
});
export type DexScreenerPair = z.infer<typeof DexScreenerPair>;

export const DexScreenerResponse = z.object({
  pairs: z.array(DexScreenerPair).nullable().optional(),
});

export const OhlcvCandle = z.tuple([
  z.number(), // timestamp (unix seconds)
  z.number(), // open
  z.number(), // high
  z.number(), // low
  z.number(), // close
  z.number(), // volume (USD by default)
]);
export type OhlcvCandle = z.infer<typeof OhlcvCandle>;

export const GeckoOhlcvResponse = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(OhlcvCandle),
    }),
  }),
});

const numericFlag = z.union([z.string(), z.number()]).transform((v) => String(v));

export const GoPlusEvmToken = z.object({
  token_name: z.string().optional(),
  token_symbol: z.string().optional(),
  total_supply: z.string().optional(),
  holder_count: z.string().optional(),

  is_open_source: numericFlag.optional(),
  is_proxy: numericFlag.optional(),
  is_mintable: numericFlag.optional(),
  selfdestruct: numericFlag.optional(),
  external_call: numericFlag.optional(),
  hidden_owner: numericFlag.optional(),
  can_take_back_ownership: numericFlag.optional(),
  owner_change_balance: numericFlag.optional(),

  owner_address: z.string().optional(),
  owner_percent: z.string().optional(),
  creator_address: z.string().optional(),
  creator_percent: z.string().optional(),

  is_honeypot: numericFlag.optional(),
  honeypot_with_same_creator: numericFlag.optional(),
  buy_tax: z.string().optional(),
  sell_tax: z.string().optional(),
  cannot_buy: numericFlag.optional(),
  cannot_sell_all: numericFlag.optional(),
  slippage_modifiable: numericFlag.optional(),
  personal_slippage_modifiable: numericFlag.optional(),
  transfer_pausable: numericFlag.optional(),
  trading_cooldown: numericFlag.optional(),
  is_anti_whale: numericFlag.optional(),
  anti_whale_modifiable: numericFlag.optional(),
  is_blacklisted: numericFlag.optional(),
  is_whitelisted: numericFlag.optional(),

  is_in_dex: numericFlag.optional(),
  dex: z.array(z.object({ name: z.string().optional(), liquidity: z.string().optional(), pair: z.string().optional() })).optional(),
  lp_holders: z.array(z.object({
    address: z.string().optional(),
    tag: z.string().optional(),
    percent: z.string().optional(),
    is_locked: z.union([z.number(), z.string()]).optional(),
    locked_detail: z.array(z.object({ amount: z.string().optional(), end_time: z.string().optional(), opt_time: z.string().optional() })).optional(),
  })).optional(),
  holders: z.array(z.object({
    address: z.string().optional(),
    tag: z.string().optional(),
    percent: z.string().optional(),
    is_locked: z.union([z.number(), z.string()]).optional(),
  })).optional(),

  trust_list: numericFlag.optional(),
  fake_token: z.union([z.object({ value: z.number(), true_token_address: z.string().optional() }), z.number(), z.string()]).optional(),
  note: z.string().optional(),
  other_potential_risks: z.string().optional(),
});
export type GoPlusEvmToken = z.infer<typeof GoPlusEvmToken>;

export const GoPlusEvmResponse = z.object({
  code: z.number(),
  message: z.string().optional(),
  result: z.record(GoPlusEvmToken).optional(),
});

const goPlusAuthority = z.object({
  status: z.string().optional(),
  authority: z.string().nullable().optional(),
});

export const GoPlusSolanaToken = z.object({
  metadata: z.object({
    name: z.string().optional(),
    symbol: z.string().optional(),
    uri: z.string().optional(),
    mutable: z.union([z.boolean(), z.string(), z.number()]).optional(),
  }).optional(),
  mintable: goPlusAuthority.optional(),
  freezable: goPlusAuthority.optional(),
  closable: goPlusAuthority.optional(),
  default_account_state: z.string().optional(),
  transfer_fee: z.unknown().optional(),
  transfer_hook: z.unknown().optional(),
  creators: z.array(z.unknown()).optional(),
  holders: z.array(z.object({
    account: z.string().optional(),
    balance: z.union([z.number(), z.string()]).optional(),
    percent: z.union([z.number(), z.string()]).optional(),
    tag: z.string().optional(),
  })).optional(),
  lp_holders: z.array(z.object({
    address: z.string().optional(),
    percent: z.union([z.number(), z.string()]).optional(),
    is_locked: z.union([z.number(), z.string(), z.boolean()]).optional(),
  })).optional(),
  dex: z.array(z.unknown()).optional(),
  trusted_token: numericFlag.optional(),
});
export type GoPlusSolanaToken = z.infer<typeof GoPlusSolanaToken>;

export const GoPlusSolanaResponse = z.object({
  code: z.number(),
  message: z.string().optional(),
  result: z.record(GoPlusSolanaToken).optional(),
});

export const HoneypotResponse = z.object({
  token: z.object({
    name: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.number().optional(),
    address: z.string().optional(),
    totalHolders: z.number().optional(),
  }).optional(),
  summary: z.object({
    risk: z.string().optional(),
    riskLevel: z.number().optional(),
    flags: z.array(z.unknown()).optional(),
  }).optional(),
  simulationSuccess: z.boolean().optional(),
  simulationResult: z.object({
    buyTax: z.number().optional(),
    sellTax: z.number().optional(),
    transferTax: z.number().optional(),
    buyGas: z.string().optional(),
    sellGas: z.string().optional(),
  }).optional(),
  honeypotResult: z.object({
    isHoneypot: z.boolean().optional(),
    honeypotReason: z.string().optional(),
  }).optional(),
  contractCode: z.object({
    openSource: z.boolean().optional(),
    rootOpenSource: z.boolean().optional(),
    isProxy: z.boolean().optional(),
    hasProxyCalls: z.boolean().optional(),
  }).optional(),
  pair: z.object({
    pair: z.object({ address: z.string().optional(), name: z.string().optional() }).optional(),
    liquidity: z.number().optional(),
    createdAtTimestamp: z.number().optional(),
  }).optional(),
});
export type HoneypotResponse = z.infer<typeof HoneypotResponse>;

export const RugcheckRisk = z.object({
  name: z.string(),
  description: z.string().optional(),
  level: z.string().optional(),
  score: z.number().optional(),
  value: z.string().optional(),
});

export const RugcheckReport = z.object({
  mint: z.string().optional(),
  tokenMeta: z.object({
    name: z.string().optional(),
    symbol: z.string().optional(),
    uri: z.string().optional(),
    mutable: z.boolean().optional(),
  }).optional(),
  token: z.object({
    mintAuthority: z.string().nullable().optional(),
    freezeAuthority: z.string().nullable().optional(),
    supply: z.union([z.number(), z.string()]).optional(),
    decimals: z.number().optional(),
  }).optional(),
  mintAuthority: z.string().nullable().optional(),
  freezeAuthority: z.string().nullable().optional(),
  topHolders: z.array(z.object({
    address: z.string().optional(),
    pct: z.number().optional(),
    insider: z.boolean().optional(),
  })).optional(),
  totalLPProviders: z.number().optional(),
  totalMarketLiquidity: z.number().optional(),
  rugged: z.boolean().optional(),
  score: z.number().optional(),
  score_normalised: z.number().optional(),
  risks: z.array(RugcheckRisk).optional(),
  graphInsidersDetected: z.number().optional(),
  lpLockedPct: z.number().optional(),
  creator: z.string().optional(),
  tokenProgram: z.string().optional(),
  tokenType: z.string().optional(),
  verification: z.unknown().optional(),
});
export type RugcheckReport = z.infer<typeof RugcheckReport>;
