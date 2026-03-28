---
name: hermetica-monitor
description: "Monitor Hermetica Protocol on Stacks — track USDh stablecoin peg health, oracle price, reserve backing ratio, APY from Zest integration, and alert on depeg or undercollateralization risk. Read-only. Mainnet-only."
metadata:
  author: "ilovewindows10"
  author-agent: "Yuechu"
  user-invocable: "false"
  arguments: "get-peg-status | get-oracle-price | get-reserve-health | get-apy | full-report"
  entry: "hermetica-monitor/hermetica-monitor.ts"
  requires: "none"
  tags: "l2, defi, read-only, mainnet-only"
---

# Hermetica Monitor Skill

Monitors the health of [Hermetica Protocol](https://app.hermetica.fi) — the Bitcoin-backed synthetic USD yield protocol on Stacks. Tracks USDh peg integrity, oracle price feeds, reserve collateralization, and yield rates to help agents detect risk before it compounds.

- **Peg Status** — Check USDh price from on-chain oracle and calculate deviation from $1.00 peg.
- **Oracle Price** — Read the raw oracle price from the USDh price feed contract.
- **Reserve Health** — Query USDh total supply and sBTC/STX reserve backing via Hiro API.
- **APY Estimate** — Fetch current yield rate from Zest Protocol's USDh lending market.
- **Full Report** — Aggregate all metrics into a single health summary with risk flags.

All operations are **read-only** and require **no wallet**.

## Usage

```
bun run hermetica-monitor/hermetica-monitor.ts <subcommand> [options]
```

## Subcommands

### get-peg-status

Check USDh peg deviation from $1.00 using the on-chain oracle.

```
bun run hermetica-monitor/hermetica-monitor.ts get-peg-status [--threshold <percent>]
```

Options:
- `--threshold` (optional) — Alert if deviation exceeds this % (default: 1.0)

Output:
```json
{
  "network": "mainnet",
  "symbol": "USDH",
  "oraclePrice": 0.9997,
  "targetPrice": 1.0,
  "deviationPct": 0.03,
  "status": "healthy",
  "alert": false,
  "fetchedAt": "2026-03-28T14:00:00.000Z"
}
```

### get-oracle-price

Read raw USDh oracle price from the on-chain price feed.

```
bun run hermetica-monitor/hermetica-monitor.ts get-oracle-price
```

Output:
```json
{
  "network": "mainnet",
  "contract": "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.usdh-oracle-v1-0",
  "rawPrice": "99970000",
  "price": 0.9997,
  "decimals": 8,
  "fetchedAt": "2026-03-28T14:00:00.000Z"
}
```

### get-reserve-health

Query USDh total supply and estimated reserve backing ratio.

```
bun run hermetica-monitor/hermetica-monitor.ts get-reserve-health
```

Output:
```json
{
  "network": "mainnet",
  "usdhTotalSupply": "5000000000000",
  "usdhTotalSupplyFormatted": 50000.0,
  "reserveAssets": [
    { "symbol": "sBTC", "balance": "100000000", "balanceFormatted": 1.0 }
  ],
  "collateralizationNote": "On-chain reserve data only. Full backing includes off-chain BTC positions — see app.hermetica.fi/transparency for full reserves.",
  "fetchedAt": "2026-03-28T14:00:00.000Z"
}
```

### get-apy

Fetch current USDh yield rate from Zest Protocol lending market.

```
bun run hermetica-monitor/hermetica-monitor.ts get-apy
```

Output:
```json
{
  "network": "mainnet",
  "source": "zest-protocol",
  "asset": "USDH",
  "supplyApy": 8.4,
  "borrowApy": 12.1,
  "utilization": 0.69,
  "fetchedAt": "2026-03-28T14:00:00.000Z"
}
```

### full-report

Aggregate all Hermetica health metrics into a single report with risk assessment.

```
bun run hermetica-monitor/hermetica-monitor.ts full-report [--depeg-threshold <percent>]
```

Options:
- `--depeg-threshold` (optional) — Depeg alert threshold % (default: 1.0)

Output:
```json
{
  "network": "mainnet",
  "protocol": "Hermetica",
  "oraclePrice": 0.9997,
  "deviationPct": 0.03,
  "pegStatus": "healthy",
  "supplyApy": 8.4,
  "usdhTotalSupply": "5000000000000",
  "riskFlags": [],
  "overallHealth": "green",
  "recommendation": "USDh is healthy. Yield at 8.4% APY via Zest.",
  "fetchedAt": "2026-03-28T14:00:00.000Z"
}
```

## Risk Flags

| Flag | Trigger |
|------|---------|
| `depeg-warning` | Oracle price deviation > 1% |
| `depeg-critical` | Oracle price deviation > 3% |
| `low-supply` | Total supply < 10,000 USDH (low adoption) |
| `oracle-stale` | Oracle read fails or returns zero |

## Notes

- USDh is Hermetica's Bitcoin-backed synthetic USD. It earns yield via delta-neutral BTC strategies and Zest lending.
- Oracle contract: `SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.usdh-oracle-v1-0`
- Token contract: `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1`
- Mainnet only. No testnet deployment exists.
- For write operations (supply/borrow USDh on Zest), use the `defi` skill.
