---
name: hodlmm-flow
description: "Swap flow intelligence for Bitflow HODLMM — analyzes on-chain swap transactions to compute direction bias, flow toxicity, bin velocity, whale concentration, and bot/organic classification for LP decision-making."
metadata:
  author: "ClankOS"
  author-agent: "Grim Seraph"
  user-invocable: "false"
  arguments: "doctor | install-packs | flow --pool-id <id> | flow --all"
  entry: "hodlmm-flow/hodlmm-flow.ts"
  requires: ""
  tags: "l2, defi, read-only, mainnet-only"
---

# HODLMM Flow

Swap flow intelligence for Bitflow HODLMM concentrated liquidity pools.

## What it does

Every other HODLMM tool looks at pool *state* — TVL, bin distribution, positions. This one looks at swap *flow*: what's actually trading, in what direction, by whom, and what it means for LPs.

Fetches on-chain swap transactions from Hiro API, parses DLMM core contract events to extract per-bin-hop volumes, and computes six market microstructure metrics: direction bias, flow toxicity, bin velocity, whale concentration, liquidation pressure, and bot/organic classification. Produces an LP safety verdict with a predicted range lifespan.

## Why agents need it

Concentrated liquidity LPs face adverse selection — informed traders extract value from stale positions. Without flow analysis, an agent choosing range parameters is flying blind. This skill gives agents the data to:

- **Detect toxic flow** — consecutive same-direction swaps signal informed trading that picks off LPs
- **Predict range lifespan** — bin velocity tells you how long a ±N-bin position will stay in range
- **Identify who's trading** — bot vs organic vs liquidator classification reveals market structure
- **Assess directional risk** — strong bias means one side of your position is getting drained
- **Spot liquidation cascades** — Zest liquidation flow through HODLMM pools signals collateral stress

## Safety notes

- **Read-only** — never submits transactions or moves funds
- **No wallet required** — safe to call from any agent without authentication
- **Mainnet-only** — Bitflow HODLMM is mainnet-only
- Uses Hiro transactions + events APIs. A Hiro API key (`--hiro-api-key`) is recommended for analyzing more than 100 swaps to avoid rate limits

## Commands

### doctor
Checks connectivity to Hiro API (transactions, events) and Bitflow APIs (quotes, app). Verifies the full data pipeline is accessible.

```bash
bun run hodlmm-flow/hodlmm-flow.ts doctor
```

### install-packs
No-op subcommand for registry compatibility. This skill has no additional packs to install.

```bash
bun run hodlmm-flow/hodlmm-flow.ts install-packs
```

### flow --pool-id
Analyze swap flow for a single pool. Default: last 100 swaps.

```bash
bun run hodlmm-flow/hodlmm-flow.ts flow --pool-id dlmm_3
```

### flow --pool-id --window
Time-windowed analysis. Analyzes swaps within the specified duration.

```bash
bun run hodlmm-flow/hodlmm-flow.ts flow --pool-id dlmm_3 --window 24h
```

### flow --all
Protocol-wide flow summary across all 8 HODLMM pools (dlmm_1 through dlmm_8).

```bash
bun run hodlmm-flow/hodlmm-flow.ts flow --all
```

Options:
- `--pool-id <id>` — Pool to analyze (dlmm_1 through dlmm_8)
- `--window <duration>` — Time window (e.g. 24h, 7d, 30m)
- `--swaps <count>` — Number of swaps to analyze (default: 100)
- `--all` — Analyze all 8 HODLMM pools
- `--hiro-api-key <key>` — Hiro API key for elevated rate limits

## Output contract

All outputs are JSON to stdout.

**Success (single pool):**
```json
{
  "status": "success",
  "network": "mainnet",
  "timestamp": "2026-04-09T20:00:00.000Z",
  "poolId": "dlmm_3",
  "pair": "STX/USDCx",
  "swapsAnalyzed": 100,
  "timeSpanHours": 4.2,
  "metrics": {
    "directionBias": -0.31,
    "directionBiasLabel": "Moderate sell-X pressure",
    "flowToxicity": 0.62,
    "flowToxicityLabel": "Elevated — directional momentum present",
    "binVelocity": 12.5,
    "binVelocityLabel": "Moderate — normal volatility",
    "whaleConcentration": 0.45,
    "whaleConcentrationLabel": "Concentrated — few actors drive most volume",
    "liquidationPressure": 0.02,
    "liquidationPressureLabel": "Low — 1 liquidation(s), minimal impact",
    "botFlowRatio": 0.72,
    "botFlowRatioLabel": "Bot-heavy — majority of flow is automated"
  },
  "verdict": {
    "lpSafety": "caution",
    "score": 52,
    "reasoning": "Strong directional pressure (selling X). Concentrated flow — few actors dominating volume.",
    "recommendation": "Monitor flow direction. Consider asymmetric range if bias persists.",
    "rangeLifespanHours": 0.8
  },
  "topActors": [
    { "address": "SP2V3J7G...", "swapCount": 45, "volumeShare": 82.1, "label": "bot" }
  ]
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Metrics reference

| Metric | Range | What it measures |
|---|---|---|
| Direction bias | [-1, +1] | Net buying vs selling pressure. -1 = all selling X, +1 = all buying X |
| Flow toxicity | [0, 1] | Consecutive same-direction ratio. >0.6 = informed flow adversely selecting LPs |
| Bin velocity | bins/hour | Active bin change rate. Predicts how fast positions go out of range |
| Whale concentration | [0, 1] | Herfindahl index on swap volume. >0.25 = concentrated, >0.5 = monopolistic |
| Liquidation pressure | [0, 1] | Volume fraction from Zest `liquidate-with-swap` transactions |
| Bot flow ratio | [0, 1] | Volume fraction from automated addresses (>10 swaps/hour or >30% of flow) |

## Data source

Swap data is sourced from Hiro API (`/extended/v1/address/{pool}/transactions` + `/extended/v1/tx/events`). Each swap transaction's DLMM core contract logs are parsed to extract per-bin-hop amounts (dx, dy), active bin IDs, callers, and swap direction.

Bitflow does not currently expose swap history via their own API. This skill recommends they add a `/trades` or `/swaps` endpoint — they already have the data server-side. This would eliminate Hiro dependency and enable real-time flow monitoring.

## Known constraints

- Free-tier Hiro supports ~100 swaps per run (~100-150 API calls). Use `--hiro-api-key` for larger analyses
- Only ~25-30% of transactions hitting pool contracts are swaps — the rest are add/withdraw liquidity. The skill pages through until it collects enough swap txs
- Multi-hop swap transactions (crossing multiple bins) produce multiple events per tx — all are aggregated correctly
- `swap-simple-multi` function calls don't indicate direction in the function name — direction is resolved from contract events
- Stale data: Hiro API indexes with a slight delay (~1-2 blocks). Very recent swaps may not appear immediately

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @ClankOS
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/257
