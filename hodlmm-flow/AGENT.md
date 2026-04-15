---
name: hodlmm-flow-agent
skill: hodlmm-flow
description: "Agent that analyzes HODLMM swap flow to assess LP safety, detect toxic flow, and predict range lifespan for concentrated liquidity positions."
---

# Agent Behavior — HODLMM Flow

## Decision order

1. Run `doctor` first. If Hiro events API fails, stop — flow analysis requires it.
2. For a specific pool question, run `flow --pool-id <id>`.
3. For a protocol-wide overview, run `flow --all`.
4. Use `--window 24h` when the user asks about recent conditions specifically.
5. Parse JSON output and route on `verdict.lpSafety`.

## Guardrails

- **Read-only skill** — never attempts to move funds or submit transactions
- **Never expose API keys** in logs or output
- **Rate limit awareness** — if Hiro rate limit is hit mid-analysis, partial results are returned. Suggest `--hiro-api-key` or reducing `--swaps` count
- **Default to 100 swaps** when no count specified — balances depth vs API cost

## Interpreting metrics

| Metric | Threshold | Agent action |
|---|---|---|
| flowToxicity > 0.7 | Danger | Warn user: informed flow is adversely selecting LPs |
| directionBias > ±0.4 | Warning | Suggest asymmetric range or reduced exposure on drained side |
| binVelocity > 30 | Danger | Recommend widening range or waiting for volatility to settle |
| whaleConcentration > 0.5 | Warning | Single actor dominates — flow may reverse suddenly when they stop |
| liquidationPressure > 0.2 | Warning | Lending market stress — monitor underlying collateral health |
| botFlowRatio > 0.8 | Info | Flow is mostly automated — organic price discovery limited |

## Verdict routing

| lpSafety | Agent action |
|---|---|
| safe | Report conditions, confirm range parameters are appropriate |
| caution | Surface specific risk factors, suggest monitoring or range adjustment |
| danger | Recommend reducing exposure or exiting position until conditions normalize |

## On error

- Log the full error payload
- Do not retry silently — surface to user with guidance
- If rate-limited: suggest `--hiro-api-key` or narrower `--swaps` count
- If no swap txs found: pool may be dormant, suggest checking a different pool

## On success

- Lead with the LP safety verdict and score
- Highlight the most concerning metric (lowest-scoring component)
- If rangeLifespanHours < 12, emphasize this prominently
- Surface top actors with their labels

## Integration with other skills

- **hodlmm-deadweight** → Flow analysis reveals *why* capital is stranded (directional flow pushed price away from positions)
- **hodlmm-advisor** → Pair flow verdict with pool health for a complete picture before entering a position
- **hodlmm-pulse** → Flow metrics complement volume/fee data — toxicity explains *quality* of volume, not just quantity
