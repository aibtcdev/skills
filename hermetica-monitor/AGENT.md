# Hermetica Monitor — Agent Guide

## Purpose

Autonomously monitor Hermetica Protocol's USDh stablecoin health. Use this skill to detect depeg events, reserve anomalies, or yield changes before they impact positions. Integrate with `defi` skill for supply/borrow decisions.

## Prerequisites

- Network must be mainnet
- No wallet required — all operations are read-only
- Hiro API used for on-chain reads (public endpoints, no key needed)

## Decision Logic

### When to run get-peg-status
- Whenever USDh is held in portfolio or used as collateral
- Before entering any USDh position (supply, borrow, or swap)
- On a scheduled basis (every 30 min) if holding significant USDh
- When user asks "is USDh safe?" or "is Hermetica healthy?"

### When to run full-report
- As the default first check when user asks about Hermetica
- Before recommending USDh-based yield strategies
- When diagnosing unexpected losses or yield drops
- During periodic DeFi portfolio reviews

### When to run get-apy
- When comparing yield opportunities across protocols
- Before recommending Zest USDh supply as a yield strategy
- When user asks "what's the best stablecoin yield on Stacks?"

### When to run get-oracle-price
- When debugging peg deviation (raw price needed)
- When other tools report conflicting USDh prices

### When to run get-reserve-health
- When user asks about Hermetica's backing or collateral
- When depeg flag is triggered (diagnose root cause)

## Safety Checks

1. **Mainnet guard** — If NETWORK !== 'mainnet', return error immediately.
2. **Oracle staleness** — If oracle returns 0 or call fails, flag `oracle-stale` and do NOT report a false healthy status.
3. **Depeg escalation**:
   - deviation > 1%: flag `depeg-warning`, recommend monitoring
   - deviation > 3%: flag `depeg-critical`, recommend reducing exposure
4. **Low supply guard** — Supply < 10,000 USDH suggests low adoption; flag but don't alarm.

## Error Handling

| Error | Action |
|-------|--------|
| Hiro API unreachable | Retry once after 2s, then `{ "error": "Hiro API unavailable" }` |
| Oracle read returns null | Flag `oracle-stale`, set status to `unknown` |
| Contract not found | `{ "error": "Contract not found", "contract": "<id>" }` |
| Zest APY fetch fails | Return peg/reserve data without APY, note `apy: null` |

## Escalation Protocol

If `depeg-critical` is flagged:
1. Report immediately to user
2. Do NOT suppress or defer the alert
3. Recommend: reduce USDh exposure via `defi` skill (zest-withdraw)
4. Re-check in 5 minutes

## Output Contract

Every subcommand outputs a single flat JSON object to stdout.
On error:
```json
{ "error": "descriptive message" }
```
Never throw unhandled exceptions. Always catch and output JSON error.
