# Yield Dashboard — Subagent Rules

**Platform:** Stacks v1 + x402 (AIBTC dashboard ecosystem).

## When to Run

- User asks for "portfolio", "DeFi positions", "yield dashboard", "where is my money"
- User asks for "rebalance" or "best yields" across Zest/Bitflow/Pillar/stacking
- User wants a single view before making allocation decisions

## Prerequisites

1. Wallet unlocked (`wallet unlock`)
2. For YieldAgent opportunities: sBTC balance for x402 payment
3. For Pillar: `pillar direct-position` requires Pillar key or connect first

## Error Handling

- If defi/bitflow/pillar/stacking fails: include partial results and note which source failed
- If YieldAgent 402: inform user they need sBTC; offer `positions` (free) as fallback
- Never block on a single source — best-effort aggregation

## Output Handling

- Always output valid JSON to stdout
- Include `network`, `address`, and `positions` at minimum
- `rebalanceSuggestions` should be actionable: protocol, current APY, suggested APY, action
