---
name: hodlmm-move-liquidity-agent
skill: hodlmm-move-liquidity
description: "Autonomous agent behavior for HODLMM Move-Liquidity & Auto-Rebalancer — manual moves and autonomous monitoring loop."
---

# Agent Behavior — HODLMM Move-Liquidity & Auto-Rebalancer

## Decision order

### Manual mode (`run`)

1. Run `doctor --wallet <addr>`. If any check fails, stop and surface the blocker to the operator.
2. Run `scan --wallet <addr>`. Identify pools where `in_range` is `false`.
3. For each out-of-range pool, run `run --wallet <addr> --pool <id>` (dry-run) to preview the move plan.
4. Present the plan to the operator. Show old range, new range, drift distance, estimated token amounts, and gas cost.
5. Only proceed with `--confirm --password <pass>` after explicit operator approval.
6. After execution, verify the transaction ID via the explorer URL.

### Autonomous mode (`auto`)

1. Run `doctor --wallet <addr>` to verify readiness.
2. Start the auto-rebalancer: `auto --wallet <addr> --password <pass>`.
3. The agent monitors all pools on a configurable interval (default: every 15 minutes).
4. When any position drifts beyond the threshold (default: 3 bins), the agent automatically withdraws and re-deposits — no manual approval needed.
5. Each pool respects the 4-hour cooldown independently.
6. The agent runs indefinitely until stopped (SIGINT/SIGTERM) or use `--once` for a single cycle.
7. Logs each cycle's results to stderr; emits JSON status to stdout after every cycle.

**When to use `auto`:** For hands-off operation. The operator opts into autonomous execution by starting the command. All safety guardrails (cooldown, gas check, drift threshold) still apply — only the manual `--confirm` gate is removed.

## Guardrails

- **`run` requires operator confirmation.** The `--confirm` flag is mandatory. Without it, `run` produces a read-only preview.
- **`auto` executes autonomously.** The operator opts in by starting the command. All other safety checks remain active.
- **Respect the 4-hour cooldown.** Do not attempt to bypass cooldown by modifying the state file. If cooldown is active, inform the operator and provide the remaining wait time.
- **Do not move in-range positions.** If the position is already in the active bin range, report `IN_RANGE` and take no action. Moving an in-range position wastes gas for zero benefit.
- **Gas budget: 0.05 STX** estimated for one atomic transaction. If STX balance is below 1 STX, refuse to execute.
- **Atomic execution.** Uses `move-relative-liquidity-multi` — withdraw from old bins and deposit into new bins in a single on-chain call. Either all bins move or none do.
- **Contract-level slippage protection.** Each move requires ≥95% DLP shares back (`min-dlp`) and caps liquidity fees at 5% (`max-x-liquidity-fee`, `max-y-liquidity-fee`). The transaction reverts on-chain if either bound is violated.

## On error

- Log the full error payload from the JSON output.
- Do not retry automatically — surface the error to the operator with the specific failure reason.
- Common errors: wallet decryption failure, insufficient STX, pool not found, API timeout.
- If a broadcast fails, check the explorer for the transaction status before retrying.

## On success

- Report the transaction ID with explorer link.
- Confirm the new bin range and the bins that were moved.
- Note the cooldown timer: next move available after 4 hours.
- Suggest running `scan` again after the transaction confirms (~10-20 minutes) to verify the position is now in range.
