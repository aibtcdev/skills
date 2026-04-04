---
name: hodlmm-yield-compare-agent
skill: hodlmm-yield-compare
description: "Capital allocation intelligence: compares Bitflow HODLMM pool yields against Zest lending and STX stacking using real on-chain data. Read-only; no wallet required."
---

# Agent Behavior -- HODLMM Yield Compare

## When to use

- Before deploying sBTC or STX to any DeFi protocol, run `compare` or `rank` to identify the best destination.
- Before adding liquidity to a specific HODLMM pool, run `hodlmm-detail --pool-id <id>` for a head-to-head verdict.
- Periodically to monitor yield shifts across the Stacks DeFi landscape.
- After `hodlmm-risk` flags a regime change, to check if alternatives now outperform.

## Decision order

1. Run `doctor` to confirm all data sources are reachable.
2. Run `rank --top 5` to get the current yield leaderboard.
3. Read `riskAdjustedScore` -- this accounts for IL and liquidity risk, not just raw APR.
4. If a specific HODLMM pool is being considered, run `hodlmm-detail --pool-id <id>`.
5. Read the `verdict` field -- it states whether the pool outperforms alternatives and by how much.
6. Pass the decision to downstream skills:
   - Safe to LP? -> `hodlmm-risk assess-pool` for volatility gating
   - Execute LP? -> `bitflow` skill for liquidity operations
   - Lend instead? -> `defi zest-supply` or `yield-hunter`
   - Stack instead? -> `stacking` skill

## Guardrails

- This skill is read-only. It never writes to chain or moves funds.
- Never treat APR as guaranteed. HODLMM APR fluctuates with volume and liquidity shifts.
- Always present both raw APR and risk-adjusted score. Never show APR alone.
- Flag pools with `tvlUsd < 1000` as high risk -- thin liquidity means real slippage on entry/exit.
- Flag pools with `aprPct: 0` and `volumeUsd1d: 0` as inactive -- no volume means no fee income.
- When `riskLabel` is `high`, surface this to the user before recommending the pool.
- Default to `bestRiskAdjusted` unless the user explicitly accepts higher risk.
- Never expose secrets or private keys in args or logs.

## Composability

This skill is the **pre-decision layer** in the capital allocation workflow:

```
hodlmm-yield-compare rank    -> "Where should capital go?"
hodlmm-risk assess-pool      -> "Is this pool safe right now?"
bitflow / defi / stacking     -> Execute the allocation
yield-dashboard overview      -> Monitor the position over time
```

## Output contract

All commands return structured JSON to stdout.

**doctor:** API health status for Bitflow, Hiro, and Zest contract reads.

**compare:** Full `hodlmmPools[]`, `alternatives[]`, `ranked[]` (by risk-adjusted score), `bestOverall`, `bestRiskAdjusted`, `summary`.

**rank:** Compact `ranked[]` with `rank`, `aprPct`, `riskScore`, `riskAdjustedScore`, `tvlUsd`.

**hodlmm-detail:** Pool-specific deep dive with real APR/volume/fees/composition, head-to-head comparison, and a `verdict` string.

## On error

- Errors are returned as JSON: `{ "error": "descriptive message" }`
- Do not retry silently -- surface the error to the user.
- If Bitflow APIs are down, the skill cannot produce HODLMM data. Report the failure via `doctor`.
- If the Zest contract read fails, Zest will show 0% APR (not a fallback estimate).

## On success

- Lead with the `summary` or `verdict` -- these are the actionable takeaways.
- Highlight any HODLMM pool that outperforms stacking on a risk-adjusted basis (score > 0.8).
- Include timestamp so agents can assess data freshness before acting.
