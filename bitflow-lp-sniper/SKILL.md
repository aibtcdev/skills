---
name: bitflow-lp-sniper
description: "Autonomous HODLMM concentrated liquidity deployer and position manager for Bitflow on Stacks mainnet. Analyzes live bin state to compute optimal entry ranges, deploys LP positions with configurable strategies (tight/normal/wide), rebalances out-of-range positions, and tracks fee earnings — all with enforced spend caps and gas reserves."
metadata:
  author: "ThankNIXlater"
  author-agent: "Nix — ThankNIXlater | earntoshi"
  user-invocable: "true"
  arguments: "doctor | install-packs | run [--wallet <STX_ADDRESS>] [--action <analyze|deploy|rebalance|exit|status>] [--pool-id <id>] [--amount-x <sats>] [--amount-y <micro>] [--strategy <tight|normal|wide>] [--confirm]"
  entry: "bitflow-lp-sniper/bitflow-lp-sniper.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2, hodlmm"
---

# Bitflow LP Sniper

Autonomous HODLMM concentrated liquidity manager for Bitflow on Stacks mainnet. Computes optimal bin ranges from live pool state and executes LP deployment, rebalancing, and exits with enforced safety caps.

## What it does

Fetches live Bitflow HODLMM pool state (active bin, bin distribution, TVL, APR, fee velocity) from Bitflow's App and Quotes APIs. For each pool it computes the optimal concentrated liquidity range using one of three configurable strategies:

- **tight** — ±5 bins around active bin. Maximizes fee capture during low-volatility periods. Requires more frequent rebalancing.
- **normal** — ±15 bins. Balanced trade-off between fee capture and rebalancing frequency.
- **wide** — ±50 bins. Passive exposure; survives larger price swings without going out-of-range.

In `analyze` mode (read-only): scores all active pools by momentum, computes the recommended bin range, and estimates projected APR at current bin density.

In `deploy` mode (write): outputs MCP `bitflow_hodlmm_add_liquidity` commands to deploy funds into the computed bin range. Enforces hard caps, gas reserves, and pool health checks before emitting any command.

In `rebalance` mode (write): checks if the wallet's current position is out-of-range. If so, emits `bitflow_hodlmm_remove_liquidity` for the old bins followed by `bitflow_hodlmm_add_liquidity` for a fresh range centered on the current active bin.

In `exit` mode (write): removes all bins from the wallet's HODLMM position in the specified pool. Used for full capital withdrawal.

In `status` mode (read-only): shows current position bins, active bin distance, unrealized IL estimate, and cumulative fee earnings tracked in local state.

## Why agents need it

The existing Bitflow skill ecosystem has read tools (hodlmm-pulse for momentum, hodlmm-bin-guardian for range checks, hodlmm-risk for volatility scoring) but no execution layer. An agent that detects a fee spike via hodlmm-pulse and confirms healthy regime via hodlmm-risk has nowhere to go — it cannot act. This skill closes that gap.

Combined pipeline:
1. `hodlmm-pulse scan` — detect pools with active momentum (`spike` or `elevated` signal)
2. `hodlmm-risk assess-pool` — confirm volatility regime (`calm` or `elevated`, never `crisis`)
3. `bitflow-lp-sniper run --action=analyze --pool-id <id>` — compute optimal bin range
4. `bitflow-lp-sniper run --action=deploy --pool-id <id> --strategy tight --confirm` — execute entry
5. `bitflow-lp-sniper run --action=status` — monitor position
6. `bitflow-lp-sniper run --action=rebalance --confirm` — auto-rebalance when out-of-range
7. `bitflow-lp-sniper run --action=exit --confirm` — exit when pulse signal drops to `cooling`

## Safety notes

All limits are **enforced in code** before any MCP command is emitted:

| Control | Default | Enforced |
|---------|---------|----------|
| Max deploy per operation | 1,000,000 sats (0.01 BTC) | `--amount-x`, hard cap 5,000,000 sats |
| Min gas reserve (STX) | 0.5 STX | Always enforced — never deploys below gas floor |
| Min pool TVL to deploy | $5,000 USD | Deploy blocked if TVL too thin |
| Min 24h volume to deploy | $1,000 USD | Prevents entering dead pools |
| Rebalance cooldown | 3600 seconds (1 hour) | Tracked in local state file |
| Max rebalance per day | 3 operations | Prevents rebalancing loop in volatile markets |
| Write actions | Require `--confirm` | All deploy/rebalance/exit require explicit flag |

**HODLMM bonus eligible:** This skill integrates Bitflow HODLMM at the execution level — `bitflow_hodlmm_add_liquidity`, `bitflow_hodlmm_remove_liquidity` MCP commands emitted with computed bin arrays and amounts.

## Output contract

All outputs are strict JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "ANALYZE | DEPLOY | REBALANCE | EXIT | STATUS | Blocked: <reason>",
  "data": {
    "pool_id": "dlmm_1",
    "active_bin": 514,
    "strategy": "normal",
    "recommended_range": { "min_bin": 499, "max_bin": 529, "width": 30 },
    "entry_price_usd": 67127.25,
    "projected_apr_pct": 16.42,
    "tvl_usd": 189442.65,
    "fee_velocity": 1.2,
    "momentum_signal": "elevated",
    "mcp_commands": "[McpCommand[] | null] — present on write actions",
    "position_bins": "[number[] | null] — current wallet bins",
    "in_range": "boolean | null",
    "estimated_il_pct": "number | null"
  },
  "error": "null | { code, message, next }"
}
```

## Prerequisites

This skill requires the AIBTC MCP server for all on-chain write interactions:

```bash
npx @aibtc/mcp-server@latest --install
```

## Commands

### doctor

Pre-flight check: Bitflow App API, Bitflow Quotes API, Hiro API, wallet balance, STX gas, pool health.

```bash
bun run skills/bitflow-lp-sniper/bitflow-lp-sniper.ts doctor
```

### install-packs

No additional packs required for read commands. Write commands require AIBTC MCP server.

```bash
bun run skills/bitflow-lp-sniper/bitflow-lp-sniper.ts install-packs
```

### run --action=analyze

Fetch all HODLMM pools, compute optimal bin ranges, rank by momentum. Read-only — no wallet needed.

```bash
# Analyze all pools
bun run skills/bitflow-lp-sniper/bitflow-lp-sniper.ts run --action=analyze

# Analyze specific pool with all three strategies
bun run skills/bitflow-lp-sniper/bitflow-lp-sniper.ts run --action=analyze --pool-id dlmm_1
```

Options:
- `--pool-id` (optional) — limit to one pool
- `--strategy` (optional, default: `normal`) — bin range strategy: `tight`, `normal`, `wide`

### run --action=deploy

Deploy concentrated liquidity into the specified pool. Requires wallet + confirm.

```bash
# Deploy sBTC+USDCx into dlmm_1 with normal strategy
bun run skills/bitflow-lp-sniper/bitflow-lp-sniper.ts run \
  --wallet SP1234... --action=deploy --pool-id dlmm_1 \
  --amount-x 50000 --amount-y 33000000 \
  --strategy normal --confirm
```

Options:
- `--wallet` (required) — Stacks address
- `--pool-id` (required) — HODLMM pool ID
- `--amount-x` (required) — tokenX amount in smallest unit (sats for sBTC, micro-STX for STX)
- `--amount-y` (required) — tokenY amount in smallest unit (micro-USDC for USDCx)
- `--strategy` (default: `normal`) — bin range strategy
- `--confirm` (required) — explicit write confirmation

Bin ranges by strategy:
- `tight`: active_bin ± 5 (11 bins total)
- `normal`: active_bin ± 15 (31 bins total)
- `wide`: active_bin ± 50 (101 bins total)

### run --action=rebalance

Remove current out-of-range bins and redeploy at the current active bin. Rebalance is blocked if position is in-range (no wasted gas), if rebalance cooldown is active, or if daily rebalance cap is reached.

```bash
bun run skills/bitflow-lp-sniper/bitflow-lp-sniper.ts run \
  --wallet SP1234... --action=rebalance --pool-id dlmm_1 --confirm
```

Options:
- `--wallet` (required) — Stacks address
- `--pool-id` (required) — HODLMM pool ID
- `--strategy` (default: `normal`) — bin range strategy for the new position
- `--confirm` (required) — explicit write confirmation

### run --action=exit

Remove all LP bins from the position in the specified pool.

```bash
bun run skills/bitflow-lp-sniper/bitflow-lp-sniper.ts run \
  --wallet SP1234... --action=exit --pool-id dlmm_1 --confirm
```

### run --action=status

Display current position state: bin range, active bin distance, in-range status, IL estimate.

```bash
bun run skills/bitflow-lp-sniper/bitflow-lp-sniper.ts run \
  --wallet SP1234... --action=status
```

## Does this integrate HODLMM?

- [x] Yes — eligible for the +$1,000 sBTC HODLMM bonus pool

Integrates HODLMM at the execution level: emits `bitflow_hodlmm_add_liquidity` and `bitflow_hodlmm_remove_liquidity` MCP commands with computed bin arrays. The `analyze` action provides the upstream intelligence layer that feeds the write pipeline.

## Data sources

| Source | Data | Endpoint |
|---|---|---|
| Bitflow App API | All pools: TVL, APR, apr24h, feesUsd1d/7d, volumeUsd1d/7d, token prices | `bff.bitflowapis.finance/api/app/v1/pools` |
| Bitflow Quotes API | Active bin, bin distribution, reserves per bin | `bff.bitflowapis.finance/api/quotes/v1/pools`, `/bins/{pool}` |
| Hiro Address API | Wallet FT balances, STX balance | `api.mainnet.hiro.so/extended/v1/address/{addr}/balances` |
| Bitflow HODLMM App API | Wallet position bins | `bff.bitflowapis.finance/api/app/v1/users/{addr}/positions/{pool}/bins` |
| Local state file | Rebalance history, cooldowns, daily ops counter | `~/.bitflow-lp-sniper-state.json` |

## Known constraints

- HODLMM v1 uses equal-distribution across bins (uniform strategy) — no custom weight curves
- `bitflow_hodlmm_add_liquidity` requires exact tokenX + tokenY amounts at deployment ratio
- Slippage on entry/exit is a function of bin step size and active bin proximity
- 7-day cooldown is not applicable (that's Hermetica unstaking) — HODLMM liquidity is instantly removable
- STX required for transaction fees on each operation — minimum 0.5 STX reserve enforced
- Rebalance emits TWO on-chain transactions (remove + add) — gas cost doubles vs single deploy
