---
name: hodlmm-fee-harvester
description: "HODLMM fee yield analytics and harvest-readiness scoring. Tracks pool-level fee generation rates, computes fee efficiency metrics (fees/TVL), grades each pool A-F, estimates per-position fee share for LP wallets, and signals when accumulated fees justify a harvest action. Read-only; no wallet required."
metadata:
  author: "lekanbams"
  author-agent: "Yield Oracle"
  user-invocable: "false"
  arguments: "doctor | scan | pool-fees | position | portfolio"
  entry: "hodlmm-fee-harvester/hodlmm-fee-harvester.ts"
  requires: ""
  tags: "l2, defi, read-only, mainnet-only"
---

# HODLMM Fee Harvester Skill

## Use case

An LP agent with positions across multiple HODLMM pools needs to know: **"Are my positions actually earning fees, and is it worth claiming them?"**

Today, no skill answers this. `hodlmm-risk` monitors volatility but ignores fees. `hodlmm-yield-compare` ranks pools by APR before entry but doesn't track post-entry performance. `yield-dashboard` covers Zest/ALEX/Stacking but excludes HODLMM entirely. `hodlmm-pulse` tracks fee velocity trends but not per-position accrual.

This skill fills the post-entry monitoring gap: how much has each position earned, is the pool still generating meaningful fees, and should the agent harvest now or wait?

## What it does

- Scans all HODLMM pools and grades each A-F based on fee generation efficiency
- Computes fee efficiency: daily fees as a percentage of TVL
- Tracks fees at 1-day, 7-day, 30-day, and lifetime windows
- For a given wallet, estimates proportional fee share across all positions
- Signals **harvest readiness** when accumulated fees exceed a $1 minimum threshold

## Safety notes

- Read-only. Never writes to chain, moves funds, or triggers harvests.
- Mainnet only.
- No wallet required for pool-level commands. Wallet address required for position commands (read-only query).
- Fee estimates are proportional approximations based on position share of TVL.
- Harvest thresholds are hardcoded: minimum $1 USD value before recommending harvest.
- Minimum fee efficiency threshold: 0.01% daily fees/TVL to classify a pool as active.

## Commands

### doctor

Health check: verify API connectivity and fee data availability.

```
bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts doctor
```

### scan

All pools graded by fee generation. Sorted by fee efficiency.

```
bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts scan
```

### pool-fees

Detailed fee breakdown for a specific pool.

```
bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts pool-fees --pool-id dlmm_1
```

### position

Fee accrual estimate for a wallet's position in a specific pool.

```
bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts position --address SP... --pool-id dlmm_1
```

### portfolio

Scan all pools for a wallet's positions with total fee estimates.

```
bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts portfolio --address SP...
```

## Harvest grading methodology

Each pool receives a grade based on fee efficiency and volume:

| Grade | Criteria | Meaning |
|-------|----------|---------|
| A | APR >= 20% AND daily efficiency >= 0.05% | Excellent fee generation, high activity |
| B | APR >= 10% AND daily efficiency >= 0.02% | Good fee generation |
| C | APR >= 3% AND daily efficiency >= 0.005% | Moderate, worth monitoring |
| D | APR > 0% | Low fee generation |
| F | Zero fees or zero volume | Inactive pool |

**Fee efficiency** = (daily fees USD / TVL USD) * 100. Higher means more fee income per dollar of liquidity.

## Output contract

All commands return structured JSON to stdout with a top-level `status` field:

```json
{ "status": "ok", "...": "command-specific data" }
```

On error:
```json
{ "status": "error", "error": "descriptive message" }
```

## Known constraints

- Mainnet only.
- Fee estimates for positions are proportional to TVL share. Actual fees depend on which bins are active (bins near the active price earn more).
- Harvest readiness is advisory. This skill never triggers transactions.
- The `portfolio` command makes N+1 API calls (1 per pool). At 8 pools this is fast; may slow if pool count grows significantly.
- `MIN_HARVEST_VALUE_USD` is hardcoded at $1.00. Below this, gas costs exceed fee value.

## Origin

Submitted to AIBTC x Bitflow Skills Pay the Bills competition.
Author: @lekanbams
