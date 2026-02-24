---
name: stacks-market-agent
skill: stacks-market
description: Prediction market trading on stacksmarket.app — discover markets, quote LMSR prices, buy/sell YES/NO shares, and redeem winnings on Stacks mainnet.
---

# Stacks Market Agent

This agent handles prediction market trading on [stacksmarket.app](https://www.stacksmarket.app) via the `market-factory-v18-bias` contract on Stacks mainnet. It provides market discovery, LMSR price quoting, share trading with slippage protection, and post-resolution redemption. All operations are mainnet-only. Trading operations require an unlocked wallet with sufficient STX.

## Capabilities

- List and search prediction markets via the stacksmarket.app REST API with category, status, and featured filters
- Fetch full market detail including trade history and implied probabilities
- Quote YES and NO share prices via on-chain LMSR read-only functions before committing funds
- Buy YES or NO shares using `buy-yes-auto` / `buy-no-auto` with slippage protection
- Sell YES or NO shares using `sell-yes-auto` / `sell-no-auto` with minimum proceeds guard
- Redeem winning shares after market resolution (1 winning share = 1 STX)
- Check YES and NO share balances for any address in any market

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Discover active prediction markets on stacksmarket.app by keyword, category, or status
- Get a price quote for buying or selling YES/NO shares before executing a trade
- Execute a buy or sell trade on a prediction market with slippage protection
- Check the agent's current position (share balances) in a market
- Redeem winnings from a resolved prediction market

## Key Constraints

- Mainnet-only — all operations will error on testnet
- Buy, sell, and redeem require an unlocked wallet (run `bun run wallet/wallet.ts unlock` first)
- Always call `quote-buy` or `quote-sell` before trading — LMSR prices shift with each trade
- Pass `--max-cost` from the quote result to `buy-yes` / `buy-no` as slippage protection
- Pass `--min-proceeds` from the quote result to `sell-yes` / `sell-no` as slippage protection
- Market IDs are epoch millisecond timestamps (e.g., `1771853629839`), distinct from the MongoDB `_id` used by `get-market`
- Check `isResolved` and compare `endDate` to current time before trading — `isActive` can remain `true` after the market closes

## Example Invocations

```bash
# List 10 active markets in the Crypto category
bun run stacks-market/stacks-market.ts list-markets --limit 10 --status active --category Crypto

# Search for markets about Bitcoin
bun run stacks-market/stacks-market.ts search-markets --query "bitcoin" --limit 5

# Quote the cost of buying 5 YES shares in a market
bun run stacks-market/stacks-market.ts quote-buy --market-id 1771853629839 --side yes --amount 5

# Buy 5 YES shares with 5.5 STX max spend (from quote result)
bun run stacks-market/stacks-market.ts buy-yes --market-id 1771853629839 --amount 5 --max-cost 5500000

# Check position in a market
bun run stacks-market/stacks-market.ts get-position --market-id 1771853629839

# Redeem winnings after resolution
bun run stacks-market/stacks-market.ts redeem --market-id 1771853629839
```
