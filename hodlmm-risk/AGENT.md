---
name: hodlmm-risk-agent
skill: hodlmm-risk
description: "HODLMM volatility risk monitor — regime classification and LP safety signals for Bitflow HODLMM pools. Read-only; no wallet required."
---

# Agent Behavior — HODLMM Risk

## Decision order

1. Call `assess-pool --pool-id <id>` to get current regime and signals.
2. If `regime` is `crisis`, do not add liquidity. Surface the risk to the user.
3. If `regime` is `elevated`, reduce exposure per `maxExposurePct` signal.
4. If `regime` is `calm`, proceed with normal liquidity operations.
5. Before holding or withdrawing, call `assess-position` to check drift and concentration.
6. Follow the `recommendation` field: `hold`, `rebalance`, or `withdraw`.
7. Use `regime-snapshot` for periodic monitoring and store results externally for trend analysis.

## Guardrails

- This skill is read-only. It never writes to chain or moves funds.
- Never proceed with liquidity additions when `safeToAddLiquidity` is `false`.
- Never ignore a `crisis` regime classification.
- Always surface `driftScore` and `recommendation` to the user before acting on position changes.
- Default to safe/read-only behavior when intent is ambiguous.
- Never expose secrets or private keys in args or logs.

## Output contract

All commands return structured JSON to stdout.

**assess-pool output:**
```json
{
  "network": "mainnet",
  "poolId": "string",
  "activeBinId": "number",
  "totalBins": "number",
  "binSpread": "number",
  "reserveImbalanceRatio": "number",
  "volatilityScore": "number (0-100)",
  "regime": "calm | elevated | crisis",
  "signals": {
    "safeToAddLiquidity": "boolean",
    "recommendedBinWidth": "number (3 | 7 | 15)",
    "maxExposurePct": "number (0.25 | 0.10 | 0.0)"
  },
  "timestamp": "ISO 8601"
}
```

**assess-position output:**
```json
{
  "network": "mainnet",
  "poolId": "string",
  "address": "string",
  "positionBinCount": "number",
  "activeBinId": "number",
  "nearestPositionBinOffset": "number",
  "avgBinOffset": "number",
  "concentrationRisk": "high | medium | low",
  "driftScore": "number (0-100)",
  "impermanentLossEstimatePct": "number",
  "recommendation": "hold | rebalance | withdraw",
  "timestamp": "ISO 8601"
}
```

**regime-snapshot output:**
```json
{
  "network": "mainnet",
  "poolId": "string",
  "volatilityScore": "number (0-100)",
  "regime": "calm | elevated | crisis",
  "activeBinId": "number",
  "binSpread": "number",
  "reserveImbalanceRatio": "number",
  "note": "string",
  "timestamp": "ISO 8601"
}
```

## On error

- Errors are returned as JSON: `{ "error": "descriptive message" }`
- Do not retry silently — surface the error to the user.
- Common errors: "No bins returned", "No active liquidity", "Address has no position".
- Network must be mainnet; testnet calls will fail with a clear error.

## On success

- Report the regime classification and key metrics.
- If assessing a position, include the recommendation (hold/rebalance/withdraw).
- Always include timestamp for cache/staleness checks.
