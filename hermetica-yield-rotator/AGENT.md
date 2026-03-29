---
name: hermetica-yield-rotator
skill: hermetica-yield-rotator
description: "Cross-protocol yield rotator: monitors Hermetica USDh staking APY vs Bitflow HODLMM dlmm_1 APR and executes capital rotation to the higher-yielding protocol on Stacks mainnet. Write-capable — outputs MCP commands for stake, initiate-unstake, complete-unstake, and rotate actions. Requires --confirm for all write operations."
---

# Hermetica Yield Rotator — Agent Safety Rules

## Guardrails

- **Maximum autonomous spend:** hardcoded at **500 USDh per operation** — enforced in code, not just docs. Pass `--amount` to override up to wallet balance.
- **Rotation threshold:** 2% minimum yield differential required before rotation is recommended
- **Rotation cooldown:** 30 minutes between rotation executions (tracked in `~/.hermetica-yield-rotator-state.json`)
- **Unstake cooldown:** 7 days — always reported before recommending ROTATE_TO_HODLMM so agent can plan complete-unstake timing

Refuse to execute write actions if ANY of the following are true:

1. **`--confirm` not provided** — all write actions (stake, initiate-unstake, complete-unstake, rotate) require explicit confirmation
2. **Data source preflight fails** — Hermetica contract or staking state unreachable; run `doctor` first
3. **`staking_enabled = false`** — do not stake when protocol has disabled staking
4. **`amount > user_balance`** — never attempt to stake or unstake more than wallet holds
5. **`rotation_cooldown_ok = false`** — do not rotate again within 30 minutes of last rotation
6. **`estimated_apy_pct = null`** on rotate action — cannot rotate without ≥1h of APY data
7. **`differential_pct < rotate_threshold_pct`** — do not rotate when yield difference is below threshold

Autonomous actions (no --confirm needed):

- All read-only contract calls via Hiro API — always allowed
- Fetch Bitflow HODLMM App and Quotes APIs — always allowed
- Read/write local state file (`~/.hermetica-yield-rotator-state.json`) for APY tracking — always allowed
- `run --wallet <addr>` (assess mode) — always allowed, never submits transactions

## Decision order

| Action | What it does | MCP tool used |
|---|---|---|
| `stake` | Stake USDh → receive sUSDh | `call_contract` staking-v1::stake |
| `initiate-unstake` | Begin 7-day unstake cooldown | `call_contract` staking-v1::initiate-unstake |
| `complete-unstake` | Redeem USDh after cooldown | `call_contract` staking-v1::complete-unstake |
| `rotate` (to HODLMM) | Initiate unstake + plan HODLMM add | `call_contract` + `bitflow_hodlmm_add_liquidity` |
| `rotate` (to staking) | Remove HODLMM bins + stake | `bitflow_hodlmm_remove_liquidity` + `call_contract` |

## Rotation Decision Tree

```
Both APY and APR available?
├── No  → ERROR: INSUFFICIENT_YIELD_DATA
└── Yes → diff = |hodlmm_apr - usdh_apy|
          diff < 2%? → HOLD (no rotation needed)
          HODLMM APR > USDh APY + 2%?
          ├── user has sUSDh → initiate-unstake (wait 7d, then complete + add to HODLMM)
          ├── user has idle USDh → add-liquidity to HODLMM directly
          └── no position → inform, no commands
          USDh APY > HODLMM APR + 2%?
          ├── user has HODLMM bins → remove-liquidity + stake
          ├── user has idle USDh → stake directly
          └── no position → inform, no commands
```

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
