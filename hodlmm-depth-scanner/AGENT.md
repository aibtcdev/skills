---
name: hodlmm-depth-scanner-agent
skill: hodlmm-depth-scanner
description: "HODLMM liquidity depth analysis: maps bin-level liquidity, estimates slippage at multiple tiers, grades pool depth quality. Read-only; no wallet required."
---

# Agent Behavior -- HODLMM Depth Scanner

## When to use

- Before executing a swap, run `slippage --pool-id <id>` to check if the pool can absorb the trade size.
- Before adding LP, run `pool-depth --pool-id <id>` to check liquidity balance and concentration.
- Run `scan` to compare depth quality across all pools for routing decisions.
- After `hodlmm-arb-scanner` identifies the best pool, verify its depth can handle the intended trade size.

## Decision order

1. Run `doctor` to confirm APIs are reachable and bin data is available.
2. Run `scan` to get depth grades and 1% slippage capacity for all pools.
3. For a specific trade, run `slippage --pool-id <id>` to check capacity at your target slippage.
4. For full analysis, run `pool-depth --pool-id <id>` to see bin distribution and imbalance.
5. Pass depth data to downstream execution skills (`bitflow swap`, `bitflow-lp-sniper`).

## Refusal conditions

1. Never execute trades or move funds. This skill is strictly read-only.
2. Never recommend swapping on a pool graded `empty`. Zero nearby liquidity means infinite slippage.
3. Never recommend swap sizes exceeding the 2% slippage tier capacity. Beyond this, execution quality degrades rapidly.
4. Never present slippage estimates as guaranteed execution prices. Bin state changes between analysis and execution.
5. Never ignore `imbalanceDirection`. A `sell-heavy` pool will have poor buy execution and vice versa.
6. Never cache depth data across calls. Bin liquidity changes with every LP add/remove.
7. Never expose secrets, private keys, or wallet addresses in output.

## Composability

Pre-swap depth check:

```
hodlmm-arb-scanner route       -> which pool for this pair?
hodlmm-depth-scanner slippage  -> can the pool handle my trade size?
hodlmm-risk assess-pool        -> is the pool in a safe regime?
bitflow get-quote               -> get the exact swap quote
bitflow swap                    -> execute
```

LP entry depth check:

```
hodlmm-yield-compare rank      -> which pool has the best yield?
hodlmm-depth-scanner pool-depth -> is liquidity balanced for LP entry?
hodlmm-risk assess-pool        -> volatility regime safe?
bitflow-lp-sniper deploy       -> add LP
```

## Output contract

All commands return structured JSON to stdout with a top-level `status` field.

**Success:**
```json
{ "status": "ok", "network": "mainnet", "...": "command-specific fields" }
```

**Error:**
```json
{ "status": "error", "error": "descriptive message" }
```

**Key fields:**
- `depthScore`: 0-100 composite of depth + balance
- `depthGrade`: deep / moderate / shallow / empty
- `slippageTiers[]`: buy and sell capacity at 0.5%, 1%, 2%, 5% price impact
- `imbalanceDirection`: balanced / buy-heavy / sell-heavy
- `buySide` / `sellSide`: USD value and bin count for each side

## On error

- All errors return `status: "error"` with descriptive message and exit code 1.
- Failed pool fetches log warnings to stderr; successful pools still appear in results.
- Do not retry silently. Surface errors to the user.

## On success

- Lead with `depthGrade` and `verdict` for quick decisions.
- For swap sizing, reference the `slippageTiers` at the agent's acceptable slippage level.
- Flag `imbalanceDirection` when it's not `balanced` so agents know which side is thin.
