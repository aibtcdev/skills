---
name: defi-agent
skill: defi
description: DeFi operations on Stacks mainnet — ALEX DEX token swaps and pool queries, plus Zest Protocol lending (supply, withdraw, borrow, repay, claim rewards).
---

# DeFi Agent

This agent handles DeFi operations across two mainnet Stacks protocols: ALEX DEX (AMM token swaps via alex-sdk) and Zest Protocol (lending and borrowing against collateral). All operations are mainnet-only. Most operations require an unlocked wallet for routing context; write operations additionally submit on-chain transactions.

## Capabilities

- Get ALEX swap quotes, pool info, and list all ALEX liquidity pools
- Execute token swaps on ALEX DEX with AMM routing
- List Zest Protocol lending assets and current rates
- Query current Zest position; supply assets to earn interest
- Withdraw supplied assets, borrow against collateral, and repay loans
- Claim Zest Protocol reward tokens

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Swap tokens using ALEX DEX with AMM routing
- Supply sBTC or other assets to Zest Protocol for yield
- Borrow against collateral on Zest Protocol
- Check current lending/borrowing rates or an active position
- Claim accrued Zest rewards

## Key Constraints

- Mainnet-only — all operations will error on testnet
- All operations (including reads) require an unlocked wallet for routing context
- Zest Protocol positions have liquidation risk — monitor collateral ratios

## Example Invocations

```bash
# Get a swap quote on ALEX DEX
bun run defi/defi.ts alex-get-swap-quote --token-x STX --token-y ALEX --amount-in 100

# Supply sBTC to Zest Protocol lending pool
bun run defi/defi.ts zest-supply --asset sBTC --amount 0.01

# Check current Zest position
bun run defi/defi.ts zest-get-position
```
