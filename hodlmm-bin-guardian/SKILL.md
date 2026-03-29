---
name: hodlmm-bin-guardian
description: "Monitors Bitflow HODLMM bins to keep LP positions in the active earning range. Fetches live pool state via Bitflow's HODLMM app API, checks if a wallet's position is in-range, computes slippage from Bitflow-native price data, and outputs a JSON recommendation. Read-only — rebalance actions require explicit human approval."
metadata:
  author: cliqueengagements
  author-agent: "Micro Basilisk (Agent 77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "false"
  arguments: "doctor | install-packs | run [--wallet <STX_ADDRESS>] [--pool-id <id>]"
  entry: "hodlmm-bin-guardian/hodlmm-bin-guardian.ts"
  requires: ""
  tags: "defi, read-only, mainnet-only, l2"
---

# HODLMM Bin Guardian

Monitors Bitflow HODLMM (DLMM) bins to keep LP positions in the active earning range.

## What it does

Fetches live Bitflow HODLMM pool state, the user's actual LP position bins (via wallet address), and compares the user's bin range against the active bin to determine if the position is earning fees. Volume, TVL, APR, and token prices are sourced directly from Bitflow's HODLMM app API — no external oracles. Slippage is measured as the deviation between the HODLMM active-bin price and Bitflow's own reported token price. Also checks estimated gas cost and cooldown before recommending REBALANCE.

## Why agents need it

HODLMM positions stop earning fees the moment the market price moves outside the deposited bin range. This skill gives an autonomous agent a reliable, safe-to-run check that surfaces out-of-range positions and flags them for human-approved rebalancing — without ever spending funds autonomously.

## Safety notes

- **Read-only.** No transactions are submitted.
- **Mainnet-only.** Bitflow HODLMM API does not support testnet.
- Refuses to recommend rebalance if 24h pool volume < $10,000 USD.
- Refuses to recommend rebalance if slippage > 0.5% (HODLMM bin price vs Bitflow app price).
- Any actual rebalance (add/withdraw liquidity) requires explicit human approval before execution.
- All price data sourced from Bitflow APIs only — no external oracles.

## Commands

### doctor

Checks all data sources: Bitflow HODLMM API, Bitflow Bins API, Bitflow App Pools API, and Hiro Stacks API.

```bash
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts doctor
```

### install-packs

No additional packs required — uses Bitflow and Hiro public HTTP APIs directly.

```bash
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts install-packs
```

### run

Checks the LP position in the default sBTC HODLMM pool (dlmm_1) and outputs a recommendation.
Pass `--wallet` to enable the real in-range check against actual position bins.

```bash
# Full check with wallet (recommended)
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet SP1234...
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet SP1234... --pool-id dlmm_1

# Pool-only check (no position check — in_range will be null)
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run
```

## Live terminal output

### doctor (all 4 sources reachable)

```json
{
  "status": "ok",
  "checks": [
    { "name": "Bitflow HODLMM API",      "ok": true, "detail": "8 pools found, dlmm_1 active bin: 504" },
    { "name": "Bitflow Bins API (dlmm_1)", "ok": true, "detail": "active_bin_id=504, 1001 bins" },
    { "name": "Bitflow App Pools API",   "ok": true, "detail": "dlmm_1 TVL: $77,142.99, vol_24h: $126,045, APR: 17.72%" },
    { "name": "Hiro Stacks API (fees)",  "ok": true, "detail": "2 µSTX/byte" }
  ],
  "message": "All data sources reachable. Ready to run."
}
```

### run --wallet (wallet has no dlmm_1 position, slippage gate active)

```json
{
  "status": "success",
  "action": "HOLD — position out of range but rebalance blocked: price slippage 1.86% > 0.5% cap.",
  "data": {
    "in_range": false,
    "active_bin": 504,
    "user_bin_range": null,
    "can_rebalance": false,
    "refusal_reasons": [ "price slippage 1.86% > 0.5% cap" ],
    "slippage_ok": false,
    "slippage_pct": 1.8595,
    "bin_price_raw": 66459654464,
    "pool_price_usd": 66459.65,
    "market_price_usd": 65246.37,
    "slippage_source": "bitflow-app-price-vs-hodlmm-active-bin",
    "gas_ok": true,
    "gas_estimated_stx": 0.0144,
    "cooldown_ok": true,
    "cooldown_remaining_h": 0,
    "last_rebalance_at": null,
    "volume_ok": true,
    "volume_24h_usd": 126045,
    "liquidity_usd": 77143,
    "apr_24h_pct": 17.72,
    "pool_id": "dlmm_1",
    "pool_name": "sBTC-USDCx-LP",
    "fee_bps": 30,
    "position_note": "No position found for SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY in pool dlmm_1."
  },
  "error": null
}
```

### run --wallet (active position in range, all gates pass)

```json
{
  "status": "success",
  "action": "HOLD — position in range at active bin 504. APR (24h): 17.72%.",
  "data": {
    "in_range": true,
    "active_bin": 504,
    "user_bin_range": { "min": 500, "max": 508, "count": 3, "bins": [500, 504, 508] },
    "can_rebalance": true,
    "refusal_reasons": null,
    "slippage_ok": true,
    "slippage_pct": 0.04,
    "bin_price_raw": 66459654464,
    "pool_price_usd": 66459.65,
    "market_price_usd": 66433.0,
    "slippage_source": "bitflow-app-price-vs-hodlmm-active-bin",
    "gas_ok": true,
    "gas_estimated_stx": 0.0144,
    "cooldown_ok": true,
    "cooldown_remaining_h": 0,
    "last_rebalance_at": null,
    "volume_ok": true,
    "volume_24h_usd": 126045,
    "liquidity_usd": 77143,
    "apr_24h_pct": 17.72,
    "pool_id": "dlmm_1",
    "pool_name": "sBTC-USDCx-LP",
    "fee_bps": 30
  },
  "error": null
}
```

## Output contract

All outputs are strict JSON to stdout.

| Field | Type | Description |
|---|---|---|
| `status` | `"success" \| "error"` | Overall result |
| `action` | `string` | `HOLD`, `REBALANCE`, or `CHECK` with reason |
| `data.in_range` | `boolean \| null` | `null` if no wallet provided |
| `data.active_bin` | `number` | Pool's current active bin ID |
| `data.user_bin_range` | `{min,max,count,bins} \| null` | User's liquidity bin range |
| `data.can_rebalance` | `boolean` | Whether all safety gates pass |
| `data.refusal_reasons` | `string[] \| null` | Why REBALANCE is blocked |
| `data.slippage_ok` | `boolean` | Whether price deviation is within cap |
| `data.slippage_pct` | `number` | `\|hodlmm_price − bitflow_price\| / bitflow_price × 100` |
| `data.bin_price_raw` | `number` | Raw active bin price from Bitflow bins API |
| `data.pool_price_usd` | `number \| null` | HODLMM derived USD price: `(bin_price_raw / 1e8) × 10^(xDec − yDec)` |
| `data.market_price_usd` | `number \| null` | Bitflow app reported token price in USD |
| `data.slippage_source` | `string` | Price source identifier |
| `data.gas_ok` | `boolean` | Whether estimated gas is within limit |
| `data.gas_estimated_stx` | `number` | Estimated STX for 2-txn rebalance |
| `data.cooldown_ok` | `boolean` | Whether cooldown has elapsed |
| `data.cooldown_remaining_h` | `number` | Hours until next rebalance allowed |
| `data.last_rebalance_at` | `string \| null` | ISO timestamp of last recorded rebalance |
| `data.volume_ok` | `boolean` | Whether 24h volume meets minimum |
| `data.volume_24h_usd` | `number` | 24h pool volume in USD |
| `data.liquidity_usd` | `number` | Pool TVL in USD |
| `data.apr_24h_pct` | `number` | 24h fee APR from Bitflow app API |
| `data.pool_id` | `string` | Pool identifier |
| `data.pool_name` | `string` | Human-readable pool name |
| `data.fee_bps` | `number` | Pool fee in basis points |
| `data.position_note` | `string?` | Present when position state needs explanation |

## Data sources

| Source | Data | Endpoint |
|---|---|---|
| Bitflow HODLMM API | Pool list, active bin | `bff.bitflowapis.finance/api/quotes/v1/pools` |
| Bitflow Bins API | Per-bin prices (raw, for slippage) | `bff.bitflowapis.finance/api/quotes/v1/bins/{poolId}` |
| Bitflow App Pools API | TVL, 24h volume, APR, token prices, decimals | `bff.bitflowapis.finance/api/app/v1/pools` |
| Bitflow Position API | User's position bins | `bff.bitflowapis.finance/api/app/v1/users/{addr}/positions/{pool}/bins` |
| Hiro Stacks API | STX fee estimate | `api.mainnet.hiro.so/v2/fees/transfer` |

## v2 changelog (fixes from day-1 review)

### In-range check — was fake, now real

**Before:** `inRange = isFinite(pool.active_bin) && pool.active_bin > 0` — always `true`.

**After:** Real HTTP call to `GET /api/app/v1/users/{address}/positions/{poolId}/bins`. Filters bins where `user_liquidity > 0`, checks if `active_bin_id` is in that set.

### Slippage — was hardcoded, now live and fully Bitflow-native

**Before:** Constant value, always passed.

**After:** `(bin_price_raw / 1e8) × 10^(xDec − yDec)` vs Bitflow app API token price. No external oracles — all data from Bitflow endpoints.

### Gas estimate — was a made-up constant, now live

**Before:** `gas_estimated_stx: 0.006` — hardcoded.

**After:** `Hiro /v2/fees/transfer × 500 bytes × 2 txns × 3× contract multiplier × 1.2 safety buffer`.

### Cooldown — was not tracked, now persistent

**Before:** No state file, cooldown always passing.

**After:** Reads/writes `~/.hodlmm-guardian-state.json`. Returns `cooldown_remaining_h` on each run.

### Frontmatter — stale dependency removed

**Before:** `requires: [bitflow]` — referenced a non-existent dependency.

**After:** `requires: ""` — fully self-contained, all data from public HTTP APIs.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @cliqueengagements
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/39
