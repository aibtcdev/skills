---
name: hodlmm-yield-compare
description: "Capital allocation intelligence for Stacks DeFi agents. Fetches real APR, volume, fees, and TVL from Bitflow HODLMM pools and compares them against Zest Protocol lending and STX stacking. Ranks all yield sources by raw APR and risk-adjusted return so agents can decide where to deploy capital. Read-only; no wallet required."
metadata:
  author: "lekanbams"
  author-agent: "Yield Oracle"
  user-invocable: "false"
  arguments: "doctor | compare | rank | hodlmm-detail"
  entry: "hodlmm-yield-compare/hodlmm-yield-compare.ts"
  requires: ""
  tags: "l2, defi, read-only, mainnet-only"
---

# HODLMM Yield Compare Skill

## Use case

An agent holding sBTC or STX faces a fundamental question before deploying capital: **"Should I LP in a HODLMM pool, lend on Zest, or stack STX?"** Today, answering that requires manually checking Bitflow pool stats, reading Zest contract state, and mentally comparing risk-adjusted returns across different protocols with different risk profiles.

This skill automates that decision. It pulls real APR, volume, fees, and TVL from every active Bitflow HODLMM pool, reads Zest lending rates live from on-chain contract state, and produces a ranked comparison with risk-adjusted scores. The output is a single actionable verdict that downstream execution skills can act on.

**Existing skills don't cover this.** `hodlmm-risk` monitors pool volatility but has no yield data. `yield-dashboard` shows APY across protocols but excludes HODLMM pools entirely. `hodlmm-pulse` tracks fee velocity trends but doesn't compare against alternatives. This skill fills the gap between risk analysis and execution by answering the allocation question with real numbers.

## What it does

- Fetches **real APR, 24h volume, 7d volume, daily fees, TVL, and pool composition** for all active HODLMM pools via Bitflow's app/v1 API
- Reads **Zest Protocol sBTC lending rate** live from on-chain contract state (`get-reserve-state`)
- Computes **dynamic risk scores** per HODLMM pool based on TVL depth, composition imbalance, and pair type (stablecoin pairs get lower risk)
- Ranks all sources by both raw APR and **risk-adjusted return** (APR / risk score)
- Provides a **head-to-head verdict** for any specific HODLMM pool against the best alternative

## Safety notes

- Read-only. Never writes to chain or moves funds.
- Mainnet only. Bitflow HODLMM and Zest APIs are mainnet-only.
- No wallet or funds required.
- APR data for HODLMM pools comes directly from Bitflow's API (not modeled).
- Zest lending rate is read live from on-chain `get-reserve-state`.
- STX stacking uses a static 8% estimate (actual varies per PoX cycle).

## Commands

### doctor

Health check: verify API connectivity for all data sources.

```
bun run hodlmm-yield-compare/hodlmm-yield-compare.ts doctor
```

Output:
```json
{
  "network": "mainnet",
  "version": "0.1.0",
  "bitflowQuotesApi": { "status": "ok", "poolCount": 8 },
  "bitflowAppApi": { "status": "ok", "hasApr": true, "hasVolume": true, "hasFees": true },
  "hiroApi": { "status": "ok", "httpStatus": 200 },
  "zestContract": { "status": "ok" },
  "healthy": true,
  "timestamp": "2026-04-04T10:00:00.000Z"
}
```

### compare

Full comparison: all HODLMM pools vs alternative yields, ranked by risk-adjusted return.

```
bun run hodlmm-yield-compare/hodlmm-yield-compare.ts compare
```

Returns `hodlmmPools[]`, `alternatives[]`, `ranked[]` (sorted by risk-adjusted score), `bestOverall`, `bestRiskAdjusted`, and a `summary` string.

### rank

Compact ranked table for quick decisions.

```
bun run hodlmm-yield-compare/hodlmm-yield-compare.ts rank --top 5
```

Options:
- `--top <n>` (optional) -- Number of results to show (default: 10)

Output:
```json
{
  "network": "mainnet",
  "topN": 5,
  "ranked": [
    {
      "rank": 1,
      "source": "hodlmm-dlmm_2",
      "protocol": "Bitflow HODLMM",
      "asset": "sBTC/USDCx",
      "aprPct": 40.1,
      "riskScore": 50,
      "riskLabel": "medium",
      "riskAdjustedScore": 0.802,
      "tvlUsd": 82.29
    }
  ],
  "summary": "...",
  "timestamp": "2026-04-04T10:00:00.000Z"
}
```

### hodlmm-detail

Deep-dive on a specific HODLMM pool with head-to-head verdict.

```
bun run hodlmm-yield-compare/hodlmm-yield-compare.ts hodlmm-detail --pool-id dlmm_1
```

Options:
- `--pool-id` (required) -- HODLMM pool identifier (e.g. `dlmm_1`, `dlmm_6`)

Output includes real APR, 24h APR, TVL (USD + BTC), daily/weekly volume and fees, bin step, base fee, composition percentages, risk score, and a verdict comparing against the best alternative.

## Data sources

| Source | Method | What it provides |
|--------|--------|-----------------|
| Bitflow app/v1 API | `GET /api/app/v1/pools/{id}` | Real APR, 24h APR, TVL, volume (1d/7d/30d), fees (1d/7d/30d), pool composition, bin step, base fee |
| Bitflow quotes/v1 API | `GET /api/quotes/v1/pools` | Pool listing with IDs and active status |
| Hiro Stacks API | `POST /v2/contracts/call-read/...` | Zest Protocol lending rate from on-chain contract state |
| Static estimate | -- | STX stacking APR (~8%, varies per PoX cycle) |

## Risk scoring methodology

**Dynamic per-pool risk scoring** (not a flat number):

- **Base risk: 35** (concentrated LP inherent impermanent loss)
- **TVL < $1,000: +10** (thin liquidity, high slippage risk)
- **TVL < $10,000: +5** (moderate liquidity risk)
- **Composition imbalance > 30%: +10** (single-sided exposure)
- **Composition imbalance > 15%: +5** (moderate imbalance)
- **Stablecoin pair: -10** (minimal IL for stable-stable)

**Alternatives:**
- Zest Protocol: risk 20 (lending, protocol-audited, no IL)
- STX Stacking: risk 10 (protocol-level security, PoX consensus)

**Risk-adjusted score** = APR / max(riskScore, 5). Higher is better.

## Known constraints

- Mainnet only. Bitflow HODLMM APIs do not exist on testnet.
- No wallet required. All operations are read-only.
- HODLMM APR comes from Bitflow's API. The `apr` field is a rolling average; `apr24h` reflects the last 24 hours only.
- Zest lending rate is read from `get-reserve-state` using `current-liquidity-rate`. Low utilization = low rate.
- STX stacking APR is a static 8% estimate; actual rewards vary per cycle.
- Pools with 0% APR and zero volume are included but rank at the bottom.
- Risk scores are bounded [10, 80]. The floor prevents near-zero division; the ceiling prevents extreme penalty.

## Origin

Submitted to AIBTC x Bitflow Skills Pay the Bills competition.
Author: @lekanbams
