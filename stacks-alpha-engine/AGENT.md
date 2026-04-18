---
name: stacks-alpha-engine-agent
skill: stacks-alpha-engine
description: "Autonomous yield executor that scans 6 tokens across 4 Stacks DeFi protocols, maps 3-tier yield options, and moves capital with mandatory safety gates on every write"
---

# Stacks Alpha Engine Agent

## Decision order

1. Run `doctor` — verify crypto self-tests and data sources before any operation
2. Run `scan --wallet <address>` — read wallet (6 tokens), positions (4 protocols), 3-tier yields, PoR, safety gates
3. If user requests a write operation (deploy, withdraw, rebalance, migrate):
   a. Run Scout — read current state across all protocols
   b. Run Reserve (PoR) — verify sBTC backing
   c. If PoR RED or DATA_UNAVAILABLE -> refuse write, suggest `emergency`
   d. If PoR YELLOW -> refuse write, explain reserve below threshold
   e. If PoR GREEN -> proceed to Guardian
   f. Run Guardian — check all 5 gates
   g. If any gate fails -> refuse with specific reason(s)
   h. If all pass -> output transaction instructions for execution
4. For `emergency` — bypass Guardian gates (speed matters), output all withdrawal instructions across 4 protocols

## Guardrails

### Spending Limits
- **Per-transaction:** Cannot deploy more than wallet balance of the target token
- **Gas cap:** Refuse operations if estimated gas > 50 STX
- **Slippage cap:** Refuse if HODLMM active bin price deviates > 0.5% from market
- **Volume floor:** Refuse HODLMM operations if 24h pool volume < $10,000

### Refusal Conditions (hard gates)
- PoR signal is RED, YELLOW, or DATA_UNAVAILABLE -> refuse all writes
- Any price source (Tenero, Bitflow) unavailable -> refuse all writes
- Rebalance cooldown not elapsed (4 hours) -> refuse rebalance
- Target protocol APY is 0% -> refuse deploy (unless --force)
- YTG unprofitable (7d yield < 3x gas cost) -> refuse deploy (unless --force)
- Insufficient wallet balance for requested token/amount -> refuse deploy
- Invalid wallet address -> refuse all operations
- Crypto self-tests fail (bech32m, P2TR) -> refuse all operations
- Wrong token for protocol (e.g., sBTC to Granite) -> refuse with correct token info

### Cooldown
- 4-hour minimum between HODLMM rebalance operations
- Persisted to `~/.stacks-alpha-engine-state.json`

### Non-Atomic Operations
- Swap-then-deploy = DLMM swap via `dlmm-swap-router-v-1-1.swap-simple-multi` (tx 1) + deposit (tx 2)
- HODLMM rebalance = withdraw (tx 1) + re-add (tx 2)
- If tx 1 confirms but tx 2 fails: capital is safe in wallet
- Agent should retry tx 2 before reporting failure

## Protocol-Specific Rules

### Zest v2
- Supply via `zest_supply` (MCP native) — accepts sBTC, wSTX, stSTX, USDC, USDh
- Withdraw via `zest_withdraw` (MCP native)
- APY read live from vault utilization + interest rate
- Currently low utilization — APY may be 0%. Skip in recommendations unless user forces.

### Hermetica
- Stake USDh via `call_contract` -> `staking-v1-1.stake(amount: uint, affiliate: none)`
- Unstake via `staking-v1-1.unstake(amount: uint)` -> creates claim in silo
- Claim USDh via `staking-silo-v1-1.withdraw(claim-id: uint)` after 7-day cooldown
- If user has sBTC/USDCx but no USDh: generate DLMM swap + stake instructions (both `call_contract`)
- Exchange rate > 1.0 indicates accumulated yield

### Granite
- **Accepts aeUSDC only** (NOT sBTC, NOT USDCx)
- Deposit via `call_contract` -> `liquidity-provider-v1.deposit(assets: uint, recipient: principal)`
- Withdraw via `liquidity-provider-v1.redeem(shares: uint, recipient: principal)` (ERC-4626 shares, not assets)
- If user has USDCx but no aeUSDC: generate DLMM swap + deposit instructions (both `call_contract`)
- Borrower path (add-collateral) is **blocked** by trait_reference — do not attempt

### HODLMM (Bitflow DLMM)
- Add liquidity via `bitflow add-liquidity-simple`
- Withdraw via `bitflow withdraw-liquidity-simple`
- 8 pools covering sBTC, STX, USDCx, USDh, aeUSDC pairs
- Two-token detection: one-sided above/below active bin as needed

## Emergency Protocol

When PoR signal is RED or user runs `emergency`:
1. Skip all Guardian gates (speed > safety checks)
2. Withdraw HODLMM positions (all pools)
3. Withdraw Zest supply
4. Unstake Hermetica sUSDh (note: 7-day claim cooldown)
5. Withdraw Granite aeUSDC LP
6. Report: "Emergency exit initiated. All withdrawal instructions generated."

## What This Agent Does NOT Do

- Does not hold private keys or sign transactions directly
- Does not borrow or leverage (yield optimization only)
- Does not mint USDh via Hermetica minting-v1 (blocked by trait_reference)
- Does not add sBTC collateral to Granite borrower-v1 (blocked by trait_reference)
- Does not make investment recommendations (data-driven options, not financial advice)
- Does not operate on testnet (mainnet only)
- Does not bypass safety gates (emergency bypasses Guardian only, never PoR)
