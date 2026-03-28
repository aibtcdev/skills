---
name: zest-liquidation-monitor
description: "Monitor Zest Protocol borrow positions for liquidation risk — calculate health factors, LTV ratios, safe borrow capacity, and alert when positions approach liquidation threshold. Read-only. Mainnet-only."
metadata:
  author: "ilovewindows10"
  author-agent: "Yuechu"
  user-invocable: "false"
  arguments: "check-position | scan-address | get-market-info | liquidation-price"
  entry: "zest-liquidation-monitor/zest-liquidation-monitor.ts"
  requires: "none"
  tags: "l2, defi, read-only, mainnet-only"
---

# Zest Liquidation Monitor Skill

Monitors [Zest Protocol](https://app.zestprotocol.com) borrow positions for liquidation risk on Stacks. Calculates health factors, LTV ratios, and liquidation prices to help agents protect collateral before liquidation occurs.

- **Position Check** — Get supplied/borrowed amounts, estimated health factor, and risk level for a specific asset.
- **Address Scan** — Scan all Zest assets for a given address and surface any at-risk positions.
- **Market Info** — Fetch market-wide supply/borrow rates, utilization, and liquidation threshold per asset.
- **Liquidation Price** — Calculate the collateral price at which a position would be liquidated.

All operations are **read-only** and require **no wallet**.

## Usage

```
bun run zest-liquidation-monitor/zest-liquidation-monitor.ts <subcommand> [options]
```

## Subcommands

### check-position

Check a specific Zest position for liquidation risk.

```
bun run zest-liquidation-monitor/zest-liquidation-monitor.ts check-position --address <stacksAddress> --asset <symbol>
```

Options:
- `--address` (required) — Stacks address to check
- `--asset` (required) — Asset symbol (e.g. `sBTC`, `STX`, `USDH`, `aeUSDC`)
- `--warn-threshold` (optional) — Health factor warning threshold (default: 1.5)

Output:
```json
{
  "network": "mainnet",
  "address": "SP2...",
  "asset": "sBTC",
  "supplied": "100000000",
  "suppliedFormatted": 1.0,
  "borrowed": "50000000",
  "borrowedFormatted": 0.5,
  "estimatedLtv": 0.5,
  "healthFactor": 1.6,
  "riskLevel": "moderate",
  "alert": false,
  "fetchedAt": "2026-03-28T14:00:00.000Z"
}
```

### scan-address

Scan all Zest assets for a given address and surface at-risk positions.

```
bun run zest-liquidation-monitor/zest-liquidation-monitor.ts scan-address --address <stacksAddress>
```

Options:
- `--address` (required) — Stacks address to scan
- `--warn-threshold` (optional) — Health factor warning threshold (default: 1.5)

Output:
```json
{
  "network": "mainnet",
  "address": "SP2...",
  "positions": [
    {
      "asset": "sBTC",
      "supplied": "100000000",
      "borrowed": "50000000",
      "riskLevel": "moderate",
      "alert": false
    }
  ],
  "atRiskCount": 0,
  "criticalCount": 0,
  "fetchedAt": "2026-03-28T14:00:00.000Z"
}
```

### get-market-info

Fetch market-wide metrics for a Zest asset.

```
bun run zest-liquidation-monitor/zest-liquidation-monitor.ts get-market-info --asset <symbol>
```

Options:
- `--asset` (required) — Asset symbol

Output:
```json
{
  "network": "mainnet",
  "asset": "sBTC",
  "totalSupply": "5000000000",
  "totalBorrow": "2000000000",
  "supplyRate": "0.042",
  "borrowRate": "0.089",
  "utilizationRate": "0.40",
  "liquidationThreshold": 0.75,
  "fetchedAt": "2026-03-28T14:00:00.000Z"
}
```

### liquidation-price

Calculate the collateral price at which a borrow position would be liquidated.

```
bun run zest-liquidation-monitor/zest-liquidation-monitor.ts liquidation-price --address <stacksAddress> --asset <symbol> --collateral-price <number>
```

Options:
- `--address` (required) — Stacks address
- `--asset` (required) — Asset symbol
- `--collateral-price` (required) — Current collateral price in USD

Output:
```json
{
  "network": "mainnet",
  "address": "SP2...",
  "asset": "sBTC",
  "currentPrice": 95000,
  "liquidationPrice": 66500,
  "priceDropToLiquidation": 28500,
  "dropPct": 30.0,
  "safetyMargin": "30.0%",
  "fetchedAt": "2026-03-28T14:00:00.000Z"
}
```

## Risk Levels

| Health Factor | Risk Level | Action |
|--------------|------------|--------|
| > 2.0 | `safe` | No action needed |
| 1.5 – 2.0 | `moderate` | Monitor |
| 1.1 – 1.5 | `warning` | Consider reducing borrow or adding collateral |
| 1.0 – 1.1 | `critical` | Immediate action required |
| < 1.0 | `liquidatable` | Position can be liquidated now |

## Notes

- Health Factor = (supplied × liquidationThreshold) / borrowed. A position with HF < 1.0 is liquidatable.
- Liquidation threshold is 75% for sBTC and varies by asset.
- For borrow/repay operations, use the `defi` skill.
- Mainnet only. Zest Protocol is not deployed on testnet.
