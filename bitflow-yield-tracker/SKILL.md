---
name: bitflow-yield-tracker
description: "Track real-time yield metrics for Bitflow HODLMM liquidity pools — APR estimates, fee accumulation, volume, bin spread, and cross-pool yield comparison to identify the best liquidity deployment targets on Stacks."
metadata:
  author: "ilovewindows10"
  author-agent: "Yuechu"
  user-invocable: "false"
  arguments: "get-pool-yields | get-pool-detail | compare-pools | get-fee-estimate"
  entry: "bitflow-yield-tracker/bitflow-yield-tracker.ts"
  requires: "none"
  tags: "l2, defi, read-only, mainnet-only"
---

# Bitflow Yield Tracker Skill

Monitors and compares real-time yield metrics across Bitflow HODLMM liquidity pools to help agents make optimal liquidity deployment decisions.

- **Pool Yield Overview** — Fetch estimated APR, 24h fee revenue, volume, and active bin spread for all HODLMM pools.
- **Pool Detail** — Deep-dive into a single pool: bin distribution, price range, fee tier, and historical fee accumulation.
- **Cross-Pool Comparison** — Rank pools by estimated yield, volume, or fee efficiency to surface the best opportunity.
- **Fee Estimate** — Estimate fees earned for a given liquidity amount over a time period in a specific pool.

All operations are **mainnet-only** and **read-only** — no wallet signing required.

## Usage

```
bun run bitflow-yield-tracker/bitflow-yield-tracker.ts <subcommand> [options]
```

## Subcommands

### get-pool-yields

Fetch estimated APR and yield metrics for all active HODLMM pools.

```
bun run bitflow-yield-tracker/bitflow-yield-tracker.ts get-pool-yields [--min-apr <number>] [--sort-by <apr|volume|fees>]
```

Options:
- `--min-apr` (optional) — Filter pools below this APR threshold (e.g. `5` for 5%)
- `--sort-by` (optional) — Sort results by `apr` (default), `volume`, or `fees`

Output:
```json
{
  "network": "mainnet",
  "pools": [
    {
      "poolId": "SP2...",
      "tokenX": "sBTC",
      "tokenY": "USDCx",
      "feeTier": 0.003,
      "estimatedApr": 18.4,
      "volume24h": "450000000",
      "fees24h": "1350000",
      "activeBinSpread": 12,
      "totalLiquidity": "98000000000"
    }
  ],
  "fetchedAt": "2026-03-28T14:00:00.000Z"
}
```

### get-pool-detail

Get detailed metrics for a specific HODLMM pool.

```
bun run bitflow-yield-tracker/bitflow-yield-tracker.ts get-pool-detail --pool-id <contractId>
```

Options:
- `--pool-id` (required) — Pool contract identifier (e.g. `SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.bitflow-hodlmm-sbtc-usdcx`)

Output:
```json
{
  "network": "mainnet",
  "poolId": "SP2...",
  "tokenX": "sBTC",
  "tokenY": "USDCx",
  "feeTier": 0.003,
  "activeBin": 8388608,
  "binStep": 100,
  "estimatedApr": 18.4,
  "volume24h": "450000000",
  "fees24h": "1350000",
  "priceRange": { "low": 94000, "high": 98000 },
  "totalLiquidity": "98000000000",
  "bins": []
}
```

### compare-pools

Rank and compare all HODLMM pools side by side.

```
bun run bitflow-yield-tracker/bitflow-yield-tracker.ts compare-pools [--top <number>]
```

Options:
- `--top` (optional) — Number of top pools to return (default: 5)

Output:
```json
{
  "network": "mainnet",
  "ranking": [
    { "rank": 1, "poolId": "SP2...", "pair": "sBTC/USDCx", "estimatedApr": 18.4, "recommendation": "highest yield" },
    { "rank": 2, "poolId": "SP2...", "pair": "STX/sBTC", "estimatedApr": 12.1, "recommendation": "high volume" }
  ]
}
```

### get-fee-estimate

Estimate fees earned for a given liquidity position over a time period.

```
bun run bitflow-yield-tracker/bitflow-yield-tracker.ts get-fee-estimate --pool-id <contractId> --amount-usd <number> --days <number>
```

Options:
- `--pool-id` (required) — Pool contract identifier
- `--amount-usd` (required) — Liquidity amount in USD equivalent
- `--days` (required) — Projection period in days

Output:
```json
{
  "network": "mainnet",
  "poolId": "SP2...",
  "pair": "sBTC/USDCx",
  "inputAmountUsd": 1000,
  "projectionDays": 30,
  "estimatedFeesUsd": 15.3,
  "estimatedApr": 18.4,
  "assumptions": "Based on 24h volume. Actual yield depends on price range, bin concentration, and market conditions."
}
```

## Notes

- All operations are **read-only** — no wallet or transaction signing required.
- APR estimates are based on trailing 24h fee revenue annualized: `(fees24h * 365 / totalLiquidity) * 100`.
- HODLMM pools use concentrated liquidity bins — yield is only earned when price is within the active bin range.
- For write operations (add/remove liquidity), use the `bitflow` skill.
- Mainnet only. Testnet HODLMM pools may not exist or have no liquidity.
