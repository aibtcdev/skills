---
name: hodlmm-arb-scanner
description: "Cross-pool HODLMM efficiency scanner. When the same token pair trades in multiple Bitflow HODLMM pools with different bin configurations, execution quality varies. This skill compares fees, depth, volume, and composition across pools to recommend optimal swap routing and LP placement. Read-only; no wallet required."
metadata:
  author: "lekanbams"
  author-agent: "Yield Oracle"
  user-invocable: "false"
  arguments: "doctor | scan | pair-detail | route"
  entry: "hodlmm-arb-scanner/hodlmm-arb-scanner.ts"
  requires: ""
  tags: "l2, defi, read-only, mainnet-only"
---

# HODLMM Arb Scanner Skill

## Use case

Bitflow HODLMM allows the same token pair to trade across multiple pools with different bin step configurations. For example, sBTC/USDCx currently trades in two pools (dlmm_1 with step 10, dlmm_2 with step 1), and STX/USDCx trades in three pools. An agent executing a swap or adding LP needs to know: **"Which pool gives me the best execution?"**

No existing skill answers this. The Bitflow `get-quote` command routes through a single pool. `hodlmm-risk` monitors risk for one pool at a time. This skill compares all pools for the same pair simultaneously and provides a routing recommendation based on a composite scoring model.

**Current state (2026-04-05):** 2 multi-pool pairs on mainnet (sBTC/USDCx: 2 pools, STX/USDCx: 3 pools). As more pools are created, cross-pool routing becomes increasingly important.

## What it does

- Identifies all token pairs trading in 2+ HODLMM pools
- Profiles each pool: TVL depth, daily volume, fee structure, APR, composition balance
- Computes a **routing score** (0-100) per pool based on weighted factors
- Recommends the best pool for swap execution and the best pool for LP
- Surfaces structural edges: TVL dominance, fee differences, inactive pools

## Safety notes

- Read-only. Never writes to chain or moves funds.
- Mainnet only.
- No wallet or funds required.
- Routing scores are based on current state. Pool conditions change.
- This skill compares execution quality, not precise swap prices.

## Commands

### doctor

Health check with multi-pool pair detection.

```
bun run hodlmm-arb-scanner/hodlmm-arb-scanner.ts doctor
```

### scan

Full cross-pool comparison for all multi-pool pairs.

```
bun run hodlmm-arb-scanner/hodlmm-arb-scanner.ts scan
```

### pair-detail

Deep comparison of a specific pair across all its pools.

```
bun run hodlmm-arb-scanner/hodlmm-arb-scanner.ts pair-detail --pair sBTC/USDCx
```

### route

Quick answer: which pool should I use?

```
bun run hodlmm-arb-scanner/hodlmm-arb-scanner.ts route --pair sBTC/USDCx
```

## Routing score methodology

Composite score (0-100) weighted across four factors:

| Factor | Weight | What it measures |
|--------|--------|-----------------|
| TVL depth | 40% | Deeper pools = less slippage |
| Volume activity | 30% | Active pools = tighter spreads from arb bots |
| Fee efficiency | 20% | Lower fees = better execution |
| Composition balance | 10% | Balanced pools = two-sided liquidity |

## Output contract

All commands return structured JSON to stdout with a top-level `status` field:

```json
{ "status": "ok", "network": "mainnet", "...": "command-specific data" }
```

On error:
```json
{ "status": "error", "error": "descriptive message" }
```

## Known constraints

- Mainnet only.
- Currently 2 multi-pool pairs. Skill becomes more valuable as pool count grows.
- Routing score is a heuristic. Actual swap outcomes depend on trade size and bin depth at execution time.
- All data from Bitflow app/v1 API (real TVL, volume, fees, APR).
- Pools with zero volume are flagged as inactive in the edge summary.

## Origin

Submitted to AIBTC x Bitflow Skills Pay the Bills competition.
Author: @lekanbams
