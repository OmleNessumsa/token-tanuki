# Data APIs Reference (early 2026)

Given an arbitrary ETH (ERC-20) or SOL (SPL) address, fetch chart data + security signals. All facts checked against official docs in May 2026.

---

## Chain detection (local, no network)

```ts
const ETH_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function detectChain(addr: string): "ethereum" | "solana" | "unknown" {
  if (ETH_RE.test(addr)) return "ethereum";
  if (SOL_RE.test(addr)) return "solana";
  return "unknown";
}
```

ETH check first — leading `0x` is dispositive.

---

## Tier 1 — Multi-chain DEX data

### DexScreener — `api.dexscreener.com`

- No auth, no key
- Rate limits: 300 req/min for `/tokens/*`, `/token-pairs/*`, `/latest/dex/*`; 60 rpm for profile/boost endpoints
- **No OHLCV** — only rolling windows (m5/h1/h6/h24) per pair endpoint

#### Endpoints

```
GET /latest/dex/search?q={address}              # works without knowing chain; returns array of pairs with chainId
GET /token-pairs/v1/{chainId}/{tokenAddress}    # preferred once chain detected
GET /tokens/v1/{chainId}/{addresses}            # batch (up to 30 comma-separated)
GET /latest/dex/pairs/{chainId}/{pairAddress}   # specific pair
```

`chainId` slugs: `ethereum`, `solana`, `bsc`, `base`, `arbitrum`, `polygon`, `optimism`, `avalanche` (60+ chains).

#### Pair response shape (fields to extract)
```ts
{
  chainId: string;
  dexId: string;             // "uniswap" | "raydium" | "pumpfun" | ...
  url: string;
  pairAddress: string;
  baseToken:  { address, name, symbol };
  quoteToken: { address, name, symbol };
  priceNative: string;
  priceUsd: string;
  txns:        { m5, h1, h6, h24: { buys, sells } };
  volume:      { m5, h1, h6, h24 };          // USD
  priceChange: { m5, h1, h6, h24 };          // %
  liquidity:   { usd, base, quote };
  fdv: number;
  marketCap: number;
  pairCreatedAt: number;     // unix ms
  info: { imageUrl, websites, socials };
  labels?: string[];         // e.g. ["v3"]
}
```

**Universal pre-flight call** — cheapest "does this token exist and where does it trade".

### GeckoTerminal — `api.geckoterminal.com/api/v2`

- No auth required for free tier
- Rate limit: ~30 calls/min on free tier (paid plans up to 250/min)
- Header: `Accept: application/json;version=20230302` to lock version

#### Network slugs
- Ethereum: `eth`
- Solana: `solana`
- Others: `bsc`, `polygon_pos`, `arbitrum`, `optimism`, `base`, `avax`, `ftm`

#### Endpoints
```
GET /networks/{network}/tokens/{token_address}/pools     # find pools by token
GET /networks/{network}/tokens/{token_address}           # token info
GET /networks/{network}/pools/{pool_address}/ohlcv/{tf}  # KEY ENDPOINT
```

OHLCV path: `tf` ∈ `day` | `hour` | `minute` | `second`

Query params:
| Param | Default | Notes |
|---|---|---|
| `aggregate` | `1` | day:`1` / hour:`1,4,12` / minute:`1,5,15` / second:`1,15,30` |
| `before_timestamp` | — | unix seconds; pagination cursor |
| `limit` | `100` | max **1000** |
| `currency` | `usd` | or `token` |
| `token` | `base` | or `quote` or token address |

Response (bare tuples, NOT objects):
```json
{ "data": { "attributes": { "ohlcv_list": [
  [1714000000, 0.123, 0.130, 0.121, 0.128, 45123.5],
  ...
]}}}
```

Tuple order: `[timestamp, open, high, low, close, volume]`.

**Best free OHLCV** — multichain, ETH+SOL with one schema, 1s to daily resolution, 1000 candles per call.

### Moralis (skip on free tier)
OHLCV is a Pro-plan endpoint. Free tier just has price endpoint at 50 CU/call. GeckoTerminal beats it for OHLCV at zero cost.

---

## Tier 2 — Solana-specific

### Birdeye — `public-api.birdeye.so`

- `X-API-KEY` header **mandatory** (no anonymous use); sign up at `bds.birdeye.so`
- `x-chain` header for chain selection (`solana` default, also `ethereum`, `bsc`, `base`, etc.)
- Free tier (BDS): **30k CU/month, 1 req/sec**

#### Endpoints
```
GET /defi/token_overview?address={addr}     # name, symbol, mc, fdv, liquidity, supply, price, holders, volumes, markets
GET /defi/ohlcv?address={addr}&type={tf}&time_from={unix}&time_to={unix}
GET /defi/token_security?address={mint}     # Solana-strong
GET /defi/txs/token?address={addr}&offset=0&limit=50&tx_type=swap
```

OHLCV `type`: `1m, 3m, 5m, 15m, 30m, 1H, 2H, 4H, 6H, 8H, 12H, 1D, 3D, 1W, 1M`. Max 1000 records/call.

Token security fields (Solana): `creatorAddress, ownerAddress, creationTime, totalSupply, mutableMetadata, freezeable, freezeAuthority, mintAuthority, top10HolderBalance, top10HolderPercent, lockInfo, isToken2022, transferFeeEnable, transferFeeData, isTrueToken, fakeToken`.

### Helius — `mainnet.helius-rpc.com` + `api.helius.xyz`

- API key in query string: `?api-key={key}`
- Free tier: 1M credits/month, 10 req/sec RPC, 2 rps DAS

#### Get token holders (DAS)
```
POST https://mainnet.helius-rpc.com/?api-key={key}
{
  "jsonrpc":"2.0", "id":1, "method":"getTokenAccounts",
  "params": { "mint":"<mint>", "page":1, "limit":1000,
              "options": { "showZeroBalance": false } }
}
```

Response: `result.token_accounts: [{ address, mint, owner, amount, frozen, delegate, ... }]`. Sort by `amount` desc, slice top 10/20.

#### Token metadata
```
POST https://api.helius.xyz/v0/token-metadata?api-key={key}
{ "mintAccounts": ["<mint>", ...], "includeOffChain": true }
```

### RugCheck.xyz — `api.rugcheck.xyz/v1`

- Public read; some endpoints need JWT
- `GET /v1/tokens/{mint}/report` — full report
- `GET /v1/tokens/{mint}/report/summary` — condensed

Highlights: `score`, `score_normalised` (0–100), `risks: [{ name, level: "warn"|"danger"|"info", description }]`, `mintAuthority`, `freezeAuthority`, `topHolders[]`, `lockerOwners[]`, `markets[]`, `totalMarketLiquidity`, `creator`, `rugged: bool`, `lpLockedPct`, `graphInsidersDetected`.

---

## Tier 3 — Ethereum-specific

### Etherscan V2 — `api.etherscan.io/v2/api`

- `apikey` query param (free signup)
- 5 calls/sec, 100k/day free
- V2 unifies all 60+ EVM chains via `chainid` param. `1` Ethereum, `56` BSC, `137` Polygon, `42161` Arbitrum, `10` Optimism, `8453` Base.

```
GET ?chainid=1&module=contract&action=getsourcecode&address={addr}&apikey=...
GET ?chainid=1&module=stats&action=tokensupply&contractaddress={addr}&apikey=...
```

`getsourcecode` returns `result[0]: { SourceCode, ABI, ContractName, Proxy, Implementation, ... }`. Use `SourceCode != ""` AND `ContractName != ""` as the verified signal.

### Honeypot.is — `api.honeypot.is`

- **No auth required** ("API Key system not yet implemented")
- EVM only — Ethereum (1), BSC (56), Base (8453)

```
GET /v2/IsHoneypot?address={token}&chainID=1
```

Optional: `pair`, `simulateLiquidity=true`, `forceSimulateLiquidity=true`.

Response key fields:
```ts
{
  token: { name, symbol, decimals, address, totalHolders },
  summary: { risk: "honeypot"|"very_high"|"high"|"medium"|"low"|"very_low"|"unknown", riskLevel: number, flags },
  simulationSuccess: boolean,
  simulationResult: { buyTax, sellTax, transferTax, buyGas, sellGas, maxBuy, maxSell },
  honeypotResult: { isHoneypot: boolean, honeypotReason? },
  holderAnalysis: { holders, successful, failed, siphoned, averageTax, highestTax },
  contractCode: { openSource, rootOpenSource, isProxy, hasProxyCalls },
  pair: { pair: { address, name }, reserves0, reserves1, liquidity, createdAtTimestamp }
}
```

**Always call this for ETH tokens** — single best honeypot/tax detector.

---

## Tier 4 — Cross-chain security

### GoPlus — `api.gopluslabs.io`

- Free without auth; Bearer token raises rate limit
- Rate limit ~30 calls/min unauthenticated

#### Chain IDs (EVM endpoint)
| chain_id | Network |
|---|---|
| 1 | Ethereum |
| 10 | Optimism |
| 56 | BSC |
| 137 | Polygon |
| 8453 | Base |
| 42161 | Arbitrum |
| 43114 | Avalanche |

```
GET /api/v1/token_security/{chain_id}?contract_addresses={addr1,addr2,...}
GET /api/v1/solana/token_security?contract_addresses={mint}
```

#### EVM response fields (returned at `result["{address-lowercase}"]`)

Identity & supply: `token_name`, `token_symbol`, `total_supply`, `holder_count`

Contract structure (string `"0"`/`"1"`):
- `is_open_source`, `is_proxy`, `is_mintable`
- `selfdestruct`, `external_call`, `gas_abuse`
- `hidden_owner`, `can_take_back_ownership`

Ownership: `owner_address`, `owner_balance`, `owner_percent`, `owner_change_balance`, `creator_address`, `creator_balance`, `creator_percent`

Trading honeypot/tax:
- `is_honeypot`, `honeypot_with_same_creator`
- `buy_tax`, `sell_tax`
- `cannot_buy`, `cannot_sell_all`
- `slippage_modifiable`, `personal_slippage_modifiable`
- `transfer_pausable`, `trading_cooldown`
- `is_anti_whale`, `anti_whale_modifiable`
- `is_blacklisted`, `is_whitelisted`

Liquidity: `is_in_dex`, `dex: [{ name, liquidity, pair }]`, `lp_total_supply`, `lp_holder_count`, `lp_holders: [{ address, tag, percent, is_locked, locked_detail }]`

Holders: `holders: [{ address, tag, percent, is_locked }]`

Misc: `trust_list`, `other_potential_risks`, `note`, `fake_token`

#### Solana endpoint fields
`mintable: { status, authority }`, `freezable: { status, authority }`, `closable: { status, authority }`, `default_account_state`, `transfer_fee`, `transfer_hook`, `metadata: { name, symbol, uri, mutable }`, `creators`, `holders`, `dex`, `lp_holders`.

**Single most valuable security endpoint.** Free, multi-chain, comprehensive. Always call. Pair with Honeypot.is on EVM and RugCheck on Solana for cross-validation.

---

## Coverage matrix

| Capability | ETH | SOL | Best free API |
|---|---|---|---|
| Pool discovery / liquidity / 24h | ✅ | ✅ | DexScreener |
| OHLCV (1m–1d, 1000 candles) | ✅ | ✅ | GeckoTerminal |
| OHLCV by token mint (no pool needed) | ✅ | ✅ | Birdeye (key required) |
| Honeypot / buy-sell tax simulation | ✅ | ❌ | Honeypot.is |
| Mint / freeze authority | n/a | ✅ | Birdeye, GoPlus, RugCheck |
| Top holders + concentration | ⚠️ Pro | ✅ | GoPlus (ETH), Helius/Birdeye (SOL) |
| Contract verified / source code | ✅ | n/a | Etherscan |
| LP locked / burnt | ✅ | ✅ | GoPlus |

---

## Recommended orchestration

```
1. detectChain(addr)
   ├─ ETH → chainSlug="ethereum", evmChainId=1
   ├─ SOL → chainSlug="solana"
   └─ unknown → fallback: GET /latest/dex/search?q={addr}

2. PRE-FLIGHT (1 call):
   GET DexScreener /token-pairs/v1/{chainSlug}/{addr}
   → confirm token, pick highest-liquidity pair
   → grab pairAddress, dexId, baseToken, quoteToken, priceUsd, liquidity, fdv, marketCap,
     volume.h24, txns.h24, priceChange, pairCreatedAt

3. PARALLEL (4–5 calls):
   a) Security:
      ETH → GoPlus /api/v1/token_security/1?contract_addresses=...
            + Honeypot.is /v2/IsHoneypot?address=...&chainID=1
            + (optional) Etherscan getsourcecode
      SOL → GoPlus /api/v1/solana/token_security?contract_addresses=...
            + RugCheck /v1/tokens/{mint}/report
   b) OHLCV (GeckoTerminal):
      For tf in [(minute,1,200), (minute,5,200), (hour,1,200), (day,1,200)]:
        GET /networks/{slug}/pools/{pairAddress}/ohlcv/{tf}?aggregate={agg}&limit={n}

4. COMPOSE:
   - Apply hard-fail disqualifiers FIRST (instant NO)
   - Security score from GoPlus + Honeypot.is/RugCheck
   - Lifecycle phase from candles + age
   - Chart score (TA on the OHLCV)
   - Liquidity gating
   - Composite verdict
```

### Network-slug cheat sheet
| Concept | DexScreener | GeckoTerminal | Birdeye `x-chain` | GoPlus chain_id |
|---|---|---|---|---|
| Ethereum | `ethereum` | `eth` | `ethereum` | `1` |
| Solana | `solana` | `solana` | `solana` | n/a (`/solana/` path) |
| Base | `base` | `base` | `base` | `8453` |
| BSC | `bsc` | `bsc` | `bsc` | `56` |
| Arbitrum | `arbitrum` | `arbitrum` | `arbitrum` | `42161` |
