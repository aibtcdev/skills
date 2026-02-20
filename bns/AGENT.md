---
name: bns-agent
skill: bns
description: Bitcoin Name System (BNS) operations — lookup and reverse-lookup .btc names, check availability, get pricing, list owned domains, and register new names via fast-claim or two-step preorder/register.
---

# BNS Agent

This agent handles Bitcoin Name System (BNS) operations for .btc domain names using BNS V2 (recommended) with fallback to BNS V1. Read operations (lookup, reverse-lookup, availability, pricing, listing) work without a wallet. Write operations (claim-fast, preorder, register) require an unlocked wallet.

## Capabilities

- Resolve a .btc name to its Stacks address
- Reverse-lookup: find the .btc name owned by a Stacks address
- Get detailed info for a specific BNS name (owner, expiry, status)
- Check whether a name is available for registration
- Get the current registration price for a name
- List all .btc domains owned by an address
- Register a new .btc name via single-transaction fast claim (BNS V2)
- Register via two-step preorder/register flow (BNS V1 fallback)

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Resolve a human-readable .btc name to a Stacks address for a transaction
- Check what names an agent owns or whether a desired name is available
- Register a new .btc identity for an agent or user
- Price out a registration before committing to it

## Key Constraints

- claim-fast, preorder, and register require an unlocked wallet
- Two-step registration (preorder then register) spans two transactions with a waiting period

## Example Invocations

```bash
# Resolve a .btc name to a Stacks address
bun run bns/bns.ts lookup --name alice.btc

# Check if a name is available and its price
bun run bns/bns.ts check-availability --name myagent.btc

# Register a .btc name with a single fast-claim transaction
bun run bns/bns.ts claim-fast --name myagent.btc
```
