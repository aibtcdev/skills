---
name: hodlmm-rebalancer
description: >-
  Autonomous HODLMM liquidity rebalancer — monitors Bitflow DLMM pool state via
  hodlmm-risk, automatically adds liquidity in calm regimes, withdraws in crisis,
  and rebalances bin positions as price drifts. Requires wallet with funds.
author: locallaunchsc-cloud
author_agent: Risk Sentinel
user-invocable: false
arguments: status | run-cycle | add | withdraw | rebalance | configure | history
entry: hodlmm-rebalancer/hodlmm-rebalancer.ts
requires: [wallet, hodlmm-risk, bitflow]
tags: [l2, defi, write, mainnet-only, requires-funds, risk]
---

# HODLMM Rebalancer Skill

Autonomous liquidity management for Bitflow HODLMM (DLMM) pools. This skill
orchestrates the full LP lifecycle: risk assessment, entry, monitoring, rebalancing,
and exit. It uses `hodlmm-risk` for volatility scoring and `bitflow` for on-chain
liquidity operations.

## How It Works

1. **Assess** — Calls `hodlmm-risk assess-pool` to get volatility score and regime.
2. **Decide** — Maps regime to action: calm → add/hold, elevated → reduce, crisis → withdraw.
3. **Execute** — Calls `bitflow add-liquidity-simple` or `bitflow withdraw-liquidity-simple`.
4. **Track** — Logs every action with timestamp, txid, bin offsets, and PnL estimate.

## Usage

```
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts <subcommand> [options]
```

## Subcommands

### status

Show current rebalancer state: active positions, regime, last action, unrealized PnL.

```
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts status --pool-id <id>
```

Output:
```json
{
  "poolId": "dlmm_3",
  "regime": "calm",
  "volatilityScore": 22,
  "hasPosition": true,
  "positionBins": [{"binId": 445, "offset": -2}, {"binId": 447, "offset": 0}, {"binId": 449, "offset": 2}],
  "activeBinId": 447,
  "driftScore": 8,
  "totalDeposited": {"xAmount": "5000000", "yAmount": "50000"},
  "currentValue": {"xAmount": "5100000", "yAmount": "48500"},
  "unrealizedPnl": "+1.2%",
  "lastAction": "add",
  "lastActionTimestamp": "2026-03-24T20:00:00.000Z",
  "config": {"maxExposurePct": 25, "binWidth": 5, "rebalanceThreshold": 3}
}
```

### run-cycle

Execute one full assess → decide → act cycle. This is the core autonomous loop entry point.

```
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts run-cycle --pool-id <id> [--dry-run] [--wallet-password <pw>]
```

Options:
- `--pool-id` (required) — HODLMM pool identifier
- `--dry-run` (optional) — Simulate the cycle without executing transactions
- `--wallet-password` (optional) — Unlock wallet inline

Output:
```json
{
  "poolId": "dlmm_3",
  "cycle": {
    "assessment": {"volatilityScore": 18, "regime": "calm", "safeToAddLiquidity": true},
    "decision": "add",
    "reason": "Regime calm (score 18), no existing position, deploying initial liquidity",
    "action": {
      "type": "add-liquidity",
      "bins": [{"activeBinOffset": -2, "xAmount": "0", "yAmount": "25000"}, {"activeBinOffset": 0, "xAmount": "2500000", "yAmount": "25000"}, {"activeBinOffset": 2, "xAmount": "2500000", "yAmount": "0"}],
      "txid": "0xabc123...",
      "status": "submitted"
    }
  },
  "dryRun": false
}
```

### add

Manually add liquidity with risk-aware bin placement.

```
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts add --pool-id <id> --amount <stx-amount> [--bin-width <n>] [--wallet-password <pw>]
```

Options:
- `--pool-id` (required) — Pool ID
- `--amount` (required) — Total STX amount to deploy (human-readable)
- `--bin-width` (optional) — Number of bins to spread across (default: from config or risk signal)
- `--wallet-password` (optional) — Unlock wallet inline

### withdraw

Withdraw all or partial liquidity from a pool.

```
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts withdraw --pool-id <id> [--percentage <1-100>] [--wallet-password <pw>]
```

Options:
- `--pool-id` (required) — Pool ID
- `--percentage` (optional) — Percentage of position to withdraw (default: 100)
- `--wallet-password` (optional) — Unlock wallet inline

### rebalance

Rebalance existing position: withdraw from drifted bins, re-add around current active bin.

```
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts rebalance --pool-id <id> [--wallet-password <pw>]
```

### configure

Set rebalancer parameters.

```
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts configure --pool-id <id> [--max-exposure <pct>] [--bin-width <n>] [--rebalance-threshold <n>] [--crisis-action <withdraw|reduce|hold>]
```

Options:
- `--max-exposure` (optional) — Max portfolio % to deploy (default: 25)
- `--bin-width` (optional) — Default number of bins to spread across (default: 5)
- `--rebalance-threshold` (optional) — Bin drift distance that triggers rebalance (default: 3)
- `--crisis-action` (optional) — What to do in crisis regime: withdraw, reduce, or hold (default: withdraw)

### history

Show action history for a pool.

```
bun run hodlmm-rebalancer/hodlmm-rebalancer.ts history --pool-id <id> [--limit <n>]
```

## Decision Matrix

| Regime | Has Position | Drift > Threshold | Action |
|--------|-------------|-------------------|--------|
| calm | no | — | Add liquidity at recommended bin width |
| calm | yes | no | Hold — earning fees |
| calm | yes | yes | Rebalance — withdraw and re-add around active bin |
| elevated | no | — | Skip — wait for calm |
| elevated | yes | no | Reduce position by 50% |
| elevated | yes | yes | Withdraw fully |
| crisis | any | any | Emergency withdraw all positions |

## Notes

- All operations are mainnet-only.
- Requires funded wallet with STX for gas and position capital.
- Uses `hodlmm-risk` for all risk assessments — never bypasses risk checks.
- Position state is tracked locally at `~/.aibtc/hodlmm-rebalancer/<pool-id>.json`.
- The `run-cycle` subcommand is designed for cron/loop execution (e.g., every 5 minutes).
- `--dry-run` mode outputs the full decision without executing transactions.
- Fee earnings are estimated from bin reserve changes between cycles.
- The `rebalance-threshold` config controls sensitivity: lower = more frequent rebalancing = more gas, higher = more drift tolerance = less gas but potentially less fee capture.
