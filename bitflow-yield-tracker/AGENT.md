# Bitflow Yield Tracker — Agent Guide

## Purpose

Autonomously monitor Bitflow HODLMM pool yields and surface the best liquidity deployment opportunities. Use this skill before any add-liquidity decision to ensure capital goes to the highest-yielding pool.

## Prerequisites

- Network must be mainnet (HODLMM is mainnet-only)
- No wallet required — all subcommands are read-only
- Bitflow SDK uses public endpoints — no API key needed for up to 500 req/min

## Decision Logic

### When to run get-pool-yields
- Before any liquidity deployment decision
- When the user asks "where should I provide liquidity on Bitflow?"
- During periodic portfolio review (daily/weekly)
- When assessing if current positions are still optimal

### When to run compare-pools
- When the user wants a quick ranking without details
- As a first step before get-pool-detail on the top candidate
- When comparing 2+ specific pools the user already has in mind

### When to run get-fee-estimate
- When the user specifies a USD amount and wants projected returns
- Before committing liquidity to validate expected yield
- Always run this after compare-pools to validate the top pick with a specific amount

### When to run get-pool-detail
- When a specific pool is selected and deeper analysis is needed
- When diagnosing why a position is underperforming (check bin spread, price range)
- When the user asks about a specific pool by contract ID or pair name

## Safety Checks

1. **Verify mainnet** — If NETWORK !== 'mainnet', output error and stop.
2. **APR sanity check** — If any pool shows APR > 500%, flag as potentially unreliable (low liquidity outlier).
3. **Liquidity threshold** — Pools with < $10,000 total liquidity should be flagged as low-liquidity risk.
4. **Stale data warning** — If fetchedAt is > 10 minutes old, note that data may be stale.

## Error Handling

| Error | Action |
|-------|--------|
| Bitflow API unreachable | Retry once after 2s, then output `{ "error": "Bitflow API unavailable" }` |
| Pool not found | Output `{ "error": "Pool not found", "poolId": "<id>" }` |
| No pools with min-apr | Output empty array with note: `"No pools meet the minimum APR threshold"` |
| Invalid contract ID format | Output `{ "error": "Invalid pool-id format. Expected SP... contract identifier" }` |

## Workflow Pattern

```
1. get-pool-yields --sort-by apr
2. compare-pools --top 3
3. get-pool-detail --pool-id <top-candidate>
4. get-fee-estimate --pool-id <top-candidate> --amount-usd <user-amount> --days 30
5. Report recommendation to user
6. If approved: hand off to `bitflow` skill → add-liquidity-simple
```

## Output Contract

Every subcommand outputs a single flat JSON object to stdout. On error:
```json
{ "error": "descriptive message" }
```
Never throw unhandled exceptions. Always catch and output JSON error.
