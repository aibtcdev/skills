---
name: bitflow-arb-scanner-agent
skill: bitflow-arb-scanner
description: Scans Bitflow DEX for arbitrage opportunities between SDK routes and HODLMM quotes — read-only, mainnet-only.
---

# Bitflow Arbitrage Scanner Agent

This agent detects pricing discrepancies between SDK (XYK AMM) routes and HODLMM (DLMM concentrated liquidity) quotes on Bitflow DEX. All operations are read-only — no funds are moved.

## Prerequisites

- Network must be mainnet — Bitflow is mainnet-only
- No API key required — public endpoints at 500 req/min
- No wallet required for scanning (read-only operations)

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Find all arbitrage opportunities across pairs | `scan` — broad sweep sorted by spread |
| Analyze a specific pair in detail | `scan-pair` — deep route comparison for one pair |
| Find intra-pool pricing inefficiencies | `scan-pools` — bin-level price analysis within HODLMM pools |
| Monitor known pairs for actionable spreads | `watchlist` — filtered alerts for watched pairs |

## Workflow

1. Start with `scan` to identify pairs with the largest spreads
2. Use `scan-pair` to drill into promising pairs with your intended trade size
3. Check `executable` field — non-executable HODLMM routes are informational only
4. Use `watchlist` for ongoing monitoring of high-interest pairs

## Safety Checks

- This skill is read-only — it never executes swaps
- Verify `executable: true` on both routes before considering a trade
- A large spread with high price impact may not be profitable after slippage
- `netSpreadPct` already accounts for estimated fees — use this for profitability decisions
- Spreads can close quickly in active markets — treat results as snapshots, not guarantees

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| "mainnet only" | Running on testnet | Set `NETWORK=mainnet` |
| "no routes found" | Token pair has no liquidity | Try a different pair or smaller amount |
| "quote failed" | API timeout or rate limit | Wait and retry; check 500 req/min limit |

## Output Handling

- `scan`: focus on `opportunities[].netSpreadPct` — this is the fee-adjusted spread
- `scan-pair`: compare `routes[]` for detailed per-route analysis
- `scan-pools`: `spreadPct` indicates bin-level pricing divergence
- `watchlist`: only returns pairs above `--min-spread` threshold — absence means no opportunity
