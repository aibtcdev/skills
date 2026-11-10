---
name: yield-dashboard
description: "Cross-protocol DeFi yield dashboard for Stacks — view positions across Zest Protocol, ALEX DEX, and Bitflow, see total portfolio value, APY breakdown per protocol, and get rebalance suggestions. Read-only, mainnet-only. Requires an unlocked wallet for address context."
metadata:
  author: "cocoa007"
  author-agent: "Fluid Briar"
  user-invocable: "false"
  arguments: "overview | positions | apy-breakdown | rebalance"
  entry: "yield-dashboard/yield-dashboard.ts"
  mcp-tools: "yield_dashboard_overview, yield_dashboard_positions, yield_dashboard_apy_breakdown, yield_dashboard_rebalance"
  requires: "wallet"
  tags: "l2, defi, read-only, mainnet-only"
---

# Yield Dashboard Skill

Aggregated read-only dashboard across Stacks DeFi protocols: **Zest Protocol** (lending), **ALEX DEX** (AMM LP), and **Bitflow** (DEX LP). Also checks native STX stacking status.

All data is fetched live from Stacks mainnet via Hiro API read-only contract calls.

## Usage

```
bun run yield-dashboard/yield-dashboard.ts <subcommand> [options]
```

## Subcommands

### overview

High-level portfolio summary: total value across all protocols, weighted average APY, and per-protocol breakdown.

```
bun run yield-dashboard/yield-dashboard.ts overview
```

Output:
```json
{
  "totalValueSats": 500000,
  "totalValueBtc": "0.00500000",
  "weightedApyPct": 4.2,
  "protocols": {
    "zest": { "valueSats": 300000, "apyPct": 5.0 },
    "alex": { "valueSats": 150000, "apyPct": 3.5 },
    "bitflow": { "valueSats": 50000, "apyPct": 2.8 },
    "stacking": { "valueSats": 0, "apyPct": 0 }
  },
  "walletSbtcSats": 25000,
  "walletStxMicroStx": 5000000
}
```

### positions

Detailed per-protocol position data.

```
bun run yield-dashboard/yield-dashboard.ts positions
```

Returns an array of positions with protocol, asset, amount, current APY, and any reward info.

### apy-breakdown

Current APY rates across all supported protocols (no wallet needed for this — pure market data).

```
bun run yield-dashboard/yield-dashboard.ts apy-breakdown
```

Output:
```json
{
  "timestamp": "2026-03-06T03:00:00.000Z",
  "rates": [
    { "protocol": "Zest Protocol", "asset": "sBTC", "supplyApyPct": 5.0, "riskScore": 20 },
    { "protocol": "ALEX DEX", "asset": "aBTC/STX LP", "apyPct": 3.5, "riskScore": 50 },
    { "protocol": "Bitflow", "asset": "sBTC", "apyPct": 2.8, "riskScore": 35 },
    { "protocol": "STX Stacking", "asset": "STX", "apyPct": 8.0, "riskScore": 10 }
  ],
  "zestV2Ready": false
}
```

### rebalance

Suggests rebalancing moves based on current positions vs optimal allocation given risk-adjusted APY.

```
bun run yield-dashboard/yield-dashboard.ts rebalance [--risk-tolerance low|medium|high]
```

Options:
- `--risk-tolerance` (optional, default: `medium`) — Risk preference for allocation suggestions

Output:
```json
{
  "currentAllocation": { "zest": 60, "alex": 30, "bitflow": 10, "stacking": 0 },
  "suggestedAllocation": { "zest": 50, "alex": 20, "bitflow": 10, "stacking": 20 },
  "suggestions": [
    "Consider moving 10% from Zest to STX stacking for diversification",
    "ALEX LP has higher IL risk — reduce if STX/BTC volatility is high"
  ]
}
```

## Known Limitations

- **ALEX LP positions**: User LP token balance reading is not yet implemented — `valueSats` will show 0 even if you hold LP tokens. APY is read correctly.
- **Bitflow LP positions**: Same as ALEX — LP balance reading is a TODO. APY falls back to a 2.8% estimate if the Bitflow API is unavailable (output includes `apySource: "fallback estimate"`).
- **ALEX asset**: The ALEX pool uses aBTC (ALEX wrapped BTC), not native sBTC. Different trust assumptions — labeled as "aBTC/STX LP" in output.
- **Stacking value**: STX stacking is denominated in microSTX, not sats. The `overview` command separates these: `totalValueSats` (BTC-denominated) vs `totalValueStx` (STX stacking).
- **Bitflow API**: Uses `https://app.bitflow.finance/api` — undocumented endpoint, may change without notice.

## Notes

- All reads are free (no gas needed) — uses read-only contract calls
- Wallet must be unlocked so the skill knows which address to query
- APY figures are point-in-time estimates from on-chain state
- Bitflow data uses the Bitflow public API (no key required)
- Zest V2 availability is probed automatically; falls back to V1 pool data
