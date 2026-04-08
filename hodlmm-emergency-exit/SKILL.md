---
name: hodlmm-emergency-exit
description: "Risk-gated HODLMM LP withdrawal. Monitors pool conditions (composition imbalance, depth collapse, fee death, bin drift), scores exit urgency (critical/warning/monitor/safe), and emits bitflow withdrawal MCP commands when safety thresholds are breached. Write skill with triple-gate safety: urgency check + value floor + explicit confirmation."
metadata:
  author: "lekanbams"
  author-agent: "Yield Oracle"
  user-invocable: "false"
  arguments: "doctor | assess | exit | scan"
  entry: "hodlmm-emergency-exit/hodlmm-emergency-exit.ts"
  requires: "wallet"
  tags: "l2, defi, write, mainnet-only"
---

# HODLMM Emergency Exit Skill

## Use case

An agent with active LP positions across HODLMM pools faces a critical question during market stress: **"Should I exit this position right now, or hold?"**

Today, an agent can check risk via `hodlmm-risk` (volatility regime) and fee performance via `hodlmm-fee-harvester` (fee accrual). But neither takes action. When a pool's composition goes 90% single-sided, or the active bin drifts 30 bins from the position, or fees dry up for a week, the agent has no automated way to execute an exit. It must read the data, decide, and manually call `bitflow withdraw-liquidity-simple`. That delay costs money during fast-moving events.

This skill closes the loop: it reads the risk signals, applies hardcoded safety thresholds, and emits the withdrawal MCP command only when conditions warrant it, behind a triple-gate safety model.

**No existing skill does this.** `hodlmm-risk` assesses but doesn't act. `hodlmm-range-keeper` rebalances but doesn't exit. `bitflow-lp-sniper` deploys and rebalances but has no emergency exit logic. `hodlmm-bin-guardian` monitors position health but doesn't withdraw.

## What it does

- Monitors 5 risk triggers: composition imbalance, bin drift, depth collapse, fee death, out-of-range position
- Scores exit urgency 0-100 and classifies as `critical` / `warning` / `monitor` / `safe`
- Emits `bitflow withdraw-liquidity-simple` MCP commands only when urgency is `warning` or higher
- Triple-gate safety: (1) urgency must be warning/critical, (2) position value must exceed $0.50, (3) `--confirm` flag required

## Safety enforcements (hardcoded in code)

| Limit | Value | Purpose |
|-------|-------|---------|
| `MAX_POSITIONS_PER_EXIT` | 10 | Never withdraw more than 10 bin positions at once |
| `MIN_POSITION_VALUE_USD` | $0.50 | Don't exit positions worth less than gas cost |
| `IMBALANCE_CRISIS_THRESHOLD` | 85% | Pool 85%+ single-sided = critical |
| `IMBALANCE_WARNING_THRESHOLD` | 60% | Pool 60%+ imbalanced = warning |
| `DEPTH_CRISIS_THRESHOLD` | Score 5 | Depth below 5/100 = liquidity evaporated |
| `FEE_DEAD_POOL_THRESHOLD` | $0 (7d) | Zero fees in 7 days = dead pool |
| `VOLATILITY_CRISIS_BINS` | 30 bins | Active bin moved 30+ bins from position center |

All limits are enforced in TypeScript, not just documented. The `exit` command will not emit a withdrawal command unless all three gates pass.

## Commands

### doctor

Health check with safety threshold display.

```
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts doctor
```

### assess

Read-only risk assessment for a position. No action taken.

```
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts assess --address SP... --pool-id dlmm_1
```

### exit

Generate withdrawal MCP command. Requires urgency + value + confirmation gates.

```
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts exit --address SP... --pool-id dlmm_1 --confirm
```

Options:
- `--confirm` (required) -- Must be present to emit the withdrawal command
- `--force` (optional) -- Override urgency check (exit even if safe)

### scan

Scan all pools for a wallet and assess exit urgency for each position.

```
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts scan --address SP...
```

## Risk trigger scoring

| Trigger | Score | Condition |
|---------|-------|-----------|
| Composition crisis | +40 | Pool >= 85% single-sided |
| Composition warning | +20 | Pool >= 60% imbalanced |
| Out of range | +25 | Position center > 5 bins from active |
| Extreme bin drift | +30 | Active bin moved 30+ bins from position |
| Depth collapse | +25 | Depth score <= 5/100 |
| Dead pool (no fees) | +15 | Zero fees earned in 7 days |

**Urgency classification:**
- `critical` (>= 50): Immediate exit recommended
- `warning` (>= 25): Consider exiting or reducing position
- `monitor` (> 0): Minor concerns, watch closely
- `safe` (0): No exit triggers active

## Output contract

All commands return structured JSON with `status: "success" | "error" | "blocked"`:

```json
{
  "status": "success | error | blocked",
  "action": "human-readable next step",
  "data": { "...": "command-specific fields" },
  "error": { "code": "...", "message": "...", "next": "..." } | null
}
```

The `blocked` status is used when a safety gate prevents the exit (insufficient urgency, position too small, missing --confirm).

## Known constraints

- Mainnet only.
- Position data requires a wallet address. The skill does not enumerate addresses.
- Withdrawal amounts use max(reserve_x, reserve_y) per bin as a conservative estimate.
- `minXAmount` and `minYAmount` are set to "0" for emergency exits (slippage tolerance is infinite during emergencies).
- The `--force` flag bypasses the urgency check but NOT the value floor or confirmation gate.
- The `scan` command makes 3 API calls per pool (rich + bins + position). Rate limits may apply at scale.

## Origin

Submitted to AIBTC x Bitflow Skills Pay the Bills competition.
Author: @lekanbams
