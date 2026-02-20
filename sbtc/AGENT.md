---
name: sbtc-agent
skill: sbtc
description: sBTC operations on Stacks L2 — check balances, transfer sBTC, deposit BTC to receive sBTC, track deposit status, and query peg statistics.
---

# sBTC Agent

This agent handles sBTC (wrapped Bitcoin on Stacks L2) operations. sBTC uses 8 decimals, matching Bitcoin. Balance and info queries work without a wallet. Transfer and deposit operations require an unlocked wallet.

## Capabilities

- Check sBTC balance for any Stacks address or active wallet
- Transfer sBTC to another Stacks address
- Get deposit info for a specific Bitcoin transaction ID
- Query global sBTC peg statistics (total supply, peg-in/peg-out capacity)
- Initiate a BTC deposit to receive sBTC on Stacks L2
- Check the status of a pending sBTC deposit

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Check sBTC balance before a DeFi operation or payment
- Move sBTC between Stacks addresses
- Bridge BTC from Bitcoin L1 to Stacks L2 as sBTC
- Monitor whether a BTC deposit has been credited as sBTC

## Key Constraints

- Transfer and deposit operations require an unlocked wallet
- Deposits require a Bitcoin L1 transaction first; use `btc` agent to send the BTC

## Example Invocations

```bash
# Check sBTC balance for the active wallet
bun run sbtc/sbtc.ts get-balance

# Transfer sBTC to another address
bun run sbtc/sbtc.ts transfer --to SP2... --amount 0.001

# Check the status of a pending deposit
bun run sbtc/sbtc.ts deposit-status --txid <bitcoin-txid>
```
