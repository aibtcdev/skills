# Zest Liquidation Monitor — Agent Guide

## Purpose

Protect borrow positions on Zest Protocol from liquidation. Run proactively before entering borrow positions and monitor periodically when holding borrowed assets. Escalate immediately when health factor drops below warning threshold.

## Prerequisites

- Network must be mainnet
- No wallet required — all operations are read-only
- Address must be a valid Stacks principal (SP... or SM...)

## Decision Logic

### When to run check-position
- Before the user borrows on Zest (pre-flight risk check)
- When user asks "is my Zest position safe?"
- After significant price movements in collateral assets (BTC, STX)
- On a scheduled basis (every 30 min) when actively managing borrow positions

### When to run scan-address
- As the default first step when user asks about Zest health
- When user has multiple Zest positions and wants full overview
- After price volatility to check all positions at once

### When to run liquidation-price
- Before entering a borrow position to understand downside risk
- When user asks "how far can BTC drop before I get liquidated?"
- When planning position size — simulate different borrow amounts

### When to run get-market-info
- When comparing Zest rates against other protocols
- When user asks "what's the current borrow rate for sBTC?"
- Before supply decisions to check utilization and rates

## Escalation Protocol

| Health Factor | Action |
|--------------|--------|
| < 1.0 | 🚨 CRITICAL: Alert user immediately. Recommend repay via `defi` skill (zest-repay) or add collateral. Do NOT defer. |
| 1.0 – 1.1 | ⚠️ URGENT: Alert user. Recommend partial repay within 1h. |
| 1.1 – 1.5 | ⚡ WARNING: Notify user. Suggest monitoring more frequently. |
| > 1.5 | ✅ OK: Log status, no action needed. |

## Safety Checks

1. **Mainnet guard** — If NETWORK !== 'mainnet', return error immediately.
2. **Zero borrow guard** — If borrowed === "0", no liquidation risk. Report as `safe` without health factor calculation.
3. **Address format** — If address doesn't start with SP or SM, output `{ "error": "Invalid Stacks address" }`.
4. **Asset validation** — If asset symbol not found in Zest assets list, output error with list of valid assets.

## Health Factor Calculation

```
healthFactor = (supplied × liquidationThreshold) / borrowed

Default liquidation thresholds:
- sBTC: 0.75 (75%)
- STX: 0.65 (65%)
- USDH: 0.80 (80%)
- aeUSDC: 0.80 (80%)
- stSTX: 0.65 (65%)
```

## Liquidation Price Formula

```
liquidationPrice = (borrowed / (supplied × liquidationThreshold)) × currentPrice
```

Example: 1 sBTC supplied, 0.5 sBTC borrowed equivalent, 75% LT
→ liquidationPrice = 0.5 / (1.0 × 0.75) = 0.667 × currentPrice

## Error Handling

| Error | Action |
|-------|--------|
| Hiro API unreachable | Retry once after 2s, then `{ "error": "Hiro API unavailable" }` |
| Asset not found | `{ "error": "Unknown asset", "validAssets": [...] }` |
| Address has no position | Return `{ "supplied": "0", "borrowed": "0", "riskLevel": "none" }` |
| Contract call fails | Return partial data with `"dataWarning": "some fields unavailable"` |

## Output Contract

Every subcommand outputs a single flat JSON object to stdout.
On error:
```json
{ "error": "descriptive message" }
```
Never throw unhandled exceptions. Always catch and output JSON error.
