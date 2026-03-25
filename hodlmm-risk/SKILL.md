---
name: hodlmm-risk
description: HODLMM volatility risk monitor — reads Bitflow HODLMM pool state, computes realized volatility from recent bin migrations, scores regime (calm/elevated/crisis), and emits position-sizing or liquidity-pull signals for LP agents. Read-only; no wallet required.
author: locallaunchsc-cloud
author_agent: Risk Sentinel
user-invocable: false
arguments: assess-pool | assess-position | regime-history
entry: hodlmm-risk/hodlmm-risk.ts
requires: []
tags: [l2, defi, read-only, mainnet-only, risk]
---

# HODLMM Risk Skill

Monitors HODLMM (DLMM) pool volatility and LP risk on Bitflow. Agents call this skill before adding, holding, or withdrawing liquidity to get a risk-adjusted view of pool conditions.

- **Pool Risk Assessment** — Computes realized volatility from bin spread, active-bin migration distance, and reserve imbalance across a pool's bins.
- **Position Risk Scoring** — Given a wallet's position bins, scores concentration risk and distance-from-active-bin drift.
- **Regime Classification** — Labels the current volatility regime (calm / elevated / crisis) with a numeric score 0-100 so downstream agents can gate actions.

All operations are **mainnet-only** and **read-only** — no wallet or funds required.

## Usage

```
bun run hodlmm-risk/hodlmm-risk.ts <subcommand> [options]
```

## Subcommands

### assess-pool

Assess volatility and risk metrics for a HODLMM pool.

```
bun run hodlmm-risk/hodlmm-risk.ts assess-pool --pool-id <pool_id>
```

Options:
- `--pool-id` (required) — HODLMM pool identifier (e.g. `dlmm_3`)

Output:
```json
{
  "network": "mainnet",
  "poolId": "dlmm_3",
  "activeBinId": 447,
  "totalBins": 69,
  "binSpread": 0.034,
  "reserveImbalanceRatio": 0.72,
  "volatilityScore": 38,
  "regime": "calm",
  "signals": {
    "safeTo AddLiquidity": true,
    "recommendedBinWidth": 5,
    "maxExposurePct": 0.25
  },
  "timestamp": "2026-03-24T20:00:00.000Z"
}
```

### assess-position

Assess risk for a specific wallet's HODLMM position in a pool.

```
bun run hodlmm-risk/hodlmm-risk.ts assess-position --pool-id <pool_id> [--address <stacks_address>]
```

Options:
- `--pool-id` (required) — HODLMM pool identifier
- `--address` (optional) — Stacks address to check (uses wallet default if omitted)

Output:
```json
{
  "network": "mainnet",
  "poolId": "dlmm_3",
  "address": "SP2...",
  "positionBinCount": 3,
  "activeBinId": 447,
  "nearestPositionBinOffset": 2,
  "concentrationRisk": "medium",
  "driftScore": 15,
  "impermanentLossEstimatePct": 1.2,
  "recommendation": "hold",
  "timestamp": "2026-03-24T20:00:00.000Z"
}
```

### regime-history

Compute a rolling volatility regime history for a pool by sampling bin state.

```
bun run hodlmm-risk/hodlmm-risk.ts regime-history --pool-id <pool_id> [--samples <count>]
```

Options:
- `--pool-id` (required) — HODLMM pool identifier
- `--samples` (optional) — Number of data points to return (default 10, max 50)

Output:
```json
{
  "network": "mainnet",
  "poolId": "dlmm_3",
  "samples": 10,
  "history": [
    {
      "volatilityScore": 38,
      "regime": "calm",
      "activeBinId": 447,
      "timestamp": "2026-03-24T20:00:00.000Z"
    }
  ],
  "trend": "stable"
}
```

## Notes

- All operations are mainnet-only and read-only.
- Uses the Bitflow BFF API and on-chain bin data — no API key required.
- Volatility score ranges 0-100: 0-30 = calm, 31-60 = elevated, 61-100 = crisis.
- Downstream agents should use `assess-pool` before any `bitflow add-liquidity-simple` call.
- `assess-position` helps agents decide whether to hold or withdraw existing liquidity.
