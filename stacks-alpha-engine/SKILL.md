---
name: stacks-alpha-engine
description: "Cross-protocol yield executor for Zest, Hermetica, Granite, and HODLMM with 3-tier yield mapping, sBTC Proof-of-Reserve verification, and multi-gate safety pipeline"
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk (Agent 77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "false"
  arguments: "doctor | scan | deploy | withdraw | borrow | repay | rebalance | migrate | emergency | install-packs"
  entry: "stacks-alpha-engine/stacks-alpha-engine.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# Stacks Alpha Engine

## What it does

Cross-protocol yield executor covering **all 4 major Stacks DeFi protocols** — Zest v2, Hermetica, Granite, and HODLMM (Bitflow DLMM). Scans 6 tokens (sBTC, STX, USDCx, USDh, sUSDh, aeUSDC) across the wallet, reads positions and live yields from all 4 protocols, maps yield opportunities into 3 tiers (deploy now / swap first / acquire to unlock) with **YTG (Yield-to-Gas) profitability ratios**, verifies sBTC reserve integrity via BIP-341 P2TR derivation, checks 5 market safety gates + YTG profit gate, then executes deploy/withdraw/rebalance/migrate/emergency operations. Every write runs a mandatory safety pipeline: Scout -> Reserve -> Guardian -> YTG -> Executor. No bypasses.

**Protocol coverage:**

| Protocol | Token(s) | Deposit | Withdraw | Debt (borrow/repay) | Method |
|----------|---------|---------|----------|---------------------|--------|
| Zest v2 | sBTC (supply), USDh (borrow) | `zest_supply` | `zest_withdraw` | `zest_borrow` / `zest_repay` — USDh only | MCP native |
| Hermetica | USDh -> sUSDh | `staking-v1-1.stake(amount, affiliate)` | `staking-v1-1.unstake` + `silo.withdraw` | — | call_contract |
| Granite | aeUSDC | `liquidity-provider-v1.deposit` | `.redeem` (ERC-4626 shares) | — | call_contract |
| HODLMM | sBTC, STX, USDCx, USDh, aeUSDC (per pool) | `add-liquidity-simple` | `withdraw-liquidity-simple` | — | Bitflow skill |

**3-tier yield mapping:**

| Tier | Description | Example |
|------|-------------|---------|
| Deploy Now | You hold the token, one tx | sBTC -> Zest supply |
| Swap First | Need a Bitflow swap, then deploy | sBTC -> swap -> USDh -> Hermetica stake |
| Acquire to Unlock | Don't have the token yet | Need aeUSDC for Granite LP |

## Why agents need it

No other skill covers all 4 Stacks DeFi protocols with working read AND write paths for each. Agents hold different tokens — some have sBTC, others have USDh or aeUSDC. The engine scans whatever you hold and maps every earning path across every protocol, including swap-then-deploy routes with cost estimates. It also handles cross-protocol migration (withdraw from one, deploy to another) and emergency exit across all 4 protocols simultaneously.

## On-chain proof

- **Zest sBTC supply**: [txid b8ec03c3ba85c40840cdc933b61a14faf2a9516e1ce1314d9768228f3328803f](https://explorer.hiro.so/txid/b8ec03c3ba85c40840cdc933b61a14faf2a9516e1ce1314d9768228f3328803f?chain=mainnet) — 14,336 zsBTC shares received (block 7,495,066)
- **Zest sBTC supply (refresh)**: [`0x315a6d54…`](https://explorer.hiro.so/txid/0x315a6d54c524aaef4c01834b2fec5b8c5ee4997e79a8f3c344394761276d253d?chain=mainnet) — 10,000 sats → 9,995 zsBTC via `v0-4-market.supply-collateral-add` (same contract MCP `zest_supply` routes to)
- **Zest sBTC withdraw**: [`0x016c3996…`](https://explorer.hiro.so/txid/0x016c3996f981ffcf345e11268905e2d3332f1c0e6e188ab2627e07317c0694a6?chain=mainnet) — 15,335 zsBTC → 15,342 sats sBTC via `v0-4-market.collateral-remove-redeem`
- **Zest USDh borrow**: [`0x2b465aae…`](https://explorer.hiro.so/txid/0x2b465aae05812d25e4f52799b5f2882b21ca411d892359aba5157dba85d1162a?chain=mainnet) — 50M µUSDh borrowed against sBTC collateral via `v0-4-market.borrow`
- **Zest USDh repay**: [`0xd3b46ae7…`](https://explorer.hiro.so/txid/0xd3b46ae74b666af2e06a765d29e30bd2b0341507266827a2140cc4d9e6053fba?chain=mainnet) — full 50M µUSDh debt cleared via `v0-4-market.repay`
- **Hermetica staking**: USDh stake via `staking-v1-1.stake` — [`e8b2213d...`](https://explorer.hiro.so/txid/e8b2213d39faf2e9ccfe52bc3cbe33885303aa01c63f93badd3e8a41900a2ecf?chain=mainnet) (block 7,512,730)
- **Hermetica unstake**: sUSDh → 7-day silo claim via `staking-v1-1.unstake` — [`0x7834cd32…`](https://explorer.hiro.so/txid/0x7834cd325b986f2db2275b3fe867ca094c3c375d67a77d7f5fb3858d0f94eaad?chain=mainnet) — 408,500,348 sUSDh burned → 5.007 USDh in silo claim 2157 (ratio 1.2257, block 7,703,650)
- **Granite aeUSDC deposit**: `liquidity-provider-v1.deposit` — [`205bf3f1...`](https://explorer.hiro.so/txid/205bf3f135c5f1cddd8323c1a1a054f3a63ac81904c4244a763b0ce4b26c3352?chain=mainnet) (block 7,512,722)
- **Granite redeem** (with corrected 3-PC shape): [`0xd4aa0c4e…`](https://explorer.hiro.so/txid/0xd4aa0c4ed51b0951e91bb6680e44bc01da36722525fa7b28c39d98219e3eeba9?chain=mainnet) — 4,936,276 lp-token burned → 4,999,538 aeUSDC (ratio 1.0128)
- **HODLMM add-liquidity**: [`f2ffb41e...`](https://explorer.hiro.so/txid/f2ffb41e1f29a5c5ee5fa0df628a700e21bf14a4aabbd334b5f49b98bab9e315?chain=mainnet) — dlmm-liquidity-router (block 7,423,687)

## Leveraged-yield pattern

A composition of Zest supply + Zest borrow + Hermetica stake unlocks positive-carry leveraged yield without selling sBTC. Each leg is a supported skill command:

```bash
# ---- enter position ----
deploy   --protocol zest       --token sbtc --amount <collateral_sats>         # supply sBTC to Zest
borrow   --protocol zest       --token usdh --amount <debt_micro_usdh>         # take USDh debt (~7% APR)
deploy   --protocol hermetica  --token usdh --amount <debt_micro_usdh>         # stake for 40% APY

# ---- earning ~33% positive carry on debt_micro_usdh while sBTC exposure preserved ----

# ---- exit position ----
withdraw --protocol hermetica                                                  # unstake sUSDh → creates 7-day silo claim
# ... wait 7 days, then claim via staking-silo-v1-1.withdraw(claim-id) ...
repay    --protocol zest       --token usdh --amount <principal_plus_interest> # close the debt
withdraw --protocol zest                                                       # recover sBTC collateral
```

**Economic rationale:** Hermetica USDh stake APY (~40% per live scan) − Zest USDh borrow APR (~7%) = **~33% positive carry** on the borrowed amount, with sBTC price exposure retained on-chain. Each leg independently validated on mainnet; full cycle intentionally not atomic — if any leg fails, capital sits safely in wallet between legs.

## Safety notes

Stacks Alpha Engine uses a **defense-in-depth** approach. Stacks post-conditions are the standard safety mechanism, but DeFi operations that mint or burn tokens (LP shares, sUSDh) cannot be expressed as sender-side post-conditions. The engine compensates with layered gates that must all pass before any write executes.

### Post-condition modes per operation

The engine uses `postConditionMode: "deny"` only where the on-chain flow is unambiguous
(fixed, sender-expressible FT movements). For operations with routable fee flows or mint/burn
paths, `"allow"` is paired with an explicit dual-pin envelope so wallet layer and contract
layer enforce the same safety invariants.

| Operation | Mode | Rationale |
|-----------|------|-----------|
| DLMM swap (`swap-simple-multi`) | **allow** + dual-pin | Envelope: `Pc.principal(sender).willSendLte(amount_in)` on input + `Pc.principal(pool).willSendGte(min_out)` on output. Matches the sibling skill's pattern validated in [`bff-skills#494`](https://github.com/BitflowFinance/bff-skills/pull/494) (commit [`02d10989`](https://github.com/cliqueengagements/bff-skills/commit/02d10989), on-chain proof tx [`0xf4f49328…`](https://explorer.hiro.so/txid/0xf4f4932800a80234845a8d199556ad9c0ff4aa99874a95c819c13779b164cbc8?chain=mainnet)) and `bff-skills/docs/knowledge-base.md` line 438 (`"allow + sender-pin on routable fee flows"`). Allow mode preserved because protocol/provider fees accrue inside `dlmm-core`'s `unclaimed-protocol-fees` map and bin balances without emitting FT transfer events on the swap tx; the pool-side `willSendGte` pin IS the receive-side fund-safety protection. Empirically Deny + 2 PCs under-specifies stable-stable pools (tx [`0x5986066a…`](https://explorer.hiro.so/txid/0x5986066a93b3c8e6466d4f3f2da33a4fbe3e703fe81ca2dc23b0fe0d5f945531?chain=mainnet) aborted on dlmm_7). |
| Granite `redeem` | **deny** | `lte` cap on pool outflow (`shares * 2n` per @arc0btc's review) + `gte: "1"` floor on wallet receive. Unambiguous flow — one FT source (pool) to one FT destination (wallet) — so Deny is safe and tightest. |
| Hermetica `stake` | allow | Mints sUSDh back to caller — mint is not a sender-side transfer. Outgoing USDh `lte` PC asserted as belt-and-suspenders. |
| Hermetica `unstake` | allow | Burns sUSDh and creates a claim — burn is not expressible as sender PC. Outgoing sUSDh `lte` PC asserted. |
| Granite `deposit` | allow | Mints LP tokens back to caller — same mint issue. Outgoing aeUSDC `lte` PC asserted. |

### What provides safety instead

1. **`--confirm` dry-run gate** — every write command returns a preview without `--confirm`. No transaction is emitted until the agent explicitly opts in.
2. **Guardian (5 gates)** — pool-vs-market divergence <=0.5%, 24h volume >=$10K, gas <=50 STX, 4h rebalance cooldown, price source availability. Relay health is checked at the MCP runtime layer. Any gate failure blocks the write.
3. **PoR (Proof of Reserve)** — sBTC reserve ratio check. YELLOW (99.5-99.9%) blocks all writes. RED (<99.5%) triggers emergency withdrawal recommendation.
4. **YTG profit gate** — blocks deploys where 7-day projected yield < 3x gas cost.
5. **Crypto self-test** — bech32m vectors + P2TR derivation must pass before any operation, including reads.

### Additional safety notes

- Swap slippage budget (min-received on DLMM swaps): stable→stable 0.5%, volatile 3%. Configurable per-call. Independent of the guardian divergence gate.
- Hermetica unstake has 7-day cooldown — engine warns and provides claim instructions.
- Granite LP accepts **aeUSDC only** (not sBTC). Engine correctly routes aeUSDC to Granite.
- Signer rotation guard: reserve ratio below 50% is flagged DATA_UNAVAILABLE, not false RED.
- Engine outputs transaction instructions — does not hold keys or sign directly.

## Output contract

All commands output JSON to stdout:

```json
{
  "status": "ok" | "refused" | "partial" | "error",
  "command": "scan" | "deploy" | "withdraw" | "rebalance" | "migrate" | "emergency",
  "scout": { "status", "wallet", "balances" (6 tokens), "positions" (4 protocols), "options" (3-tier, each with ytg_ratio + ytg_profitable), "best_move", "break_prices", "data_sources" },
  "reserve": { "signal": "GREEN|YELLOW|RED|DATA_UNAVAILABLE", "reserve_ratio", "score", "sbtc_circulating", "btc_reserve", "signer_address", "recommendation" },
  "guardian": { "can_proceed", "refusals", "slippage", "volume", "gas", "cooldown", "prices" },
  "action": { "description", "txids", "details": { "instructions": [...] } },
  "refusal_reasons": ["..."],
  "error": "..."
}
```

## Architecture

| Module | Role |
|--------|------|
| **Scout** | Wallet scan (6 tokens), positions (4 protocols), 3-tier yield options, break prices |
| **Reserve** | P2TR derivation, BTC balance, GREEN/YELLOW/RED signal |
| **Guardian** | Slippage, volume, gas, cooldown, price gates |
| **Executor** | deploy, withdraw, rebalance, migrate, emergency |

## Commands

| Command | Type | Description |
|---------|------|-------------|
| `scan` | read | Full report: 6 tokens, 4 protocols, 3-tier yields, PoR, safety gates |
| `deploy` | write | Deploy capital to a protocol (with --token flag for specific token) |
| `withdraw` | write | Pull capital from a specific protocol |
| `borrow` | write | Borrow a debt asset against existing Zest collateral (USDh only — leveraged-yield leg) |
| `repay` | write | Repay a borrowed Zest debt asset |
| `rebalance` | write | Withdraw out-of-range HODLMM bins, re-add centered on active bin |
| `migrate` | write | Cross-protocol capital movement (withdraw A + deploy B) |
| `emergency` | write | Withdraw ALL positions across all 4 protocols |
| `doctor` | read | 11 self-tests: crypto vectors, data sources, PoR, all protocol reads |

## Write Paths (verified on-chain)

| Protocol | Deposit | Withdraw | Debt (borrow/repay) | Token | Method |
|----------|---------|----------|---------------------|-------|--------|
| Zest v2 | `zest_supply` | `zest_withdraw` | `zest_borrow` / `zest_repay` (USDh only) | sBTC (supply), USDh (borrow) | MCP native |
| Hermetica | `staking-v1-1.stake(uint, optional buff)` | `staking-v1-1.unstake(uint)` + `silo-v1-1.withdraw(uint)` | — | USDh/sUSDh | call_contract |
| Granite | `lp-v1.deposit(assets, principal)` | `lp-v1.redeem(shares, principal)` | — | aeUSDC | call_contract |
| HODLMM | `add-liquidity-simple` | `withdraw-liquidity-simple` | — | per pool pair | Bitflow skill |

All 4 protocols have **zero trait_reference** requirements in their write paths.

## Safety Pipeline (every write)

1. **Scout** reads wallet (6 tokens) + 4 protocols + yields + prices + YTG ratios
2. **Reserve (PoR)** verifies sBTC is fully backed by real BTC
3. **Guardian** checks 5 gates: pool-vs-market divergence (<=0.5%), volume (>=$10K), gas (<=50 STX), cooldown (4h), prices. Relay health deferred to MCP runtime.
4. **YTG gate** checks 7d projected yield > 3x gas cost (refuses unprofitable deploys)
5. All pass -> **Executor** outputs transaction instructions
6. Any fail -> refuse with specific reasons, no transaction

### PoR Signal Thresholds

| Reserve Ratio | Signal | Engine Action |
|---------------|--------|---------------|
| >= 99.9% | GREEN | Execute writes normally |
| 99.5-99.9% | YELLOW | Read-only, refuse all writes |
| < 99.5% | RED | Emergency withdrawal recommended |
| < 50% | DATA_UNAVAILABLE | Likely signer key rotation |

## Emergency Exit Coverage

| Risk | Detection | Exit Path |
|------|-----------|-----------|
| HODLMM out of range | Guardian: active bin vs user bins | `withdraw-liquidity-simple` |
| sBTC peg break | PoR: reserve ratio < 99.5% | Withdraw all 4 protocols |
| Hermetica unstake | Manual | `staking-v1-1.unstake` + 7-day claim |
| Zest rate drops | Scout: live utilization read | `zest_withdraw` + redeploy |
| Signer key rotation | PoR: ratio < 50% | DATA_UNAVAILABLE flag |

## Known constraints

### Granite Borrower Path (Blocked)
Granite `borrower-v1.add-collateral` requires `trait_reference` — blocked by MCP. The engine uses the **LP deposit path** (aeUSDC supply) which works without trait_reference.

### Zest borrow/repay asset restriction (USDh only)
`zest_borrow` via MCP succeeds only for USDh. Probes against USDCx, wSTX, and stSTX on the same wallet + sBTC collateral + cap-debt headroom all return `abort_by_response (err none)` on `v0-4-market.borrow`. Suspected root cause: upstream MCP routing gap around `borrow-helper-v2-1-7` (the Pyth oracle fee wrapper). The skill refuses non-USDh borrow with `zest borrow does not accept <token>. Valid: usdh` to save gas rather than broadcast known-failing txs. Tracked separately from this skill; if/when fixed upstream, `validTokens_borrowRepay` can be widened without further code changes.

### Hermetica Minting (Blocked)
Hermetica `minting-v1.request-mint` requires 4x `trait_reference`. Workaround: swap via Bitflow DLMM router (`dlmm-swap-router-v-1-1.swap-simple-multi`) then stake. The engine generates executable `call_contract` instructions for both steps.

### Non-Atomic Multi-Step
Swap-then-deploy and rebalance operations are 2+ transactions. If tx 1 confirms but tx 2 fails, capital sits safely in wallet.

### Hermetica 7-Day Cooldown
Unstaking sUSDh creates a claim. USDh is available after 7-day cooldown via `staking-silo-v1-1.withdraw(claim-id)`.

## Data Sources (12+ live reads)

| Source | Data |
|--------|------|
| Hiro Stacks API | STX + 5 FT balances, contract reads |
| Tenero API | sBTC/STX prices |
| Bitflow HODLMM API | Pool APR, TVL, volume, token prices |
| mempool.space | BTC balance at signer P2TR address |
| Zest v2 Vault | Supply position, utilization, interest rate |
| Hermetica staking-v1-1 | Exchange rate (USDh/sUSDh), staking status |
| Granite state-v1 | LP params, IR params, user position, utilization |
| HODLMM Pool Contracts | User bins, balances, active bin (8 pools) |
| sbtc-registry | Signer aggregate pubkey |
| sbtc-token | Total sBTC supply |
| DLMM Core | Bin price calculations |

## Dependencies

- `commander` (CLI parsing, registry convention)
- `tiny-secp256k1` (BIP-341 elliptic curve point addition for PoR)
- Node.js built-ins: `crypto` (SHA-256), `os`/`path`/`fs` (cooldown state)

### Why `tiny-secp256k1`?

The sBTC Proof-of-Reserve module derives the signer's Bitcoin P2TR address from the aggregate pubkey registered on Stacks. This requires a BIP-341 Taproot key tweak: `output_key = internal_key + H_TapTweak(internal_key) * G`. Node.js `crypto` does not expose raw EC point addition. `tiny-secp256k1` provides exactly one function we need: `xOnlyPointAddTweak()`.

## Doctor Self-Tests (11 checks)

1. BIP-350 bech32m test vectors
2. P2TR derivation from known G point
3. Hiro Stacks API
4. Tenero Price Oracle
5. Bitflow HODLMM API
6. mempool.space
7. sBTC Proof of Reserve (full golden chain)
8. Zest v2 sBTC Vault
9. Hermetica Staking (exchange rate read)
10. Granite Protocol (aeUSDC LP params)
11. HODLMM Pool Contracts

## x402 Paid Endpoints

Stacks Alpha Engine is free to run from the registry. For agents that want instant results without running 12+ API calls, paid x402 endpoints are available:

| Endpoint | What you get | Price | Pays back in |
|----------|-------------|-------|-------------|
| `/scan` | Full 7-section report: wallet, positions, 3-tier yields with YTG, PoR, break prices, safety gates | 500 sats | ~5 min of yield difference |
| `/reserve` | sBTC Proof-of-Reserve check: GREEN/YELLOW/RED signal with reserve ratio | 100 sats | Avoiding one bad trade |
| `/break-prices` | HODLMM range exit prices + safety buffer | 200 sats | One rebalance save |
| `/guardian` | 6-gate pre-flight safety check | 100 sats | One blocked bad tx |

All endpoints return the same JSON output as the CLI. x402 protocol shows price before payment — no surprises. Revenue flows to `SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY` (Micro Basilisk, Agent #77).

## Disclaimers

### Financial Disclaimer
Stacks Alpha Engine provides data-driven yield analysis for informational purposes only. This is not financial advice. Users are solely responsible for their own investment decisions. Past yields do not guarantee future returns. Smart contract risk, impermanent loss, and sBTC peg failure are real possibilities.

### Accuracy Disclaimer
Data is live but not guaranteed. Yield rates are based on trailing 24h volume and may not reflect future returns. Hermetica APY is estimated from exchange rate drift. The engine reads 12+ data sources; if any are unavailable, output may be incomplete (status: "degraded").

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @cliqueengagements
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/485
