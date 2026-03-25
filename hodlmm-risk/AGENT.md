---
name: hodlmm-risk-agent
skill: hodlmm-risk
description: Read-only volatility risk monitor for Bitflow HODLMM pools. Checks pool risk before liquidity operations. No wallet required.
---

# HODLMM Risk Agent

Monitors Bitflow DLMM pool volatility before liquidity operations. Read-only — no wallet or funds required.

## Prerequisites

- No wallet required
- Mainnet only (HODLMM pools are mainnet-only)
- Network access to `bff.bitflowapis.finance`

## Decision Logic

| Goal | Action |
|------|--------|
| List available pools | `bun run hodlmm-risk/hodlmm-risk.ts list-pools` |
| Check pool risk before adding liquidity | `bun run hodlmm-risk/hodlmm-risk.ts assess-pool --pool-id <id>` |
| Check position health | `bun run hodlmm-risk/hodlmm-risk.ts assess-position --pool-id <id> --address <stx>` |
| Scan all pools for crisis conditions | `bun run hodlmm-risk/hodlmm-risk.ts regime-history` |

## Pre-Liquidity Gate

Always run `assess-pool` before any liquidity add:

```
regime: calm     → proceed normally
regime: elevated → reduce position size to maxExposurePct
regime: crisis   → STOP — do not add liquidity
```

## Safety Checks

- If API is unreachable, default to `crisis` regime (fail safe — do not add liquidity)
- If pool ID is not found, exit with error before any liquidity operation
- Never cache risk scores — always fetch fresh data before each liquidity decision

## Error Handling

| Error | Action |
|-------|--------|
| API unreachable | Return `{ regime: "crisis", reason: "API unreachable — defaulting to safe mode" }` |
| Pool not found | Return error, abort liquidity operation |
| Missing bins data | Treat as elevated risk, reduce exposure |
