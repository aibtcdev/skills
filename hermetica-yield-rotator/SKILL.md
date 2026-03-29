---
name: hermetica-yield-rotator
description: "Cross-protocol yield rotator for Stacks mainnet. Monitors Hermetica USDh staking APY vs Bitflow HODLMM dlmm_1 APR from live on-chain data, assesses wallet position, and executes yield rotation between protocols when the differential exceeds a configurable threshold. Write-capable: outputs MCP commands for stake, initiate-unstake, complete-unstake, and cross-protocol rotate actions."
metadata:
  author: cliqueengagements
  author-agent: "Micro Basilisk (Agent 77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "true"
  arguments: "doctor | install-packs | run [--wallet <STX_ADDRESS>] [--action <assess|stake|initiate-unstake|complete-unstake|rotate>] [--amount <usdh>] [--confirm]"
  entry: "hermetica-yield-rotator/hermetica-yield-rotator.ts"
  requires: ""
  tags: "defi, hermetica, usdh, staking, bitflow, yield, rotation, actions, mainnet-only, l2"
---

# Hermetica Yield Rotator

Cross-protocol yield rotator that monitors Hermetica USDh staking APY against Bitflow HODLMM dlmm_1 APR and executes capital rotation to the higher-yielding protocol on Stacks mainnet.

## What it does

Queries five Hermetica mainnet contracts (staking-v1, staking-state-v1, staking-silo-v1-1, usdh-token-v1, susdh-token-v1) for the live exchange rate, staking state, cooldown window, and user position. Fetches Bitflow HODLMM dlmm_1 APR and active bin from Bitflow App and Quotes APIs. Tracks the USDh/sUSDh exchange rate in a local state file to estimate APY from ratio changes over time.

In assess mode (default), surfaces a HOLD / STAKE / ROTATE_TO_HODLMM / ROTATE_TO_STAKING recommendation. In write mode (with --confirm), outputs MCP tool commands to execute the recommended action.

**Rotation logic:** rotates when yield differential exceeds 2% threshold. HODLMM preferred → initiates Hermetica unstake (7-day cooldown), then swaps USDh → USDCx (dlmm_1 accepts USDCx, not USDh) and deploys to HODLMM. Staking preferred → removes HODLMM bins, stakes in Hermetica. Idle USDh → swaps to USDCx then deploys to best-yielding protocol immediately.

**30-minute rotation cooldown** prevents thrashing. All write actions require `--confirm`.

## Why agents need it

USDh staking yield and HODLMM LP fees move independently. Without active rotation, agents leave yield on the table when market conditions shift. This skill closes that gap: a single `--action=rotate --confirm` re-allocates capital to the optimal protocol based on live data.

## Safety notes

- **500 USDh autonomous spend cap — hardcoded in code.** Without explicit `--amount`, stake/unstake/rotate operations are capped at 500 USDh regardless of wallet balance. Pass `--amount` to operate on larger positions.
- **Doctor-first preflight enforced in code:** write actions verify Hermetica contract and staking state are reachable before executing. Aborts with `PREFLIGHT_FAILED` if sources are down.
- All write actions require explicit `--confirm` flag — no accidental execution
- 2% minimum differential threshold prevents unnecessary rotation on noise
- 30-minute cooldown between rotations tracked in local state file
- Balance checked before stake/initiate-unstake — rejects if insufficient
- Rotation blocked if APY data unavailable (< 1h of exchange rate history)
- Rotation cooldown checked before execution
- `initiate-unstake` always reports 7-day cooldown so agent can plan `complete-unstake`

## Output Contract

All outputs are strict JSON to stdout:

```json
{
  "status": "success | error",
  "action": "HOLD | STAKE | ROTATE_TO_HODLMM | ROTATE_TO_STAKING | INITIATE_UNSTAKE | COMPLETE_UNSTAKE | CHECK | Blocked: <reason>",
  "data": {
    "mcp_commands": "[McpCommand[] | null] — present on write actions",
    "staking_enabled": "boolean",
    "exchange_rate": "number",
    "accumulated_yield_pct": "number",
    "estimated_apy_pct": "number | null",
    "cooldown_days": "number",
    "hodlmm_apr_pct": "number | null",
    "hodlmm_active_bin": "number | null",
    "yield_comparison": "string | null",
    "user_usdh": "number | null",
    "user_susdh": "number | null",
    "rotation_cooldown_ok": "boolean",
    "rotate_threshold_pct": "number"
  },
  "error": "null | { code, message, next }"
}
```

## Prerequisites

This skill requires the AIBTC MCP server for all on-chain interactions:

```bash
npx @aibtc/mcp-server@latest --install
```

## Commands

### doctor

```bash
bun run hermetica-yield-rotator/hermetica-yield-rotator.ts doctor
```

### install-packs

```bash
bun run hermetica-yield-rotator/hermetica-yield-rotator.ts install-packs --pack all
```

### run — assess (read-only, no --confirm needed)

```bash
bun run hermetica-yield-rotator/hermetica-yield-rotator.ts run --wallet SP1234...
```

### run — stake

```bash
bun run hermetica-yield-rotator/hermetica-yield-rotator.ts run \
  --wallet SP1234... --action=stake --amount=500 --confirm
```

### run — initiate-unstake

```bash
bun run hermetica-yield-rotator/hermetica-yield-rotator.ts run \
  --wallet SP1234... --action=initiate-unstake --amount=500 --confirm
```

### run — complete-unstake

```bash
bun run hermetica-yield-rotator/hermetica-yield-rotator.ts run \
  --wallet SP1234... --action=complete-unstake --confirm
```

### run — rotate (auto-rotate to best yield)

```bash
bun run hermetica-yield-rotator/hermetica-yield-rotator.ts run \
  --wallet SP1234... --action=rotate --confirm
```

## Live terminal output

### doctor

```json
{
  "status": "ok",
  "checks": [
    { "name": "Hermetica staking-v1",                      "ok": true, "detail": "exchange rate: 1.00000000 USDh/sUSDh" },
    { "name": "Hermetica staking-state-v1",                "ok": true, "detail": "staking enabled: true, cooldown: 7.0 days" },
    { "name": "Hermetica token contracts (USDh + sUSDh)",  "ok": true, "detail": "USDh supply: $9,049,413.13, sUSDh: 1,836,203.38" },
    { "name": "Bitflow HODLMM App API (dlmm_1)",           "ok": true, "detail": "APR: 17.72%, TVL: $77,143" },
    { "name": "Bitflow HODLMM Bins API (dlmm_1)",          "ok": true, "detail": "active bin: 504" }
  ],
  "message": "All data sources reachable. Ready to run."
}
```

### install-packs

```json
{
  "status": "ok",
  "message": "No packs required. hermetica-yield-rotator uses Hermetica contracts and Hiro/Bitflow public APIs only.",
  "data": { "requires": [] }
}
```

### run --wallet (assess — no position)

```json
{
  "status": "success",
  "action": "CHECK — staking enabled, protocol healthy. Provide --wallet to check position.",
  "data": {
    "staking_enabled": true,
    "exchange_rate": 1,
    "accumulated_yield_pct": 0,
    "estimated_apy_pct": null,
    "cooldown_days": 7,
    "usdh_total_supply": 9049413.13,
    "susdh_total_supply": 1836203.38,
    "hodlmm_apr_pct": 17.72,
    "hodlmm_tvl_usd": 77142.99,
    "hodlmm_active_bin": 504,
    "yield_comparison": "HODLMM dlmm_1 APR: 17.72% | USDh staking APY: tracking started — check again in ≥1h",
    "user_usdh": 0,
    "user_susdh": 0,
    "user_susdh_value_usdh": 0,
    "hodlmm_position_bins": null,
    "rotation_cooldown_ok": true,
    "rotate_threshold_pct": 2,
    "refusal_reasons": null,
    "silo_epoch_ts": 1774660532
  },
  "error": null
}
```

### run --action=stake --amount=500 --confirm (balance guard — no USDh)

```json
{
  "status": "error",
  "action": "Blocked: Amount 500.00 USDh exceeds wallet balance 0.00",
  "data": null,
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Amount 500.00 USDh exceeds wallet balance 0.00",
    "next": "Reduce --amount or acquire more USDh."
  }
}
```

### run --action=rotate (missing --confirm guard)

```json
{
  "status": "error",
  "action": "Blocked: --confirm required for action 'rotate'",
  "data": null,
  "error": {
    "code": "CONFIRM_REQUIRED",
    "message": "--confirm required for action 'rotate'",
    "next": "Re-run with --confirm to execute."
  }
}
```

### run --action=rotate --confirm (no APY data yet guard)

```json
{
  "status": "error",
  "action": "Blocked: Cannot rotate without both USDh APY and HODLMM APR data. APY requires ≥1h of exchange rate observations.",
  "data": null,
  "error": {
    "code": "INSUFFICIENT_YIELD_DATA",
    "message": "Cannot rotate without both USDh APY and HODLMM APR data. APY requires ≥1h of exchange rate observations.",
    "next": "Run in assess mode for ≥1h, then retry --action=rotate."
  }
}
```

## Does this integrate HODLMM?

- [x] Yes — eligible for the +$1,000 sBTC bonus pool

Integrates HODLMM at the execution level: fetches live dlmm_1 APR and active bin on every run, outputs `bitflow_swap` (USDh → USDCx), `bitflow_hodlmm_add_liquidity`, and `bitflow_hodlmm_remove_liquidity` MCP commands as part of the rotation pipeline. The swap step is required because dlmm_1 accepts USDCx, not USDh.

## Data sources

| Source | Data | Endpoint |
|---|---|---|
| Hermetica staking-v1 | Exchange rate | `SPN5AK…HSG.staking-v1::get-usdh-per-susdh` |
| Hermetica staking-state-v1 | Staking enabled, cooldown | `::get-staking-enabled`, `::get-cooldown-window` |
| Hermetica staking-silo-v1-1 | Epoch timestamp | `::get-current-ts` |
| Hermetica usdh-token-v1 / susdh-token-v1 | Token supplies | `::get-total-supply` |
| Hiro Address API | User FT balances | `api.mainnet.hiro.so/extended/v1/address/{addr}/balances` |
| Bitflow HODLMM App API | dlmm_1 APR, TVL, user position bins | `bff.bitflowapis.finance/api/app/v1/pools`, `/users/{addr}/positions/{pool}/bins` |
| Bitflow HODLMM Quotes API | Active bin ID | `bff.bitflowapis.finance/api/quotes/v1/bins/{pool}` |

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @cliqueengagements
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/56
