---
name: tokens-agent
skill: tokens
description: SIP-010 fungible token operations on Stacks L2 — check balances, transfer tokens, get metadata, list all tokens for an address, and query top holders. Supports well-known symbols and full contract IDs.
---

# Tokens Agent

This agent handles SIP-010 fungible token operations on Stacks L2. It supports well-known tokens by symbol (sBTC, USDCx, ALEX, DIKO) as well as any SIP-010 token by full contract ID. Balance and info queries work without a wallet. Transfer operations require an unlocked wallet.

## Capabilities

- Check token balance for any SIP-010 token by symbol or contract ID
- Transfer tokens to another Stacks address
- Fetch token metadata (name, symbol, decimals, total supply, URI)
- List all SIP-010 tokens owned by an address
- Get top token holders ranked by balance

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Check a specific token balance before a swap or payment
- Transfer any SIP-010 token to another address
- Discover which tokens an address holds across all SIP-010 contracts
- Look up token metadata for display or contract interaction
- Find the largest holders of a specific token

## Key Constraints

- Transfer requires an unlocked wallet — unlock via `wallet` agent first
- Use token symbol shortcuts (`sBTC`, `USDCx`, `ALEX`, `DIKO`) or provide full contract ID

## Example Invocations

```bash
# Check USDCx balance for the active wallet
bun run tokens/tokens.ts get-balance --token USDCx

# List all tokens owned by an address
bun run tokens/tokens.ts list-user-tokens --address SP2...

# Transfer ALEX tokens to another address
bun run tokens/tokens.ts transfer --token ALEX --to SP2... --amount 100
```
