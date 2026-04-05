---
name: hodlmm-arb-scanner-agent
skill: hodlmm-arb-scanner
description: "Cross-pool HODLMM efficiency scanner: compares fees, depth, volume, and routing quality across pools trading the same pair. Read-only; no wallet required."
---

# Agent Behavior -- HODLMM Arb Scanner

## When to use

- Before executing a swap, run `route --pair <pair>` to find the best pool for execution.
- Before adding LP, run `scan` to compare APR and composition across same-pair pools.
- Periodically to monitor structural shifts (TVL migration, volume changes, new pools).

## Decision order

1. Run `doctor` to confirm APIs are reachable and multi-pool pairs exist.
2. Run `route --pair <pair>` for a quick swap routing recommendation.
3. For deeper analysis, run `pair-detail --pair <pair>` to see full pool profiles.
4. Run `scan` for a complete cross-pool overview of all multi-pool pairs.
5. Use the `bestForSwap` and `bestForLp` recommendations to guide downstream actions.

## Refusal conditions

1. Never route swaps to a pool with `volumeUsd1d: 0`. Zero volume means the pool is inactive and likely has stale pricing.
2. Never recommend a pool with `tvlUsd < 100` for swap execution. Thin liquidity causes excessive slippage.
3. Never present routing scores without the underlying data (TVL, volume, fees). Agents must see the basis for the recommendation.
4. Never recommend LP placement in a pool with `compositionBalance < 0.1`. Single-sided pools cannot generate fee income.
5. Never cache or persist routing recommendations across calls. Pool state changes between invocations.
6. Never expose secrets, private keys, or wallet passwords in arguments or output.
7. Never execute trades or move funds. This skill is strictly read-only.

## Composability

Pre-swap routing workflow:

```
hodlmm-arb-scanner route    -> which pool to use for this pair?
hodlmm-risk assess-pool     -> is the chosen pool in a safe regime?
bitflow get-quote            -> confirm executable price on the chosen pool
bitflow swap                 -> execute the trade
```

Pre-LP workflow:

```
hodlmm-arb-scanner scan     -> compare APR and composition across pools
hodlmm-yield-compare rank   -> is HODLMM the best yield source vs alternatives?
hodlmm-risk assess-pool     -> check volatility regime before adding LP
bitflow-lp-sniper deploy    -> execute the LP position
```

## Output contract

All commands return structured JSON to stdout with a top-level `status` field.

**Success:**
```json
{
  "status": "ok",
  "network": "mainnet",
  "...": "command-specific fields"
}
```

**Error:**
```json
{
  "status": "error",
  "error": "descriptive message"
}
```

**doctor:** API health, pool count, and multi-pool pair listing.

**scan:** Full `comparisons[]` with per-pool profiles, routing scores, and edge summaries.

**pair-detail:** Single pair deep-dive with all pool profiles and recommendations.

**route:** Quick `recommendation` with `bestPool`, `alternative`, and `edge` summary.

## On error

- All errors are returned as JSON with `status: "error"` and non-zero exit code.
- If a pair name doesn't match, the error lists available multi-pool pairs.
- Do not retry silently. Surface errors to the user.

## On success

- Lead with the `recommendation` or `edgeSummary` for quick decisions.
- Highlight the `routingScore` difference between pools.
- Flag inactive pools (zero volume) so agents avoid them.
