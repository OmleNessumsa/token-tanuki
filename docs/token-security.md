# Token Security & On-Chain Health

Reference for evaluating ERC-20 (Ethereum) and SPL (Solana) tokens before buying.

---

## Part 1 — Ethereum (ERC-20)

### 1.1 Contract analysis

**Source verification.** Etherscan `getsourcecode` API returns whether a contract's source has been verified. Field `SourceCode` is empty when unverified. **Unverified = auto-no-buy** unless token is <1h old. There is no legitimate reason to keep a deployed token contract unverified after launch.

### Privileged owner functions

| Function | Capability | Threat |
|---|---|---|
| `mint(address,uint)` | Print new tokens | Infinite supply dilution |
| `setBlacklist`/`setBots` | Block addresses from selling | Per-wallet honeypot |
| `pause()` | Stop all transfers | Soft honeypot, freeze before exit |
| `setFee`/`setBuyTax`/`setSellTax` | Change taxes on the fly | Spike sell tax to 99% (honeypot) |
| `setMaxTx`/`setMaxWallet` | Cap tx or wallet size | Anti-snipe at launch (legit) but post-launch can prevent sells |
| `excludeFromFee(address)` | Bypass own restrictions | Devs always exclude themselves |
| `transferOwnership(address)` | Move admin | Pre-rug step; transfer to fresh wallet then mint |
| `renounceOwnership()` | Set owner to `0x0` | Good (if no hidden owner pattern) |
| `setRouter` | Point trades at malicious router | Active on multiple rugs |
| `airdrop(address[],uint[])` | Bulk-send tokens | Used in airdrop-scam contracts |

**Hidden owner patterns.** Some contracts renounce `owner()` to `0x0` but retain control via:
- A second `_owner` / `_devWallet` storage slot with its own modifier.
- A whitelisted `excludeFromFees` address with tax-exempt mint rights.
- Constructor immutables: `address private constant DEPLOYER = 0x...; modifier onlyDeployer()`.

GoPlus surfaces these as `hidden_owner: "1"` and `can_take_back_ownership: "1"`.

**Proxy contracts.** Implementation can be swapped at any time by proxy admin. **For a memecoin, upgradeable = red flag.** For a serious DeFi token (governance multisig + timelock + DAO vote), upgradeable acceptable. Check `is_proxy: "1"` from GoPlus, then read proxy admin and timelock period. If admin is EOA or multisig with no timelock, treat as red flag.

### Acceptable tax ranges

| Buy | Sell | Verdict |
|---|---|---|
| 0% | 0% | Ideal |
| 1–5% | 1–5% | Acceptable for marketing/dev |
| 5–10% | 5–10% | Yellow flag (typical "tax token") |
| >10% | >10% | Scam-adjacent |
| any | >15% | **Auto-no-buy** |
| any | 100% / cannot_sell_all | **Honeypot, auto-no-buy** |

`slippage_modifiable: "1"` (devs can change tax post-launch) is hard yellow even if current tax is 0%.

### Honeypot mechanism reference

How they actually work:
1. **Revert-on-sell modifier** — `_transfer` checks `to == uniswapV2Pair` and reverts unless whitelisted.
2. **Balance mutation** — "buy" records you got `amount` but stores `0` in `_balances`. Wallets show your balance via on-chain `balanceOf` view that lies; `transfer` reads the real storage.
3. **Hidden fee swap** — sell tax is 0% per `sellTax` storage but `_transfer` calls private `_takeFee(99)`.
4. **Approval honeypot** — `approve` sets allowance, `transferFrom` always reverts when sender != owner.
5. **External call rug** — `_transfer` does `IRouter(externalContract).hook(from,to,amt)` where `externalContract` is owner-mutable; swapped to a reverting contract before exit.
6. **Fake event** — emits `Transfer` event but storage unchanged; tools relying on events alone are fooled.

**You cannot detect every honeypot from source code alone — you must simulate a sell.** That's exactly what Honeypot.is and GoPlus do internally (forked-chain `eth_call` of buy → transfer → sell).

### 1.2 Liquidity analysis

**Find the LP.**
- **Uniswap V2** (and forks): pair at deterministic address from `factory + token0 + token1`. LP token *is* the pair contract; an ERC-20.
- **Uniswap V3** (and forks): liquidity held as ERC-721 NFTs by `NonfungiblePositionManager` at `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`. Each NFT encodes `tickLower, tickUpper, liquidity, token0, token1, fee`.

**Lock vs burn vs held by dev:**
- **Burned**: LP tokens sent to `0x000...dEaD` or `0x0`. Irreversible. Strongest trust signal.
- **Locked**: LP held by known locker contract with future unlock timestamp.
- **Held by dev / EOA**: rugger-on-demand. **Auto-no-buy** unless explicitly multisig-timelocked.

### Known V2 lockers (Ethereum mainnet)

| Locker | Address | Method |
|---|---|---|
| UNCX (Unicrypt) V2 | `0x663A5C229c09b049E36dCc11a9B0d4a8Eb9db214` | `getDepositsByWithdrawalAddress`, `getLock(lockID)` returns `unlockDate` |
| Team.Finance | `0xE2fE530C047f2d85298b07D9333C05737f1435fB` | `lockedToken(lockID)` returns `unlockTime` |
| PinkLock V2 | `0x71B5759d73262FBb223956913ecF4ecC51057641` | `getLockById`, returns `tgeDate, unlockDate` |

Verification: (a) read top LP holders, (b) for each holder check if in known locker list, (c) call `getLock` on locker for the LP token, (d) read `unlockDate` and convert to days remaining. Anything <30 days = treat as unlocked.

**Single-sided V3 footgun**: dev mints a V3 position with only the token (no WETH) above current price. To naive checkers it looks like "liquidity provided" but no one can sell into it. Always verify pool has WETH/USDC reserves at-or-near current tick.

### Liquidity depth thresholds

| USD | Treatment |
|---|---|
| <$10k | Untradeable, exit liquidity for snipers |
| $10k–$30k | Micro-cap, slippage 5–15% on $1k orders |
| $30k–$100k | Minimum for serious entries |
| $100k–$500k | Reasonable mid-cap |
| >$500k | Fine |

### 1.3 Holder distribution

**Top-10 concentration.** Compute **after** excluding LP pair, dead addresses (`0x000...0`, `0x000...dEaD`), known locker contracts, known bridge/CEX deposit contracts.

| Top-10 % (ex LP/locks) | Treatment |
|---|---|
| <15% | Healthy distribution |
| 15–30% | Normal for new launches |
| 30–50% | Yellow flag, needs context |
| >50% | Red flag |
| Single wallet >30% | **Auto-no-buy** unless known multisig/treasury |

**Sniper detection.** Pull first ~50 buys from LP pair (filter `Swap` events by block of pair creation + 1–2 blocks). If ≥30% of first-block buyers still hold and have not sold, expect coordinated dump on first parabolic move.

**Dev wallet tracking.** Find via `getContractCreation` Etherscan endpoint → `contractCreator`. Track:
- Current holdings
- Recent ETH withdrawals to CEXes
- Whether dev wallet funded by Tornado Cash / Railgun / fixfloat → red flag
- Other tokens deployed by same address — repeat-rug devs are common

### 1.4 Trading history
- **Buy/sell ratio (1h, 24h)**: <30% buys in last hour = active distribution. >90% buys with thin liquidity = wash buying.
- **Unique buying wallets**: too few (<10/hour on a "trending" token) = wash. A sudden spike from <5 to >100/min = call group entry; usually marks local top within minutes.
- **First N transactions**: pull first 20 swaps; if ≥3 from same wallet, or 5+ wallets share funding from same source one block before pair creation, it's a bundled launch.

---

## Part 2 — Solana (SPL)

### 2.1 Token mint analysis

**Mint authority.** If non-null, holder can mint unlimited new tokens. **MUST be null.** Check via `getAccountInfo` with `jsonParsed`:
```
result.value.data.parsed.info.mintAuthority
```

**Freeze authority.** If non-null, holder can call `FreezeAccount` on any token account. **Post-launch honeypot**: dev lets you buy, freezes your account, you can never sell. **MUST be null** for memecoins. Only legit use cases: regulated stablecoins (USDC has freeze authority for OFAC compliance).

**Update authority on Metaplex metadata.** At metadata PDA derived from `['metadata', metaplex_program, mint]`. If `is_mutable=true` or `update_authority` non-null, dev can change name/ticker/image post-launch. Common scam: launch with one name, get holders, change to impersonate major project. Yellow flag.

**Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) extensions:**

| Extension | Threat | Verdict |
|---|---|---|
| `transferHook` | Custom program runs on every transfer; can revert (honeypot) or steal | **Auto-no-buy** unless hook is open-source, immutable, audited |
| `permanentDelegate` | Holder can transfer/burn from any wallet at will | **Auto-no-buy**; complete rug primitive |
| `transferFeeConfig` | Transfer fee 0–100%, mutable by config authority | Yellow if <2% and authority renounced; red if mutable |
| `defaultAccountState=Frozen` | New accounts created frozen | **Auto-no-buy** for memecoins |
| `mintCloseAuthority` | Mint can be closed and reinitialized at same address | Red flag |
| `confidentialTransfers` | Hidden amounts (ZK proofs) | Yellow — limits chart reading |
| `nonTransferable` | Soulbound | Not buyable |
| `interestBearing` | UI-only interest accrual | Safe |

### 2.2 LP / pool analysis

**Where is the LP token?**
- **Raydium AMM v4 / CPMM** (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` for v4): LP is an SPL token. Burned LP sent to incinerator `1nc1nerator11111111111111111111111111111111` or `dead1...`. Read top holders of the LP mint.
- **Raydium CLMM** (`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`): NFT positions, similar to Uniswap V3.
- **Orca Whirlpool** (`whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`): NFT positions in `Position` accounts.
- **Meteora DLMM**: dynamic pools, position per-bin; LP burn doesn't apply same way.
- **PumpSwap** (post-March-2025 default for graduated pump.fun): LP auto-burned by pump.fun program at migration.

**Pump.fun lifecycle:**
1. Launches on bonding curve at pump.fun program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`).
2. On the curve, all "liquidity" is virtual (curve reserves); no LP token to lock.
3. At ~$69k market cap (graduation), program migrates: deposits ~85 SOL of liquidity to PumpSwap, receives LP tokens, **automatically burns them**.
4. Post-graduation: LP burned by definition; mint and freeze authority null at deploy. Pump.fun tokens are technically "safe" by these checks — danger shifts to bundle wallets and dev dumps.

**LP burn % calculation.** `burned_lp / total_lp_supply` where burned = LP balance held by incinerator + dead addresses. RugCheck reports as `lpLockedPct`. <90% on a non-Pump.fun Raydium token = locked LP not verified. 100% burned = ideal.

### 2.3 Holder distribution

Same as ETH, with Solana-specific exclusions: Raydium pool authority PDA, Orca pool vault accounts, Pump.fun bonding curve account (pre-graduation), known burn addresses.

**Bundle wallet detection.** Solana-specific pattern: dev pre-funds 20–100 wallets from same source within a few slots, all buy in launch block via Jito bundle, hold synchronously, then sell synchronously. Detect via:
- Wallet funding source clustering (all funded from same source within N slots before token launch)
- Same-block buys at launch slot
- Shared CEX deposit address downstream

Trench Radar (`https://trench.bot/bundles/<mint>`) and RugCheck's `graphInsidersDetected` / `graphInsiderReport` surface this.

**Insider supply %**: aggregate holdings of the bundle/insider cluster. Threshold: insiders >20% of float = red flag, >40% = auto-no-buy.

### 2.4 Solana-specific scam patterns

- **Frozen-token honeypot**: launch with freeze authority, let buyers in, freeze the largest non-dev accounts, dump on the rest. Always check `freeze_authority == null`.
- **Bundle launch + coordinated dump**: 50+ wallets buying in same slot, then dumping over 30–120 min.
- **Pump.fun snipers**: bots that snipe within first slot of bonding curve. Even on legit pump.fun launches, expect 20–40% of supply to be sniper-held.
- **Metadata bait-and-switch**: launch as "PEPE2" with unrenounced metadata, get listed everywhere as PEPE2, then update name to mimic a different launch.

### RugCheck score interpretation

| Label | Meaning |
|---|---|
| Good | Mint+freeze renounced, LP burned/locked, no insider concentration |
| Warning | LP not 100% burned, some holder concentration |
| Danger | Multiple risks: insider cluster, mutable metadata, Token-2022 with hooks |

`risks` array entries: `Mint Authority still enabled`, `Freeze Authority still enabled`, `Top 10 holders high ownership`, `Single holder ownership`, `Low Liquidity`, `Mutable metadata`, `Insider Network detected`, `Bundled launch`, `Copycat token`. Each has a `level` (`warn` / `danger`).

---

## Part 3 — Hard "would-not-buy" disqualifiers

Trigger any one → reject.

### Universal
- Honeypot detected (Honeypot.is `isHoneypot=true` OR GoPlus `is_honeypot="1"`)
- Sell tax > 15% (sim-derived)
- `cannot_sell_all=1`
- Top single non-LP/non-locker/non-burn wallet > 30% of supply
- LP not locked AND not burned (held by EOA)
- Liquidity < $10k USD
- Owner can mint AND owner not renounced
- Owner can blacklist AND blacklist mutable

### Ethereum-specific
- Unverified source AND token age > 24h
- `hidden_owner=1` OR `can_take_back_ownership=1`
- `owner_change_balance=1` (owner can rewrite your balance)
- `selfdestruct=1` on token contract
- `slippage_modifiable=1` AND current sell tax > 5%
- Proxy contract with EOA admin and no timelock

### Solana-specific
- `mintAuthority != null` (excluding regulated stablecoins on allow list)
- `freezeAuthority != null` (same exclusion)
- Token-2022 with `permanentDelegate` enabled
- Token-2022 with `transferHook` (unless allowlisted)
- Token-2022 with `defaultAccountState=Frozen` for memecoins
- LP not 100% burned for non-Pump.fun Raydium AMM tokens (or held by EOA)

---

## Part 4 — Yellow flags (needs investigation)

- Buy or sell tax 5–15%
- `slippage_modifiable=1` even with 0% current tax
- `transfer_pausable=1`
- `is_proxy=1` with multisig admin (check signers and timelock)
- LP locked but unlock < 30 days away
- Top-10 (ex LP/locks) 30–50% of supply
- Token age < 1 hour AND no real verified history
- Dev wallet funded from Tornado/Railgun/sideshift
- Mutable Solana metadata
- Token-2022 with `transferFeeConfig` <2% and authority renounced
- > 20% of supply in detected insider/bundle cluster (Solana)
- < 50 unique holders despite "trending" listing
- First-block buyers >40% of supply still holding
- Repeat-rug deployer

---

## Part 5 — Implementation notes

- **Always do hard-fail checks first.** They cost one RPC and save your rate limits.
- **Cache** GoPlus, RugCheck, Birdeye, Etherscan-source responses per (chain, address) for ≥60 seconds.
- **Prefer Honeypot.is sim over GoPlus static tax** (GoPlus reads storage variable; Honeypot.is runs an actual sell trace).
- **Solana mint/freeze**: prefer direct `getAccountInfo` over RugCheck/Birdeye — one RPC call, source of truth.
- Maintain allowlist for legitimate authorities (Circle USDC, Tether, etc.).
- Maintain denylist of repeat-rug deployers.
- Treat any "trust list" / "verified" flag from a single source as yellow → green nudge, never green light alone.
- **For pump.fun tokens**, recognize mint/freeze are by definition null and LP burns at graduation, so weight the bundle/insider check **much more heavily** — only remaining attack surface.
