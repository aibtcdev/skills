---
name: hodlmm-move-liquidity
description: "HODLMM Move-Liquidity & Auto-Rebalancer — withdraw from drifted bins, re-deposit around the current active bin. Includes autonomous monitoring loop."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk (Agent 77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "false"
  arguments: "doctor | scan | run | auto | install-packs"
  entry: "hodlmm-move-liquidity/hodlmm-move-liquidity.ts"
  requires: "wallet, signing"
  tags: "defi, write, mainnet-only, requires-funds"
---

# HODLMM Move-Liquidity & Auto-Rebalancer

## What it does

When the active bin drifts away from your LP position, move your liquidity to the active bin. One atomic transaction via the Bitflow DLMM liquidity router's `move-relative-liquidity-multi` function: withdraw from old bins and deposit into the active bin in a single on-chain call. No intermediate state, no nonce sequencing, no partial execution risk.

The active bin is where all trades flow and fees accrue. Capital in any other bin earns zero. This skill concentrates your liquidity where it earns.

The `auto` command runs as an autonomous rebalancer — it monitors all pools on a configurable interval and automatically moves liquidity when drift exceeds a threshold. No manual intervention required. Set it, and the agent keeps your capital in the active bin around the clock.

## Why agents need it

Every HODLMM read skill in the competition hits the same wall. They detect drift, score risk, recommend action — then stop. Capital sits in dead bins earning nothing while the active bin moves on without it.

This skill closes the loop. The `run` command moves liquidity on demand. The `auto` command makes it autonomous — an agent running this skill keeps its capital productive without human intervention, 24/7.

## Safety notes

- **Writes to chain.** One atomic transaction per rebalance via `move-relative-liquidity-multi`. Withdraw + deposit happen in a single on-chain call — either both succeed or neither does.
- **Moves funds.** Liquidity is removed from old bins and placed in new bins. No tokens leave the LP's wallet — they pass through the DLMM liquidity router contract.
- **Mainnet only.** All contract addresses are mainnet Stacks.
- **`--confirm` required for `run`.** Without it, `run` outputs a dry-run preview with full plan details. No transaction is broadcast. The `auto` command executes directly (operator opts in by starting it).
- **postConditionMode: Allow** — HODLMM operations mint and burn DLP tokens in the same transaction, which cannot be expressed as sender-side post-conditions. Contract-level slippage protection compensates: each move requires ≥95% DLP shares back (`min-dlp`) and caps liquidity fees at 5% of the amount (`max-x-liquidity-fee`, `max-y-liquidity-fee`). If the contract violates either bound, the transaction reverts on-chain. Additional safety: `--confirm` gate, cooldown, in-range check, and gas check.
- **4-hour cooldown** between moves on the same pool, enforced in code and persisted to disk.

## Commands

### doctor

Check API access, wallet readiness, and dependency availability.

```bash
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts doctor --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY
```

### scan

Read-only scan of all HODLMM pools. Shows each position's in-range status, bin range, active bin, and drift distance.

```bash
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts scan --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY
```

### run

Assess a specific pool and generate a move plan. Dry-run by default.

```bash
# Preview (no on-chain action)
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts run --wallet <addr> --pool dlmm_1

# Execute
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts run --wallet <addr> --pool dlmm_1 --confirm --password <pass>

# Custom spread (default: ±5 bins around active)
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts run --wallet <addr> --pool dlmm_1 --spread 3 --confirm --password <pass>

# Force recenter an in-range position
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts run --wallet <addr> --pool dlmm_1 --force --confirm --password <pass>
```

Options:
- `--spread <n>` — bin spread ±N around active bin (default: 5, max: 10)
- `--force` — force rebalance even if position is in range (recenter around active bin)

### auto

Autonomous rebalancer. Monitors all pools on a loop, auto-moves liquidity when drift exceeds threshold.

```bash
# Start auto-rebalancer (checks every 15 minutes, moves when drift ≥ 3 bins)
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts auto --wallet <addr> --password <pass>

# Custom interval and threshold
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts auto --wallet <addr> --password <pass> --interval 30 --drift-threshold 5

# Single cycle (no loop)
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts auto --wallet <addr> --password <pass> --once
```

Options:
- `--interval <minutes>` — check interval (default: 15, minimum: 5)
- `--drift-threshold <bins>` — minimum drift to trigger move (default: 3)
- `--spread <n>` — bin spread ±N around active bin (default: 5, max: 10)
- `--max-moves <n>` — max moves per cycle, 0 = unlimited (default: 0)
- `--once` — run one cycle then exit

### install-packs

No external packs required.

```bash
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts install-packs
```

## Output contract

All commands emit JSON to stdout.

**scan — success:**
```json
{
  "status": "success",
  "action": "scan",
  "data": {
    "wallet": "SP...",
    "pools_scanned": 8,
    "positions_found": 2,
    "out_of_range": 1,
    "positions": [
      {
        "pool_id": "dlmm_1",
        "pair": "sBTC/USDCx",
        "active_bin": 510,
        "user_bins": [500, 501, 502, 503, 504],
        "user_bin_min": 500,
        "user_bin_max": 504,
        "in_range": false,
        "drift": 8,
        "total_x": "50000",
        "total_y": "120000000",
        "total_dlp": "980000"
      }
    ]
  },
  "error": null
}
```

**run — in range (no action):**
```json
{
  "status": "success",
  "action": "run",
  "data": {
    "decision": "IN_RANGE",
    "reason": "Position is already in the active range — earning fees. No move needed. Use --force to recenter.",
    "health": { "..." : "..." }
  },
  "error": null
}
```

**run — dry-run:**
```json
{
  "status": "success",
  "action": "run",
  "data": {
    "decision": "MOVE_NEEDED",
    "mode": "dry-run",
    "reason": "Position drifted 8 bins from active. Add --confirm --password <pass> to execute.",
    "health": { "..." : "..." },
    "plan": {
      "pool_id": "dlmm_1",
      "pair": "sBTC/USDCx",
      "active_bin": 510,
      "atomic": true,
      "spread": 5,
      "old_range": { "min": 500, "max": 504, "bins": 5 },
      "new_range": { "min": 505, "max": 515, "bins": 11 },
      "moves": [
        { "from": 500, "to_offset": -5, "to_bin": 505, "dlp": "196000" },
        { "from": 501, "to_offset": -4, "to_bin": 506, "dlp": "196000" }
      ],
      "stx_balance": 12.5,
      "estimated_gas_stx": 0.05
    }
  },
  "error": null
}
```

**run — executed:**
```json
{
  "status": "success",
  "action": "run",
  "data": {
    "decision": "EXECUTED",
    "health": { "..." : "..." },
    "plan": { "..." : "..." },
    "transaction": {
      "txid": "0xabc...",
      "explorer": "https://explorer.hiro.so/txid/0xabc...?chain=mainnet"
    }
  },
  "error": null
}
```

**auto — cycle report:**
```json
{
  "status": "success",
  "action": "auto",
  "data": {
    "mode": "loop",
    "interval_minutes": 15,
    "drift_threshold": 3,
    "spread": 5,
    "cycle": 1,
    "moves": 1,
    "skipped": 0,
    "errors": 0,
    "next_check": "2026-04-08T12:30:00.000Z"
  },
  "error": null
}
```

**Error:**
```json
{ "status": "error", "action": "run", "data": null, "error": "descriptive message" }
```

**Blocked:**
```json
{ "status": "blocked", "action": "run", "data": { "cooldown_minutes": 42 }, "error": "Cooldown active — 42 minutes remaining" }
```

## Known constraints

- Requires `@stacks/transactions` and `@stacks/wallet-sdk` to be installed in the runtime environment.
- Single atomic transaction via `move-relative-liquidity-multi` — either all bins move or none do. No partial execution risk.
- Liquidity is distributed across ±spread bins around the active bin (default ±5). The DLMM bin invariant requires bins below active to hold only Y token and bins above active to hold only X token — source bins below active map to destination offsets [-spread, 0] and source bins above active map to [0, +spread].

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @cliqueengagements
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/231
