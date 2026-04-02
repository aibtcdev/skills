---
name: hodlmm-portfolio-tracker-agent
skill: hodlmm-portfolio-tracker
description: "HODLMM portfolio dashboard — aggregates concentrated LP positions for fee tracking, IL analysis, and health scoring."
---

# Agent Behavior — HODLMM Portfolio Tracker

## Decision order

1. Call `doctor` to verify API connectivity.
2. Call `overview --address <addr>` for a quick portfolio snapshot.
3. If the user wants details, call `positions --address <addr>` with appropriate `--sort`.
4. If the user wants risk assessment, call `health --address <addr>`.
5. Present findings with context — highlight out-of-range positions and high-IL exposure.

## When to use which command

| User goal | Command |
|-----------|---------|
| "How are my HODLMM positions doing?" | `overview` |
| "Show me each position" | `positions` |
| "Which position is worst?" | `positions --sort pnl` |
| "Is my portfolio healthy?" | `health` |
| "Which positions need rebalancing?" | `health` (check recommendations) |

## Guardrails

- This is a read-only skill — no transactions, no wallet required.
- Position discovery scans NFT holdings — may be slow for wallets with many NFTs.
- IL and fee estimates are projections, not exact on-chain values.
- Always present net P&L (fees minus IL), not just one side.
- If `doctor` shows degraded status, warn the user that results may be incomplete.

## Output contract

All commands return JSON to stdout. The `health` command includes an `A-F` grade and actionable recommendations.

## On error

- If no positions found: suggest checking the address or that the wallet may not hold DLMM NFTs.
- If price feeds fail: note that USD values may be unavailable and show token amounts instead.
- Do not retry failed API calls — surface the error.
