---
name: hodlmm-portfolio-tracker
description: "HODLMM portfolio dashboard — aggregates all concentrated LP positions for a wallet, showing fee accrual, IL exposure, net P&L, and portfolio health score."
metadata:
  author: "cocoa007"
  author-agent: "Fluid Briar"
  user-invocable: "false"
  arguments: "doctor | overview --address <addr> | positions --address <addr> [--sort <field>] | health --address <addr>"
  entry: "hodlmm-portfolio-tracker/hodlmm-portfolio-tracker.ts"
  requires: "settings"
  tags: "defi, l2, mainnet-only, read-only"
---

# HODLMM Portfolio Tracker

Portfolio dashboard for Bitflow HODLMM concentrated liquidity positions. Aggregates all active positions for a wallet address, calculates fee accrual, impermanent loss exposure, net P&L, and overall portfolio health.

## What it does

For a given wallet address, discovers all HODLMM NFT positions, fetches their pool assignments, bin ranges, and liquidity values, then computes:
- **Fee accrual**: estimated fees earned based on pool volume and position bin coverage
- **IL exposure**: impermanent loss at current price vs. entry price for each position
- **Net P&L**: fees minus IL for each position and the portfolio as a whole
- **Health score**: A-F grade based on active bin coverage, IL/fee ratio, concentration risk, and diversification

Four commands: `overview` for a portfolio summary with totals, `positions` for detailed per-position breakdown with sorting, `health` for a portfolio-level health grade with recommendations, and `doctor` for connectivity checks.

## Why agents need it

Individual skills answer narrow questions — "what's the yield?" (Yield Projector), "what's the IL?" (IL Calculator), "should I rebalance?" (Rebalance Signal). But no single skill answers the portfolio-level question: "How are ALL my HODLMM positions doing, combined?" An agent managing multiple concentrated LP positions needs a unified view to make allocation decisions, identify underperformers, and assess overall risk exposure.

This skill is the dashboard that ties the HODLMM series together. Instead of running 5 different skills per position, agents run one command to see everything.

## Commands

### doctor
Test API connectivity and data availability.
```
bun run hodlmm-portfolio-tracker/hodlmm-portfolio-tracker.ts doctor
```

### overview
Portfolio summary: total value, total fees, total IL, net P&L, position count.
```
bun run hodlmm-portfolio-tracker/hodlmm-portfolio-tracker.ts overview --address SP2...
```
Options:
- `--address` (required) — Stacks wallet address

### positions
Detailed per-position breakdown with optional sorting.
```
bun run hodlmm-portfolio-tracker/hodlmm-portfolio-tracker.ts positions --address SP2... --sort pnl
```
Options:
- `--address` (required) — Stacks wallet address
- `--sort` (optional, default: `pnl`) — Sort field: `pnl`, `fees`, `il`, `value`, `pool`

### health
Portfolio health grade (A-F) with recommendations.
```
bun run hodlmm-portfolio-tracker/hodlmm-portfolio-tracker.ts health --address SP2...
```
Options:
- `--address` (required) — Stacks wallet address

## Output contract

All outputs are JSON to stdout.

**overview output:**
```json
{
  "address": "SP...",
  "positionCount": 5,
  "totalValueUsd": 1250.00,
  "totalFeesUsd": 45.20,
  "totalIlUsd": -12.80,
  "netPnlUsd": 32.40,
  "netPnlPct": 2.59,
  "pools": ["STX-sBTC", "STX-ALEX"],
  "timestamp": "2026-04-02T..."
}
```

**positions output:**
```json
{
  "address": "SP...",
  "positions": [
    {
      "nftId": 1234,
      "pool": "STX-sBTC",
      "binRange": [45, 55],
      "activeBin": 50,
      "inRange": true,
      "liquidityUsd": 500.00,
      "feesEarnedUsd": 18.50,
      "ilUsd": -5.20,
      "netPnlUsd": 13.30,
      "netPnlPct": 2.66,
      "holdDays": 14
    }
  ],
  "sortedBy": "pnl"
}
```

**health output:**
```json
{
  "address": "SP...",
  "grade": "B+",
  "score": 82,
  "factors": {
    "activeBinCoverage": { "score": 90, "detail": "4/5 positions in range" },
    "ilFeeRatio": { "score": 78, "detail": "IL is 28% of fee income" },
    "concentration": { "score": 75, "detail": "60% of value in one pool" },
    "diversification": { "score": 85, "detail": "2 distinct pools" }
  },
  "recommendations": [
    "Consider diversifying — 60% of portfolio is in STX-sBTC",
    "Position #1234 is out of range — evaluate rebalance"
  ]
}
```

## Known constraints
- Mainnet only — queries Hiro API and Bitflow contracts.
- Position discovery uses NFT holdings lookup — wallets with 100+ HODLMM NFTs may be slow.
- IL calculation uses current bin vs. position midpoint as proxy for entry price (exact entry price not stored on-chain).
- Fee estimates are projected from pool volume data, not exact claimed amounts.
- USD values derived from CoinGecko STX price — may lag during volatile periods.

## Relationship to other HODLMM skills
| Skill | Focus | This skill adds |
|-------|-------|----------------|
| Safety Check | Pre-entry validation | Portfolio-wide risk view |
| Bin Analyzer | Pool liquidity depth | Per-position bin coverage |
| Yield Projector | Forward fee estimates | Actual fee accrual tracking |
| Rebalance Signal | Position drift | Which positions need attention |
| Volume Pulse | Pool fee intensity | Fee income attribution |
| IL Calculator | IL risk modeling | Realized IL per position |
