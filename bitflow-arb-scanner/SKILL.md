---
name: bitflow-arb-scanner
description: "Bitflow Arbitrage Scanner — detects price discrepancies between SDK routes and HODLMM quotes on Bitflow DEX, surfaces profitable arbitrage opportunities with spread analysis, fee-adjusted P&L estimation, and multi-pair scanning. All operations are read-only and mainnet-only. No API key required."
metadata:
  author: "vanhuy"
  author-agent: "Arb Hunter"
  user-invocable: "false"
  arguments: "scan | scan-pair | scan-pools | watchlist"
  entry: "bitflow-arb-scanner/bitflow-arb-scanner.ts"
  requires: "wallet"
  tags: "l2, defi, read-only, mainnet-only"
---

# Bitflow Arbitrage Scanner

Detects price discrepancies between SDK (XYK AMM) routes and HODLMM (DLMM concentrated liquidity) quotes on Bitflow DEX. Surfaces arbitrage opportunities where the same token pair has different effective prices across routing sources.

- **Spread Detection** — Compares SDK vs HODLMM output amounts for the same trade to find pricing gaps.
- **Fee-Adjusted P&L** — Estimates net profit after on-chain fees and price impact.
- **Multi-Pair Scanning** — Scans all available trading pairs or a filtered subset.
- **Watchlist Mode** — Monitors specific pairs and returns only actionable opportunities above a threshold.

All operations are **read-only** and **mainnet-only**. No wallet required for scanning. No API key required — uses public endpoints at 500 req/min.

## Usage

```
bun run bitflow-arb-scanner/bitflow-arb-scanner.ts <subcommand> [options]
```

## Subcommands

### scan

Scan all available trading pairs for arbitrage opportunities between SDK and HODLMM routes. Returns pairs sorted by spread percentage.

```
bun run bitflow-arb-scanner/bitflow-arb-scanner.ts scan [--min-spread <percent>] [--amount <decimal>] [--top <number>]
```

Options:
- `--min-spread` (optional) — Minimum spread percentage to report (default 0.1 = 0.1%)
- `--amount` (optional) — Trade size in input token units for quote comparison (default 10.0)
- `--top` (optional) — Return only the top N opportunities (default 10)

Output:
```json
{
  "network": "mainnet",
  "scanTime": "2026-04-09T12:00:00Z",
  "tradeAmount": "10.0",
  "minSpreadPct": 0.1,
  "opportunityCount": 5,
  "opportunities": [
    {
      "pair": "STX/sBTC",
      "tokenX": "token-stx",
      "tokenY": "token-sbtc",
      "amountIn": "10.0",
      "sdkAmountOut": "0.0000350",
      "hodlmmAmountOut": "0.0000362",
      "spreadPct": "3.43",
      "bestSource": "hodlmm",
      "estimatedFeeBps": 30,
      "netSpreadPct": "3.13",
      "sdkRoute": "BITFLOW_XYK_XY_2",
      "hodlmmPool": "dlmm_3",
      "priceImpact": { "sdk": "0.12%", "hodlmm": "0.08%" }
    }
  ]
}
```

### scan-pair

Scan a specific token pair for arbitrage between all available routes.

```
bun run bitflow-arb-scanner/bitflow-arb-scanner.ts scan-pair --token-x <tokenId> --token-y <tokenId> --amount-in <decimal>
```

Options:
- `--token-x` (required) — Input token ID (e.g. `token-stx`)
- `--token-y` (required) — Output token ID (e.g. `token-sbtc`)
- `--amount-in` (required) — Amount of input token in human-readable decimal

Output:
```json
{
  "network": "mainnet",
  "pair": "STX/sBTC",
  "tokenX": "token-stx",
  "tokenY": "token-sbtc",
  "amountIn": "10.0",
  "routes": [
    {
      "source": "sdk",
      "label": "BITFLOW_XYK_XY_2",
      "amountOut": "0.0000350",
      "executable": true,
      "priceImpactPct": "0.12%",
      "feeBps": 30
    },
    {
      "source": "hodlmm",
      "label": "DLMM dlmm_3",
      "amountOut": "0.0000362",
      "executable": true,
      "priceImpactPct": "0.08%",
      "feeBps": 25
    }
  ],
  "bestRoute": { "source": "hodlmm", "amountOut": "0.0000362" },
  "worstRoute": { "source": "sdk", "amountOut": "0.0000350" },
  "spreadPct": "3.43",
  "netSpreadPct": "3.13"
}
```

### scan-pools

Scan HODLMM pools for internal bin pricing inefficiencies — compares the effective price at different bin ranges to detect intra-pool arbitrage.

```
bun run bitflow-arb-scanner/bitflow-arb-scanner.ts scan-pools [--suggested] [--min-spread <percent>]
```

Options:
- `--suggested` (optional) — Only scan suggested/featured pools
- `--min-spread` (optional) — Minimum spread percentage to report (default 0.5)

Output:
```json
{
  "network": "mainnet",
  "poolCount": 12,
  "opportunities": [
    {
      "poolId": "dlmm_3",
      "tokenX": "STX",
      "tokenY": "sBTC",
      "activeBin": 447,
      "binStep": 10,
      "spreadPct": "1.2",
      "description": "Active bin price deviates from nearby bin weighted average"
    }
  ]
}
```

### watchlist

Monitor specific pairs continuously and return only pairs with spreads above threshold. Useful for autonomous agents polling for opportunities.

```
bun run bitflow-arb-scanner/bitflow-arb-scanner.ts watchlist --pairs '<json>' --amount <decimal> [--min-spread <percent>]
```

Options:
- `--pairs` (required) — JSON array of `[tokenX, tokenY]` pairs to monitor
- `--amount` (optional) — Trade size for quotes (default 10.0)
- `--min-spread` (optional) — Minimum spread to report (default 0.5)

Output:
```json
{
  "network": "mainnet",
  "scannedAt": "2026-04-09T12:00:00Z",
  "pairsScanned": 3,
  "alertCount": 1,
  "alerts": [
    {
      "pair": "STX/sBTC",
      "spreadPct": "2.15",
      "bestSource": "hodlmm",
      "amountIn": "10.0",
      "sdkOut": "0.0000350",
      "hodlmmOut": "0.0000358"
    }
  ]
}
```

## Notes

- All operations are **read-only** — no swaps are executed.
- Mainnet-only — Bitflow and HODLMM are not available on testnet.
- Spreads may not be directly actionable if one route is not executable (check `executable` field).
- Price impact varies with trade size — scan at your intended trade size for accurate results.
- Fee estimates are approximate; actual on-chain gas depends on network conditions.
