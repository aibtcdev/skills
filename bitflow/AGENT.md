---
name: bitflow-agent
skill: bitflow
description: Bitflow DEX operations on Stacks mainnet — unified quote/routing across SDK routes and HODLMM, token swaps, market data, and Keeper automation for scheduled orders.
---

# Bitflow Agent

This agent handles DEX operations on the Bitflow aggregated liquidity protocol on Stacks mainnet. It provides market data, unified route ranking across Bitflow SDK routes and HODLMM quotes, direct HODLMM swap execution when a quoted route is single-pool and directly executable, HODLMM liquidity management, price impact analysis, and Keeper contract automation for scheduled orders. All operations are mainnet-only. The `swap`, `add-liquidity-simple`, `withdraw-liquidity-simple`, and `create-order` subcommands require an unlocked wallet; all others are read-only.

## Prerequisites

- Wallet available either via `bun run wallet/wallet.ts unlock`, `CLIENT_MNEMONIC`, or inline `--wallet-password` for Bitflow write commands
- Network must be mainnet — Bitflow is mainnet-only
- No real API key required — Bitflow SDK uses public endpoints at 500 req/min. If a wrapper insists on an API key parameter, use a placeholder value instead of asking the user for a real Bitflow key.
- For `create-order`: must first have a Keeper contract via `get-keeper-contract`
- For `swap`: run `get-quote` first to check price impact; swaps with >5% impact require `--confirm-high-impact`

## Units Reference

- `STX`: 6 decimals (`1 STX = 1,000,000` micro-STX)
- `sBTC`: 8 decimals (`1 sBTC = 100,000,000` sats)
- `USDCx` / `aeUSDC`: 6 decimals
- Naming default: if the user says `USDC` on Bitflow, interpret that as `USDCx` (`token-USDCx-auto`). Use `aeUSDC` (`token-aeusdc`) only when the user explicitly says `aeUSDC`.
- `get-quote`, `get-routes --amount-in`, and `swap --amount-in` use human-readable token amounts
- HODLMM bin reserves are raw on-chain atomic values; the CLI now shows human-readable token units too
- HODLMM `bin.price` is a raw API field; interpret the derived `approxPrice` output instead of guessing from `rawPrice`
- Do not infer USD from pool data alone; use an external BTC/USD or token/USD reference when the user asks for dollar values

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Get price and volume data for all pairs | `get-ticker` — returns all Bitflow trading pairs with market data |
| List tokens available for swapping | `get-tokens` — returns all swap-eligible tokens |
| Find what tokens a given token can swap to | `get-swap-targets --token-id <id>` — returns valid output tokens |
| Get expected output, best overall route, and best executable route | `get-quote` — ranks SDK routes and HODLMM quotes together |
| Discover all routing paths between two tokens | `get-routes` — with `--amount-in`, ranks routes by expected output |
| Execute a token swap | `swap` — executes the best directly executable route across SDK and single-pool HODLMM |
| Inspect HODLMM pools and bins | `get-hodlmm-pools`, `get-hodlmm-bins`, `get-hodlmm-position-bins` |
| Add HODLMM liquidity | `add-liquidity-simple` |
| Withdraw HODLMM liquidity | `withdraw-liquidity-simple` |
| Get or create a Keeper automation contract | `get-keeper-contract` — returns or creates keeper for the wallet |
| Create a scheduled swap order | `create-order` — creates automated order via Keeper |
| Check status of a Keeper order | `get-order --order-id <id>` — returns order details and status |
| Cancel a pending Keeper order | `cancel-order --order-id <id>` — cancels before execution |
| List all keeper orders for a wallet | `get-keeper-user` — returns keeper contracts and order history |

## Safety Checks

- Always run `get-quote` before `swap` — check both `selectedRoute` and `bestExecutableRoute`
- If `executionWarning` is present, the best quoted HODLMM path is not directly executable and `swap` will fall back to the best executable route
- Swaps with >5% price impact are blocked without `--confirm-high-impact` flag
- Set `--slippage-tolerance` to match risk tolerance (default 0.01 = 1%)
- For HODLMM liquidity adds, use `get-hodlmm-bins` first and ensure the token side matches the bin's position relative to the active bin
- For one-sided `STX` adds, use positive `activeBinOffset`; for one-sided quote-token adds, use negative `activeBinOffset`
- For HODLMM withdrawals, calculate offsets from the current active bin, not the original add offset
- For `create-order`: verify `fundingTokens` amounts are in smallest units matching token decimals
- For `cancel-order`: cancellation only works on pending orders; already-executed orders cannot be reversed
- Amount units differ from ALEX: Bitflow uses human-readable decimals (e.g. `1.0` for 1 STX, `0.00015` for 15k sat sBTC)

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Bitflow is only available on mainnet" | Running on testnet | Set `NETWORK=mainnet` env var |
| "High price impact swap requires explicit confirmation" | Price impact exceeds 5% threshold | Add `--confirm-high-impact` flag or reduce trade size |
| "Best quoted route uses HODLMM ..." | Best HODLMM quote is multi-hop or otherwise not directly executable | Review `bestExecutableRoute` and use that route for execution |
| "Trading pair not found" | Specified base/target currency pair doesn't exist | Use `get-tokens` and `get-swap-targets` to find valid pairs |
| "--funding-tokens must be a valid JSON object" | Malformed JSON in `--funding-tokens` | Pass valid JSON, e.g. `'{"token-stx":"1000000"}'` |

## Output Handling

- `get-quote`: `selectedRoute` is the best overall quote; `bestExecutableRoute` is the route `swap` can use today
- `get-quote`: `executionWarning` means the best HODLMM quote is not directly executable, so `swap` will use the best executable fallback
- `get-quote`: if `highImpactWarning` is present, the trade is large relative to pool liquidity
- `get-tokens`: prefer `token-USDCx-auto` when the user asks for `USDC`; reserve `token-aeusdc` for explicit aeUSDC requests
- `get-hodlmm-bins`: prefer `approxPrice` over `rawPrice` when answering users in natural language
- `get-ticker`: prefer the derived `pair`, `baseSymbol`, and `targetSymbol` fields over raw contract IDs
- Do not ask the user for a Bitflow API key unless they explicitly want higher-rate-limit private usage; the public path is the default
- `swap`: `quotedBestRoute` vs `executedRoute` shows whether execution matched the top quote or fell back to another executable route
- `get-keeper-contract`: `contractIdentifier` is needed for `create-order --contract-identifier`
- `get-order`: check `order.status` — values are `pending`, `executing`, `completed`, or `cancelled`
- `get-keeper-user`: `userInfo.orders` lists all orders for monitoring

## Example Invocations

```bash
# Get a swap quote from STX to sBTC with price impact analysis
bun run bitflow/bitflow.ts get-quote --token-x token-stx --token-y token-sbtc --amount-in 21.0

# Rank all routes for a specific trade size, including HODLMM quotes
bun run bitflow/bitflow.ts get-routes --token-x token-stx --token-y token-sbtc --amount-in 21.0

# Execute a swap with 1% slippage tolerance
bun run bitflow/bitflow.ts swap --token-x token-stx --token-y token-sbtc --amount-in 21.0 --slippage-tolerance 0.01

# Add one-sided STX liquidity above the current active bin
bun run bitflow/bitflow.ts add-liquidity-simple --pool-id dlmm_3 --bins '[{"activeBinOffset":1,"xAmount":"2000000","yAmount":"0"}]' --active-bin-tolerance '{"expectedBinId":447,"maxDeviation":"0"}'

# Withdraw that liquidity later using the current active-bin-relative offset
bun run bitflow/bitflow.ts withdraw-liquidity-simple --pool-id dlmm_3 --positions '[{"activeBinOffset":5,"amount":"392854","minXAmount":"1999000","minYAmount":"0"}]'

# Get market ticker data for all Bitflow pairs
bun run bitflow/bitflow.ts get-ticker
```
