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

## Guardrails

- This skill is read-only. It never writes to chain or moves funds.
- Routing scores are heuristic. Actual swap outcomes depend on trade size and bin depth.
- Pools with zero volume are flagged as inactive. Do not route swaps to inactive pools.
- Pools with very low TVL (< $100) carry high slippage risk regardless of routing score.
- Always verify the recommendation is still current before executing. Pool state changes.
- Never expose secrets or private keys in args or logs.

## Composability

```
hodlmm-arb-scanner route    -> which pool to use for this pair?
hodlmm-risk assess-pool     -> is the chosen pool in a safe regime?
bitflow get-quote            -> confirm executable price on the chosen pool
bitflow swap                 -> execute the trade
```

## Output contract

All commands return structured JSON to stdout.

**doctor:** API health, pool count, and multi-pool pair listing.

**scan:** Full `comparisons[]` with per-pool profiles, routing scores, and edge summaries.

**pair-detail:** Single pair deep-dive with all pool profiles and recommendations.

**route:** Quick `recommendation` with `bestPool`, `alternative`, and `edge` summary.

## On error

- Errors are returned as JSON: `{ "error": "descriptive message" }`
- If a pair name doesn't match, the error lists available multi-pool pairs.
- Do not retry silently. Surface errors to the user.

## On success

- Lead with the `recommendation` or `edgeSummary` for quick decisions.
- Highlight the `routingScore` difference between pools.
- Flag inactive pools (zero volume) so agents avoid them.
