---
name: hodlmm-fee-harvester-agent
skill: hodlmm-fee-harvester
description: "HODLMM fee yield analytics and harvest-readiness scoring. Grades pools A-F by fee efficiency, estimates per-position fee share, signals harvest timing. Read-only; no wallet required."
---

# Agent Behavior -- HODLMM Fee Harvester

## When to use

- After adding LP to a HODLMM pool, periodically run `position` or `portfolio` to track fee accrual.
- Before deciding whether to stay in or exit a pool, check the pool's harvest grade via `pool-fees`.
- Run `scan` to identify which pools are generating the most fees across the ecosystem.
- When `harvestReady` is true, consider claiming fees via the `bitflow` skill.

## Decision order

1. Run `doctor` to confirm APIs are reachable and fee data is available.
2. Run `scan` to see the full landscape of fee-generating pools.
3. For a specific pool, run `pool-fees --pool-id <id>` for fee breakdown and grade.
4. For a wallet's positions, run `portfolio --address <addr>` to see all positions and harvest readiness.
5. If any position shows `harvestReady: true`, pass to downstream execution skills.

## Refusal conditions

1. Never trigger a harvest transaction. This skill is strictly read-only.
2. Never recommend harvesting when estimated fees are below $1.00 USD. Gas costs exceed value.
3. Never recommend LP entry into a pool graded F. Zero fees means zero income.
4. Never present fee estimates as exact amounts. They are proportional approximations.
5. Never cache position data across calls. Position state changes with every block.
6. Never query position data without a user-provided wallet address. Do not guess or enumerate addresses.
7. Never expose wallet addresses, private keys, or secrets in output.

## Composability

Post-entry monitoring workflow:

```
hodlmm-fee-harvester portfolio   -> how are my positions doing?
hodlmm-risk assess-pool          -> is the pool still safe?
hodlmm-fee-harvester pool-fees   -> is the pool still generating fees?
bitflow withdraw-liquidity-simple -> exit if grade drops to D/F
```

Fee harvest workflow:

```
hodlmm-fee-harvester position   -> check if harvestReady
hodlmm-risk regime-snapshot     -> confirm stable regime before acting
bitflow (harvest action)        -> claim accumulated fees
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
- `harvestGrade`: A-F rating of pool fee generation quality
- `harvestReady`: boolean indicating whether position fees justify a claim
- `harvestReason`: human-readable explanation of the harvest decision
- `feeEfficiency1d`: daily fees as percentage of TVL (higher = better)

## On error

- All errors return `status: "error"` with descriptive message and exit code 1.
- If a pool ID doesn't exist, the error includes the API response.
- If a wallet has no positions, it returns `hasPosition: false` (not an error).
- Do not retry silently. Surface errors to the user.

## On success

- Lead with `summary` for scan/portfolio, `verdict` for pool-fees.
- Highlight pools graded A or B as active fee generators.
- Flag `harvestReady` positions for immediate agent action.
- Include `harvestReason` so agents understand the decision logic.
