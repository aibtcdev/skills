---
name: hodlmm-range-keeper-agent
skill: hodlmm-range-keeper
description: "Agent behavior rules for the HODLMM Range Keeper — active position management skill."
---

# Agent Behavior — HODLMM Range Keeper

## Decision order
1. Run `doctor` to verify wallet, HODLMM API access, and MCP tool availability.
2. Run `status` to assess all positions: drift, range efficiency, fee accrual.
3. If any position shows `needsRecenter: true`:
   a. Run `plan --pool <id>` to preview the re-center.
   b. Confirm the plan is profitable and safe.
   c. Run `recenter --pool <id> --confirm` to execute.
4. If no positions need re-centering, report status and skip.
5. For fully autonomous operation, use `run --confirm` which handles all steps internally.

## Guardrails
- **NEVER recenter without --confirm.** The flag is a safety gate on real fund movement.
- **NEVER force a recenter** (`--force`) unless drift is critical and the user explicitly approves.
- **NEVER recenter during cooldown.** The 30-minute cooldown prevents churn and excessive gas burn.
- **NEVER proceed past a `blocked` status** without explicit user confirmation.
- **ALWAYS run `status` or `plan` before `recenter`** to understand current drift and expected outcome.
- **ALWAYS verify gas sufficiency** — the skill checks STX balance but the agent should surface low-gas warnings proactively.
- **ALWAYS preserve fee baselines** — never manually edit `~/.hodlmm-range-keeper.json`.
- Never expose secrets or private keys in args or logs.

## Autonomous scheduling
```
1. Cron runs `run` every 15 minutes (dry-run)
2. If any pool shows needsRecenter: true → run `run --confirm`
3. On partial failure (withdraw succeeds, deposit fails) → alert user, do NOT retry automatically
4. Run `history` daily to audit recenter activity
```

## Re-center strategy
The skill re-centers by:
1. Withdrawing all liquidity from current bins
2. Separating fee growth from principal (fees are harvested/kept)
3. Re-depositing principal into bins centered on the current active bin (+/- 2 bins = 5 bins total)
4. Recording new baselines for the fresh position

## Risk management
- **Drift < 3 bins**: No action. Position is earning normally.
- **Drift 3-5 bins**: Standard recenter. Most common scenario.
- **Drift > 5 bins**: High urgency — position is mostly idle. Execute promptly.
- **Range efficiency < 20%**: Emergency recenter even if drift is below threshold.
- **Cooldown active**: Wait. Do not bypass.
- **Gas > 50 STX**: Do not execute. Flag as anomalous.

## On error
- Log the error payload with pool ID and drift context
- Do not retry recenter silently — each attempt costs gas
- On "blocked": read the error, it explains the specific blocker
- On partial failure (withdraw ok, deposit failed): funds are in wallet, not lost. Alert user.

## On success
- Confirm old center, new center, drift corrected, bins re-deployed
- Report fees harvested vs. principal re-deployed
- Log MCP tool calls and expected tx results for audit trail
- Update state file with new baselines

## Integration with other skills
- Compose with `hodlmm-liquidity-tide` for timing signals — if tide is FALLING, defer non-urgent recenters
- Compose with `hodlmm-fee-harvester` for fee tracking — range-keeper handles its own baselines but fee-harvester provides deeper per-bin analysis
- After recenter, positions appear as new deposits to other skills
