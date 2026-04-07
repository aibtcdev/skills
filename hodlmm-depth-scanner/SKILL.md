---
name: hodlmm-depth-scanner
description: "HODLMM liquidity depth analysis and slippage estimation. Maps bin-by-bin liquidity around the active price, computes buy/sell capacity at 0.5%, 1%, 2%, and 5% slippage tiers, grades pool depth quality, and detects buy/sell-side imbalances. Answers: 'How much can I swap before moving the price?' Read-only; no wallet required."
metadata:
  author: "lekanbams"
  author-agent: "Yield Oracle"
  user-invocable: "false"
  arguments: "doctor | scan | pool-depth | slippage"
  entry: "hodlmm-depth-scanner/hodlmm-depth-scanner.ts"
  requires: ""
  tags: "l2, defi, read-only, mainnet-only"
---

# HODLMM Depth Scanner Skill

## Use case

An agent about to execute a swap on a HODLMM pool faces a critical unknown: **"How much can I trade before the price moves against me?"**

In traditional AMMs, slippage is a function of pool TVL and trade size. In HODLMM (DLMM), it's fundamentally different: liquidity is distributed across discrete bins, and each bin crossing moves the price by exactly `binStep` basis points. A pool with $1M TVL concentrated in 3 bins behaves very differently from one spread across 100 bins. TVL alone tells you nothing about execution quality.

No existing skill answers this. `hodlmm-risk` monitors volatility and regime but doesn't analyse liquidity depth. `hodlmm-arb-scanner` compares pools by routing score but doesn't map bin-level capacity. `bitflow get-quote` gives you a specific swap quote but doesn't show the full depth picture. This skill fills that gap by mapping the actual liquidity at each price level and computing how much can be absorbed before hitting each slippage tier.

**Why this matters for agents:**
- An agent routing a $10K swap through a pool with only $500 in nearby bins will get destroyed by slippage
- An LP agent needs to know if liquidity is balanced (both buy and sell side) or one-sided before entering
- A risk-monitoring agent needs depth data to assess whether a pool can absorb a sell-off without cascading

## What it does

- Maps **bin-by-bin liquidity** within 50 bins of the active price (buy side and sell side separately)
- Computes **USD-denominated swap capacity** at 0.5%, 1%, 2%, and 5% slippage tiers
- Grades each pool's depth **"deep" / "moderate" / "shallow" / "empty"** using a log-scale scoring model
- Detects **buy/sell imbalance**: if one side has significantly more liquidity, large trades in the thin direction will suffer more slippage
- Provides token-decimal-normalized USD values (not raw atomic reserves)

## Safety notes

- Read-only. Never writes to chain or moves funds.
- Mainnet only.
- No wallet or funds required.
- Slippage estimates are based on current bin state. Bins can be added/removed between analysis and execution.
- Capacity figures represent maximum available liquidity, not guaranteed execution. Real swaps may encounter worse pricing due to MEV or concurrent trades.
- Depth scan radius is hardcoded at 50 bins from active. Liquidity beyond this range is excluded.

## Commands

### doctor

Health check: verify API connectivity, bin data, and token price availability.

```
bun run hodlmm-depth-scanner/hodlmm-depth-scanner.ts doctor
```

### scan

All pools ranked by depth score. Shows buy/sell capacity at 1% slippage for quick comparison.

```
bun run hodlmm-depth-scanner/hodlmm-depth-scanner.ts scan
```

### pool-depth

Full depth analysis for a specific pool: bin distribution, all slippage tiers, imbalance detection, and verdict.

```
bun run hodlmm-depth-scanner/hodlmm-depth-scanner.ts pool-depth --pool-id dlmm_1
```

### slippage

Quick slippage table: how much can be bought/sold at each price impact tier.

```
bun run hodlmm-depth-scanner/hodlmm-depth-scanner.ts slippage --pool-id dlmm_1
```

## Depth scoring methodology

Composite score (0-100) from two components:

| Component | Weight | Calculation |
|-----------|--------|-------------|
| Depth (log-scale) | 80 pts max | `min(log10(totalUsd) * 20 - 40, 80)` — $100K = 50, $1M = 75, $10M = 100 |
| Balance | 20 pts max | `(1 - imbalanceRatio) * 20` — perfectly balanced = 20, fully single-sided = 0 |

**Grades:**
- **deep** (>= 60): Can absorb large swaps with minimal price impact
- **moderate** (>= 35): Reasonable for mid-size swaps, larger orders will move price
- **shallow** (> 0): High slippage risk for any meaningful size
- **empty** (0): No liquidity in nearby bins

**Imbalance detection:**
- `balanced`: buy/sell side difference < 20%
- `buy-heavy`: more tokenY (quote) than tokenX (base) near active
- `sell-heavy`: more tokenX than tokenY near active

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
- Depth scan radius is 50 bins from active. Pools with liquidity spread beyond this range will show lower depth than actual.
- Slippage tiers use a geometric model: each bin crossed = `binStep` bps of price movement. Real DLMM execution may differ due to dynamic fees.
- USD values depend on token prices from the Bitflow API. Price staleness during high volatility could affect accuracy.
- The `scan` command makes 2 API calls per pool (rich + bins). At 8 pools this is fast.

## Origin

Submitted to AIBTC x Bitflow Skills Pay the Bills competition.
Author: @lekanbams
