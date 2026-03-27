---
name: hodlmm-risk
description: "HODLMM volatility risk monitor — reads Bitflow HODLMM pool state, computes current-state volatility proxy from bin distribution, scores regime (calm/elevated/crisis), and emits position-sizing or liquidity-pull signals for LP agents. Read-only; no wallet required."
metadata:
  author: "locallaunchsc-cloud"
  author-agent: "Risk Sentinel"
  user-invocable: "false"
  arguments: "assess-pool | assess-position | regime-snapshot"
  entry: "hodlmm-risk/hodlmm-risk.ts"
  requires: ""
  tags: "l2, defi, read-only, mainnet-only"
---

# HODLMM Risk Skill
## What it does
Monitors HODLMM (DLMM) pool volatility and LP risk on Bitflow. Computes bin spread, reserve imbalance, and concentration metrics to classify market regime and emit position-sizing signals.
## Why agents need it
Agents managing HODLMM liquidity need a risk gate before adding, holding, or withdrawing. This skill provides that gate — a numeric volatility score and regime label that downstream agents can use to decide whether to act.
## Safety notes
- Read-only — never writes to chain or moves funds.
- Mainnet only — Bitflow HODLMM APIs are mainnet-only.
- No wallet or funds required.
- Pools with all-zero reserves return an error rather than misleading metrics.
## Commands
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
  "binSpread": 0.021,
  "reserveImbalanceRatio": 0.45,
  "volatilityScore": 24,
  "regime": "calm",
  "signals": {
    "safeToAddLiquidity": true,
    "recommendedBinWidth": 3,
    "maxExposurePct": 0.25
  },
  "timestamp": "2026-03-24T20:00:00.000Z"
}
```
### assess-position
Assess risk for a specific wallet's HODLMM position in a pool.
```
bun run hodlmm-risk/hodlmm-risk.ts assess-position --pool-id <pool_id> --address <stx_address>
```
Options:
- `--pool-id` (required) — HODLMM pool identifier
- `--address` (required) — Stacks address to check

Output:
```json
{
  "network": "mainnet",
  "poolId": "dlmm_3",
  "address": "SP2...",
  "positionBinCount": 3,
  "activeBinId": 447,
  "nearestPositionBinOffset": 2,
  "avgBinOffset": 4.33,
  "concentrationRisk": "medium",
  "driftScore": 22,
  "impermanentLossEstimatePct": 1.76,
  "recommendation": "rebalance",
  "timestamp": "2026-03-24T20:00:00.000Z"
}
```
### regime-snapshot
Get a single-point volatility regime snapshot for a pool.
```
bun run hodlmm-risk/hodlmm-risk.ts regime-snapshot --pool-id <pool_id>
```
Options:
- `--pool-id` (required) — HODLMM pool identifier

Output:
```json
{
  "network": "mainnet",
  "poolId": "dlmm_3",
  "volatilityScore": 24,
  "regime": "calm",
  "activeBinId": 447,
  "binSpread": 0.021,
  "reserveImbalanceRatio": 0.45,
  "note": "Single-point snapshot. For trend analysis, store snapshots externally over time.",
  "timestamp": "2026-03-24T20:00:00.000Z"
}
```
## Output contract
All outputs are flat JSON to stdout (no wrapper envelope).

On error:
```json
{ "error": "descriptive error message" }
```
## Known constraints
- Mainnet only — Bitflow HODLMM APIs do not exist on testnet.
- No wallet required — all operations are read-only.
- Volatility score ranges 0-100: 0-30 = calm, 31-60 = elevated, 61-100 = crisis.
- Score weights: bin spread (40%), reserve imbalance (30%), liquidity concentration (30%).
- `driftScore` is derived from `avgBinOffset`: `Math.min(avgOffset * 5, 100)`. Each bin of drift adds +5 score points, capped at 100 (i.e. 20+ bins from active = score 100 = withdraw).
- `impermanentLossEstimatePct` is a linear approximation: `driftScore * 0.08` (max 8% at driftScore=100). This is a rough monitoring proxy, not a precise price-ratio-based IL calculation.
- `concentrationRisk` thresholds: 1 bin = "high", 2-3 bins = "medium", 4+ bins = "low".
- `signals` derivation: calm → `recommendedBinWidth: 3, maxExposurePct: 0.25`; elevated → `recommendedBinWidth: 7, maxExposurePct: 0.10`; crisis → `recommendedBinWidth: 15, maxExposurePct: 0.0`.
- `regime-snapshot` returns the same volatility computation as `assess-pool` but without signals. Use `assess-pool` for decision-gating before LP actions; use `regime-snapshot` for logging/monitoring pipelines.
- `regime-snapshot` returns a single point-in-time reading. For trend analysis, store snapshots externally over time.
- Pools with all-zero reserves will return an error rather than misleading metrics.
- This skill computes a current-state volatility proxy from bin distribution, not historical realized volatility. No time-series or migration tracking is performed.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition Day 2.
Original author: @locallaunchsc-cloud
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/23
