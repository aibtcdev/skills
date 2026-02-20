---
title: Swap Tokens
description: Swap tokens on Bitflow DEX with a quote preview, price impact check, and slippage protection.
skills: [wallet, bitflow]
estimated-steps: 5
order: 6
---

# Swap Tokens

Bitflow is an aggregated DEX on Stacks that routes swaps through the best available liquidity pools, including multi-hop routes. Before executing a swap, always preview the quote to review expected output and price impact. Swaps with greater than 5% price impact require an explicit confirmation flag.

All Bitflow operations are mainnet-only. Write operations (swap execution) require an unlocked wallet.

## Prerequisites

- [ ] Wallet unlocked on mainnet (`NETWORK=mainnet`)
- [ ] STX or token balance available for the input token
- [ ] Input and output token IDs known (use `get-tokens` to discover)

## Steps

### 1. Unlock Wallet (Mainnet)

```bash
NETWORK=mainnet bun run wallet/wallet.ts unlock --password <your-password>
```

Expected output: `success: true`, Stacks and Bitcoin addresses shown.

### 2. Discover Available Tokens

List all tokens available for swapping on Bitflow to find the correct token IDs.

```bash
NETWORK=mainnet bun run bitflow/bitflow.ts get-tokens
```

Expected output: Array of tokens with `id` (the value used for `--token-x` / `--token-y`), `symbol`, `name`.

Common token IDs: `token-stx` (STX), `token-sbtc` (sBTC), `token-aeusdc` (USDCx), `token-alex` (ALEX).

### 3. Check Swap Targets

Confirm the desired output token is reachable from your input token.

```bash
NETWORK=mainnet bun run bitflow/bitflow.ts get-swap-targets --token-id token-stx
```

Expected output: Array of reachable output token IDs.

### 4. Get a Swap Quote

Preview the expected output amount and price impact before committing.

```bash
NETWORK=mainnet bun run bitflow/bitflow.ts get-quote \
  --token-x token-stx \
  --token-y token-sbtc \
  --amount-in 1000000
```

Expected output: `quote.expectedAmountOut`, `priceImpact.combinedImpactPct`, `priceImpact.severity` (`low`, `medium`, or `high`).

> Note: If `severity` is `high` (>5% impact), consider reducing the amount or splitting into smaller swaps.

### 5. Execute the Swap

Run the swap with 1% slippage tolerance (default). Add `--confirm-high-impact` only if price impact exceeds 5% and you have reviewed the quote.

```bash
NETWORK=mainnet bun run bitflow/bitflow.ts swap \
  --token-x token-stx \
  --token-y token-sbtc \
  --amount-in 1000000 \
  --slippage-tolerance 0.01
```

Expected output: `success: true`, `txid`, `swap.priceImpact.combinedImpactPct`, `explorerUrl`.

## Verification

At the end of this workflow, verify:
- [ ] Quote showed acceptable price impact before execution
- [ ] Swap returned `success: true` with a `txid`
- [ ] Transaction visible on Stacks explorer at the `explorerUrl`

## Related Skills

| Skill | Used For |
|-------|---------|
| `bitflow` | Token discovery, swap quotes, route finding, and swap execution |
| `wallet` | Wallet unlock for transaction signing |

## See Also

- [Check Balances and Status](./check-balances-and-status.md)
- [Deploy Contract](./deploy-contract.md)
