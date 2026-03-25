---
name: hodlmm-rebalancer-agent
skill: hodlmm-rebalancer
description: Autonomous HODLMM LP agent — manages liquidity positions on Bitflow using risk-aware entry, drift-based rebalancing, and regime-driven exits.
---

# HODLMM Rebalancer Agent

This agent autonomously manages concentrated liquidity positions on Bitflow HODLMM pools. It combines risk intelligence from `hodlmm-risk` with execution via `bitflow` to earn LP fees while protecting capital during volatile periods.

## Prerequisites

- Network must be mainnet — Bitflow HODLMM is mainnet-only.
- Wallet required — must be unlocked with sufficient STX for gas and position capital.
- No API key required — uses Bitflow BFF public API endpoints.
- `hodlmm-risk` skill must be installed for risk assessments.
- `bitflow` skill must be installed for liquidity operations.

## Core Loop

The agent runs `run-cycle` on a recurring schedule (recommended: every 5 minutes):

1. Call `hodlmm-risk assess-pool --pool-id <id>` to get current regime and volatility score.
2. Call `bitflow get-hodlmm-position-bins --pool-id <id>` to check existing position.
3. Call `bitflow get-hodlmm-bins --pool-id <id>` to get active bin and calculate drift.
4. Apply decision matrix (see SKILL.md) to determine action.
5. Execute action via `bitflow add-liquidity-simple` or `bitflow withdraw-liquidity-simple`.
6. Log result to local state file.

## Decision Logic

| Goal | Subcommand |
|------|------------|
| Run one autonomous cycle | `run-cycle --pool-id <id>` |
| Check current state and PnL | `status --pool-id <id>` |
| Manually add liquidity | `add --pool-id <id> --amount <n>` |
| Emergency withdraw | `withdraw --pool-id <id>` |
| Force rebalance | `rebalance --pool-id <id>` |
| Tune parameters | `configure --pool-id <id> --max-exposure <n>` |
| Review past actions | `history --pool-id <id>` |

## Safety Rules

- ALWAYS call `hodlmm-risk assess-pool` before any liquidity operation. Never bypass risk checks.
- If `regime` is `crisis` (score > 60), immediately withdraw ALL positions. Do not add liquidity.
- If `regime` is `elevated` (score 31-60), do NOT open new positions. Reduce existing by 50%.
- Only add liquidity when `regime` is `calm` (score 0-30) AND `safeToAddLiquidity` is true.
- Never deploy more than `maxExposurePct` of wallet balance into a single pool.
- Use `--dry-run` first when testing new configurations.
- If `driftScore` exceeds `rebalanceThreshold`, rebalance before the position goes out of range.
- Always use `get-hodlmm-position-bins` before withdrawing to recalculate correct bin offsets.
- Keep a gas reserve — never deploy 100% of STX balance (leave at least 5 STX for gas).

## Bin Placement Strategy

- Use `signals.recommendedBinWidth` from `hodlmm-risk assess-pool` to determine spread.
- Place bins symmetrically around the active bin: e.g., for width 5: offsets -2, -1, 0, +1, +2.
- Bins below active bin: allocate only `yAmount` (quote token).
- Active bin (offset 0): allocate both `xAmount` and `yAmount`.
- Bins above active bin: allocate only `xAmount` (base token).
- Distribute capital evenly across bins, with slightly more weight on the active bin.

## Error Handling

| Error message | Cause | Fix |
|---------------|-------|-----|
| "Pool not found" | Invalid pool ID | Use `bitflow get-hodlmm-pools` to list valid pools |
| "Insufficient balance" | Not enough STX/tokens | Check wallet balance, reduce position size |
| "Wallet is locked" | Wallet not unlocked | Run `wallet unlock` or pass `--wallet-password` |
| "Risk check failed" | Could not reach risk API | Retry; do NOT proceed without risk assessment |
| "Position not found" | No existing LP position | Use `add` instead of `rebalance` or `withdraw` |
| "Bin offset stale" | Active bin moved since last check | Re-fetch bins and recalculate offsets |

## Output Handling

- `run-cycle`: Primary output. Contains full assessment, decision, reason, and action result.
- `status`: Use `unrealizedPnl` to track performance. Use `driftScore` to anticipate rebalances.
- `history`: Review past actions to evaluate strategy performance over time.
- All transaction results include `txid` for on-chain verification.
- `dryRun: true` outputs simulate the full decision pipeline without spending gas.

## Example Invocations

```bash
# Run one autonomous cycle (the main loop command)
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts run-cycle --pool-id dlmm_3

# Dry run to see what the agent would do
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts run-cycle --pool-id dlmm_3 --dry-run

# Check position status and PnL
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts status --pool-id dlmm_3

# Emergency withdraw everything
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts withdraw --pool-id dlmm_3

# Configure for conservative operation
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts configure --pool-id dlmm_3 --max-exposure 15 --rebalance-threshold 2 --crisis-action withdraw
```
