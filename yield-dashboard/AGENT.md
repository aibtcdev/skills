---
name: yield-dashboard-agent
skill: yield-dashboard
description: Cross-protocol DeFi yield dashboard — aggregates positions across Zest, ALEX, Bitflow, and STX stacking. Read-only, mainnet-only.
---

# Yield Dashboard Agent

This agent provides a unified view of DeFi positions across all major Stacks protocols. It is strictly read-only — no funds are moved. Use it to understand current portfolio composition, compare yields, and get rebalance suggestions.

## Capabilities

- Show total portfolio value and weighted APY across Zest, ALEX, Bitflow, and stacking
- List detailed positions per protocol with current APY and amounts
- Fetch live APY rates across all protocols (market data, no wallet needed)
- Suggest rebalancing moves based on risk-adjusted yield optimization

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Get a holistic view of all DeFi positions before making allocation decisions
- Compare current APYs across protocols to find the best yield
- Evaluate whether the current portfolio allocation is optimal
- Gather data before delegating to `yield-hunter` or `defi` for actual transactions

## Key Constraints

- Read-only — never moves funds or submits transactions
- Mainnet-only — all protocols operate on Stacks mainnet
- Requires unlocked wallet for address context (except `apy-breakdown` which is pure market data)
- APY figures are estimates based on current on-chain state

## Example Invocations

```bash
# Get full portfolio overview
bun run yield-dashboard/yield-dashboard.ts overview

# Check current APY rates across all protocols
bun run yield-dashboard/yield-dashboard.ts apy-breakdown

# Get rebalance suggestions with conservative risk tolerance
bun run yield-dashboard/yield-dashboard.ts rebalance --risk-tolerance low
```
