---
name: hodlmm-risk-agent
skill: hodlmm-risk
description: HODLMM volatility risk monitoring — pool risk assessment, position scoring, and regime classification for LP agents on Bitflow.
---

# HODLMM Risk Agent

This agent provides volatility-aware risk intelligence for HODLMM liquidity positions on Bitflow. It reads pool bin state, computes volatility metrics, classifies the current regime, and outputs actionable signals that other agents use to gate liquidity operations.

## Prerequisites

- Network must be mainnet — Bitflow HODLMM is mainnet-only.
- No wallet required — all operations are read-only.
- No API key required — uses Bitflow BFF public API endpoints.
- For `assess-position` with a specific address, pass `--address`; otherwise it reads the active wallet address from config.

## Decision Logic

| Goal | Subcommand |
|------|------------|
| Check if a pool is safe for new liquidity | `assess-pool --pool-id <id>` |
| Evaluate an existing LP position's risk | `assess-position --pool-id <id> [--address]` |
| View volatility trend over time | `regime-snapshot --pool-id <id>` |

## Safety Checks

- Always call `assess-pool` before any `bitflow add-liquidity-simple` operation.
- If `regime` is `crisis` (score > 60), do NOT add liquidity — signal the calling agent to wait or withdraw.
- If `regime` is `elevated` (score 31-60), reduce position size: use `signals.maxExposurePct` as the cap.
- For `assess-position`: if `recommendation` is `withdraw`, the calling agent should run `bitflow withdraw-liquidity-simple`.
- If `driftScore` > 50, the position has moved far from the active bin and is likely earning minimal fees.
- Never use this skill's output as the sole basis for financial decisions — it provides risk signals, not financial advice.

## Error Handling

| Error message | Cause | Fix |
|---------------|-------|-----|
| "Pool not found" | Invalid pool ID | Use `bitflow get-hodlmm-pools` to list valid pools |
| "No bins returned" | Pool has no active bins or API error | Retry; check pool status via Bitflow UI |
| "Address has no position" | Wallet has no LP in this pool | Verify address and pool ID |
| "Network must be mainnet" | Running on testnet | Set `NETWORK=mainnet` |

## Output Handling

- `assess-pool`: Use `volatilityScore` and `regime` to gate downstream actions. `signals.safeToAddLiquidity` is a boolean shortcut.
- `assess-pool`: `signals.recommendedBinWidth` suggests how many bins wide a new position should be given current volatility.
- `assess-pool`: `signals.maxExposurePct` is the recommended maximum portfolio percentage to deploy in this pool.
- `assess-position`: `recommendation` is one of `hold`, `withdraw`, or `rebalance`.
- `assess-position`: `impermanentLossEstimatePct` is approximate IL based on bin drift since entry.
- `regime-snapshot`: `trend` is `stable`, `increasing`, or `decreasing` — indicates volatility direction.

## Example Invocations

```bash
# Check pool risk before adding liquidity
bun run hodlmm-risk/hodlmm-risk.ts assess-pool --pool-id dlmm_3

# Evaluate your current position
bun run hodlmm-risk/hodlmm-risk.ts assess-position --pool-id dlmm_3

# Check volatility trend
bun run hodlmm-risk/hodlmm-risk.ts regime-snapshot --pool-id dlmm_3
```
