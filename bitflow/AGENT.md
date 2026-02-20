---
name: bitflow-agent
skill: bitflow
description: Bitflow DEX operations on Stacks mainnet — token swaps with aggregated liquidity, price quotes, route discovery, market ticker data, and Keeper automation for scheduled orders.
---

# Bitflow Agent

This agent handles DEX operations on the Bitflow aggregated liquidity protocol on Stacks mainnet. It provides market data, swap routing, price impact analysis, token swap execution, and Keeper contract automation for scheduled orders. All operations are mainnet-only. Swap and order creation require an unlocked wallet.

## Capabilities

- Fetch market ticker data (price, volume, liquidity) for all Bitflow trading pairs
- List available tokens and find swap targets for a given token
- Discover multi-hop swap routes between token pairs
- Get swap quotes with price impact analysis before committing
- Execute token swaps with slippage protection and high-impact safety gates
- Create, query, and cancel automated Keeper swap orders

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Get a price quote or swap route for a Bitflow-supported token pair
- Execute a token swap on Bitflow's aggregated liquidity
- Set up a recurring or threshold-based swap via the Keeper automation system
- Check current market rates or liquidity depth for a trading pair

## Key Constraints

- Mainnet-only — all operations will error on testnet
- Swap and create-order require an unlocked wallet
- High price-impact swaps are blocked by a safety gate — verify impact via `get-quote` first

## Example Invocations

```bash
# Get market ticker data for all Bitflow pairs
bun run bitflow/bitflow.ts get-ticker

# Get a swap quote from STX to sBTC
bun run bitflow/bitflow.ts get-quote --from STX --to sBTC --amount 100

# Execute a swap with slippage tolerance
bun run bitflow/bitflow.ts swap --from STX --to sBTC --amount 100 --slippage 0.5
```
