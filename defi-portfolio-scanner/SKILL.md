---
name: defi-portfolio-scanner
description: "Cross-protocol DeFi position aggregator for Stacks wallets — 5 parallel scanners covering Bitflow HODLMM LP bins, Zest lending/borrowing (V2 pool-borrow-v2-3), ALEX pool shares, Styx bridge deposits, and Hiro wallet balances. Produces a unified portfolio view with USD estimation (CoinGecko) and risk scoring."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "doctor | scan --address <stx-address> | summary --address <stx-address>"
  entry: "defi-portfolio-scanner/defi-portfolio-scanner.ts"
  requires: ""
  tags: "defi, read-only, mainnet-only, l2"
---

# defi-portfolio-scanner

Cross-protocol DeFi position aggregator for Stacks wallets. Scans four major Stacks DeFi protocols and produces a unified portfolio view with aggregate totals and risk scoring.

## What it does

`defi-portfolio-scanner` queries four Stacks DeFi protocols in parallel and returns a single, normalized JSON report for any given STX address:

| Protocol | What is scanned |
|---|---|
| **Bitflow HODLMM** | LP positions across all active HODLMM pools — token pair, share amount, estimated USD value |
| **Zest Protocol** | Lending deposits (collateral supplied) and active borrows — asset, principal, LTV ratio |
| **ALEX DEX** | Pool token balances representing LP shares in ALEX liquidity pools |
| **Styx Bridge** | Pending and completed bridge deposits between Bitcoin L1 and Stacks |

The skill also queries the Hiro API for baseline token balances so the portfolio view includes idle wallet holdings alongside active DeFi positions.

## Why agents need it

Autonomous agents managing DeFi strategies need a consolidated view of where capital is deployed before they can make allocation decisions. Without this skill, an agent would need to query each protocol separately, normalize different response schemas, and manually compute concentration metrics. This skill does all of that in a single call and returns a typed, predictable JSON contract that downstream skills can consume directly.

Common agent workflows:
- **Pre-trade check**: Before entering a new HODLMM position, scan existing exposure to avoid over-concentration.
- **Risk monitoring**: Periodic scans detect when Zest LTV ratios approach liquidation thresholds.
- **Rebalancing triggers**: Summary risk scores can feed into rebalancing logic when concentration exceeds target bounds.
- **Reporting**: Generate human-readable portfolio snapshots for dashboards or Discord alerts.

## Safety notes

- **Read-only** — This skill makes zero on-chain transactions. Every call is either an HTTP GET or a Clarity `call-read` via Hiro API.
- **No private keys** — The skill never requests, accepts, or stores private keys or seed phrases.
- **No wallet mutation** — Token balances and positions are observed, never modified.
- **Rate-limit aware** — Requests include timeouts and the skill gracefully degrades if any single protocol API is unavailable, returning partial results with clear error flags.
- **Mainnet only** — All endpoints target Stacks mainnet. Testnet addresses will return empty results without error.

## Commands

### `doctor`

Health check across all upstream dependencies. Returns per-endpoint latency and reachability status.

```bash
bun run defi-portfolio-scanner.ts doctor
```

**Output**: JSON object with `status: "ok" | "degraded" | "down"` per endpoint plus overall system status.

### `scan --address <stx-address>`

Full position scan across all four protocols plus Hiro token balances.

```bash
bun run defi-portfolio-scanner.ts scan --address SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KR9
```

**Output**: JSON object containing:
- `wallet` — base token balances (STX, sBTC, stablecoins)
- `protocols.bitflow` — array of HODLMM LP positions
- `protocols.zest` — lending/borrowing positions with LTV
- `protocols.alex` — pool token balances and estimated underlying
- `protocols.styx` — bridge deposit records
- `totals` — aggregate estimated USD value across all protocols
- `scannedAt` — ISO-8601 timestamp

### `summary --address <stx-address>`

Condensed portfolio overview with computed risk score.

```bash
bun run defi-portfolio-scanner.ts summary --address SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KR9
```

**Output**: JSON object containing:
- `address` — the scanned address
- `totalEstimatedUsd` — aggregate portfolio value
- `protocolBreakdown` — per-protocol USD allocation and percentage
- `riskScore` — numeric score 0-100 (higher = riskier)
- `riskFactors` — array of human-readable risk observations
- `topHoldings` — top 5 positions by value
- `scannedAt` — ISO-8601 timestamp

## Output contract

Every command returns JSON matching this envelope:

```json
{
  "success": true,
  "skill": "defi-portfolio-scanner",
  "command": "<command-name>",
  "data": { ... },
  "timestamp": "2026-03-31T12:00:00.000Z"
}
```

On error:

```json
{
  "success": false,
  "skill": "defi-portfolio-scanner",
  "command": "<command-name>",
  "error": "Human-readable error message",
  "details": { ... },
  "timestamp": "2026-03-31T12:00:00.000Z"
}
```

## Data sources

| Source | Endpoint | Purpose |
|---|---|---|
| Bitflow API | `https://bff.bitflowapis.finance/api/app/v1/pools` | HODLMM pool list and position data |
| Zest Protocol | Hiro `call-read` on `SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3` | Lending/borrowing user data via `get-user-reserve-data` |
| ALEX DEX | `https://api.alexlab.co/v1/pool_tokens/balances/<address>` | Pool token balances |
| Styx Bridge | `https://app.styxfinance.com/api` | Bridge deposit records |
| Hiro API | `https://api.hiro.so/extended/v1/address/<addr>/balances` | Token balances, contract reads |

## Cross-protocol DeFi portfolio scanners

This skill aggregates positions from the following protocol-specific scanners:

| # | Protocol | Scanner | What it detects |
|---|---|---|---|
| 1 | **Bitflow HODLMM** | `scanBitflow()` | LP bin positions across all active HODLMM pools via `/users/{addr}/positions/{pool}/bins`, with Hiro fallback for LP receipt tokens |
| 2 | **Zest Protocol** | `scanZest()` | Supply collateral and borrow balances via Hiro `call-read` on `pool-borrow-v2-3.get-user-reserve-data`, plus Zest receipt token detection from Hiro balances |
| 3 | **ALEX DEX** | `scanAlex()` | Pool token balances from ALEX `/pool_tokens/balances` API, with Hiro fallback for ALEX LP tokens in wallet |
| 4 | **Styx Bridge** | `scanStyx()` | Pending and completed BTC→sBTC bridge deposits from Styx `/deposits` API |
| 5 | **Wallet base** | `scanWalletBalances()` | STX, sBTC, and all fungible token balances from Hiro API — provides the idle-capital baseline |

All five scanners run in parallel via `Promise.all`. Each returns a typed `ProtocolResult<T>` with `status`, `positions`, and `estimatedUsd`. USD estimation uses CoinGecko STX and BTC spot prices.

## Known constraints

1. **USD estimates are approximate.** The skill uses pool ratios and last-known prices from protocol APIs. It does not query a dedicated price oracle. Values may drift from true market price during high volatility.
2. **Zest user-data requires active position.** Addresses that have never interacted with Zest will return an empty Zest section, not an error.
3. **ALEX pool token mapping is best-effort.** ALEX pool tokens are mapped to underlying pairs using the ALEX public API. Newly launched pools may not be mapped until the ALEX API updates.
4. **Styx API availability.** The Styx bridge API has historically been less stable than the other three. The skill sets a shorter timeout and flags Styx as `"status": "unavailable"` rather than failing the entire scan.
5. **Rate limits.** Heavy polling (more than ~10 scans per minute) may trigger Hiro API rate limits. Agents should cache results and respect a minimum 30-second interval between scans of the same address.
6. **No historical data.** Each scan is a point-in-time snapshot. The skill does not store or compare previous scans. Agents that need trend data should persist results externally.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @azagh72-creator
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/121
