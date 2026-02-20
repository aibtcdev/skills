---
name: bitflow
description: Bitflow DEX on Stacks — token swaps with aggregated liquidity, market ticker data, swap routing, price impact analysis, and Keeper automation for scheduled orders. All operations are mainnet-only. No API key required (500 req/min public rate limit). Write operations require an unlocked wallet.
user-invocable: false
arguments: get-ticker | get-tokens | get-swap-targets | get-quote | get-routes | swap | get-keeper-contract | create-order | get-order | cancel-order | get-keeper-user
entry: bitflow/bitflow.ts
requires: [wallet]
tags: [l2, defi, write, mainnet-only, requires-funds]
---

# Bitflow Skill

Provides DEX operations on the Bitflow aggregated liquidity protocol:

- **Market Data** — Ticker prices, volumes, and liquidity for all trading pairs via public API.
- **Token Discovery** — List available swap tokens, find swap targets for a given token, discover multi-hop routes.
- **Swap Quotes** — Get expected output amounts with price impact analysis (XYK constant-product formula).
- **Token Swaps** — Execute swaps with slippage protection and high-impact safety gates.
- **Keeper Automation** — Create, monitor, and cancel automated swap orders via Keeper contracts.

All Bitflow operations are **mainnet-only**. No API key is required — the Bitflow SDK works with public endpoints at 500 requests/minute per IP. For higher rate limits, contact help@bitflow.finance.

Write operations (swap, create-order) require an unlocked wallet (use `bun run wallet/wallet.ts unlock` first).

## Usage

```
bun run bitflow/bitflow.ts <subcommand> [options]
```

## Subcommands

### get-ticker

Get market ticker data from Bitflow DEX. Returns price, volume, and liquidity data for all trading pairs. Optionally filter by a specific pair.

```
bun run bitflow/bitflow.ts get-ticker [--base-currency <contractId>] [--target-currency <contractId>]
```

Options:
- `--base-currency` (optional) — Filter by base currency contract ID
- `--target-currency` (optional) — Filter by target currency contract ID

Output:
```json
{
  "network": "mainnet",
  "pairCount": 42,
  "tickers": [
    {
      "ticker_id": "token-stx_token-sbtc",
      "base_currency": "token-stx",
      "target_currency": "token-sbtc",
      "last_price": "0.000012",
      "base_volume": "5000000",
      "target_volume": "60",
      "bid": "0.000011",
      "ask": "0.000013",
      "high": "0.000014",
      "low": "0.000010",
      "liquidity_in_usd": "1500000"
    }
  ]
}
```

### get-tokens

Get all available tokens for swapping on Bitflow.

```
bun run bitflow/bitflow.ts get-tokens
```

Output:
```json
{
  "network": "mainnet",
  "tokenCount": 15,
  "tokens": [
    {
      "id": "token-stx",
      "name": "Stacks",
      "symbol": "STX",
      "contractId": "token-stx",
      "decimals": 6
    }
  ]
}
```

### get-swap-targets

Get possible swap target tokens for a given input token. Returns all tokens that can be received when swapping from the specified token.

```
bun run bitflow/bitflow.ts get-swap-targets --token-id <contractId>
```

Options:
- `--token-id` (required) — The input token ID (contract address)

Output:
```json
{
  "network": "mainnet",
  "inputToken": "token-stx",
  "targetCount": 8,
  "targets": ["token-sbtc", "token-aeusdc", "token-alex"]
}
```

### get-quote

Get a swap quote from Bitflow DEX. Returns expected output amount, best route, and price impact analysis.

```
bun run bitflow/bitflow.ts get-quote --token-x <tokenId> --token-y <tokenId> --amount-in <units>
```

Options:
- `--token-x` (required) — Input token ID (e.g. `token-stx`, `token-sbtc`)
- `--token-y` (required) — Output token ID (e.g. `token-sbtc`, `token-aeusdc`)
- `--amount-in` (required) — Amount of input token (in smallest units)

Output:
```json
{
  "network": "mainnet",
  "quote": {
    "tokenIn": "token-stx",
    "tokenOut": "token-sbtc",
    "amountIn": "1000000",
    "expectedAmountOut": "12",
    "route": ["token-stx", "token-sbtc"]
  },
  "priceImpact": {
    "combinedImpact": 0.0023,
    "combinedImpactPct": "0.23%",
    "severity": "low",
    "hops": [...],
    "totalFeeBps": 30
  }
}
```

### get-routes

Get all possible swap routes between two tokens, including multi-hop routes through intermediate tokens.

```
bun run bitflow/bitflow.ts get-routes --token-x <tokenId> --token-y <tokenId>
```

Options:
- `--token-x` (required) — Input token ID
- `--token-y` (required) — Output token ID

Output:
```json
{
  "network": "mainnet",
  "tokenX": "token-stx",
  "tokenY": "token-sbtc",
  "routeCount": 3,
  "routes": [
    {
      "tokenPath": ["token-stx", "token-sbtc"],
      "dexPath": ["xyk-pool-v1"]
    }
  ]
}
```

### swap

Execute a token swap on Bitflow DEX. Automatically finds the best route across all pools. Includes a high-impact safety gate — swaps with >5% price impact require `--confirm-high-impact`. Requires an unlocked wallet.

```
bun run bitflow/bitflow.ts swap \
  --token-x <tokenId> --token-y <tokenId> --amount-in <units> \
  [--slippage-tolerance <decimal>] [--fee <value>] [--confirm-high-impact]
```

Options:
- `--token-x` (required) — Input token ID (contract address)
- `--token-y` (required) — Output token ID (contract address)
- `--amount-in` (required) — Amount of input token (in smallest units)
- `--slippage-tolerance` (optional) — Slippage tolerance as decimal (default 0.01 = 1%)
- `--fee` (optional) — Fee: `low` | `medium` | `high` preset or micro-STX amount. If omitted, auto-estimated.
- `--confirm-high-impact` (optional) — Required to execute swaps with price impact above 5%

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "swap": {
    "tokenIn": "token-stx",
    "tokenOut": "token-sbtc",
    "amountIn": "1000000",
    "slippageTolerance": 0.01,
    "priceImpact": { "combinedImpactPct": "0.23%", "severity": "low" }
  },
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet"
}
```

### get-keeper-contract

Get or create a Bitflow Keeper contract for automated swaps.

```
bun run bitflow/bitflow.ts get-keeper-contract [--address <stacksAddress>]
```

Options:
- `--address` (optional) — Stacks address (uses wallet if not specified)

Output:
```json
{
  "network": "mainnet",
  "address": "SP2...",
  "contractIdentifier": "SP2...keeper-v1",
  "status": "active"
}
```

### create-order

Create an automated swap order via Bitflow Keeper. Creates a pending order that will be executed by the Keeper service.

```
bun run bitflow/bitflow.ts create-order \
  --contract-identifier <id> --action-type <type> \
  --funding-tokens '{"token-stx":"1000000"}' --action-amount <units> \
  [--min-received-amount <units>] [--auto-adjust]
```

Options:
- `--contract-identifier` (required) — Keeper contract identifier
- `--action-type` (required) — Action type (e.g., `SWAP_XYK_SWAP_HELPER`)
- `--funding-tokens` (required) — JSON map of token IDs to amounts for funding
- `--action-amount` (required) — Amount for the action
- `--min-received-amount` (optional) — Minimum amount to receive (slippage protection)
- `--auto-adjust` (optional) — Auto-adjust minimum received based on market (default true)

Output:
```json
{
  "success": true,
  "network": "mainnet",
  "orderId": "order-123",
  "status": "pending",
  "order": {
    "contractIdentifier": "SP2...keeper-v1",
    "actionType": "SWAP_XYK_SWAP_HELPER",
    "fundingTokens": { "token-stx": "1000000" },
    "actionAmount": "1000000"
  }
}
```

### get-order

Get details of a Bitflow Keeper order.

```
bun run bitflow/bitflow.ts get-order --order-id <id>
```

Options:
- `--order-id` (required) — The order ID to retrieve

Output:
```json
{
  "network": "mainnet",
  "order": {
    "orderId": "order-123",
    "status": "completed",
    "actionType": "SWAP_XYK_SWAP_HELPER",
    "actionAmount": "1000000"
  }
}
```

### cancel-order

Cancel a Bitflow Keeper order before execution.

```
bun run bitflow/bitflow.ts cancel-order --order-id <id>
```

Options:
- `--order-id` (required) — The order ID to cancel

Output:
```json
{
  "network": "mainnet",
  "orderId": "order-123",
  "cancelled": true
}
```

### get-keeper-user

Get Bitflow Keeper user info and orders. Retrieves user's keeper contracts and order history.

```
bun run bitflow/bitflow.ts get-keeper-user [--address <stacksAddress>]
```

Options:
- `--address` (optional) — Stacks address (uses wallet if not specified)

Output:
```json
{
  "network": "mainnet",
  "userInfo": {
    "stacksAddress": "SP2...",
    "contracts": [{ "identifier": "SP2...keeper-v1", "status": "active" }],
    "orders": [{ "orderId": "order-123", "status": "completed" }]
  }
}
```

## Notes

- All Bitflow operations are **mainnet-only**. Calls on testnet will return an error.
- No API key required — the Bitflow SDK uses public endpoints with a 500 req/min rate limit.
- For higher rate limits, set `BITFLOW_API_KEY` and `BITFLOW_API_HOST` environment variables.
- Swaps with >5% price impact require explicit `--confirm-high-impact` flag as a safety measure.
- Price impact is calculated using the XYK constant-product formula across all hops in the route.
- Keeper features enable automated/scheduled swaps. Use `get-keeper-contract` to get started.
- Wallet operations require an unlocked wallet (use `bun run wallet/wallet.ts unlock` first).
