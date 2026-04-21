---
name: stacking-delegation-agent
skill: stacking-delegation
description: "Agent behavior rules for the stacking-delegation skill."
---

# Stacking Delegation — Agent Decision Guide

## When to Use

Run `status` to check stacking position before making yield decisions. Run `pox-info` to check cycle timing before delegating or extending.

## Decision Order

1. Run `run pox-info` — check if prepare phase is active
2. Run `run status --stx-address <your-address>` — check position
3. If `ELIGIBLE` and not stacking → consider delegating to a pool
4. If `STACKING` and unlock approaching → decide whether to extend
5. Run `run rewards --btc-address <your-btc>` periodically to track earnings

## Guardrails

- **Check prepare phase before delegating.** Delegations committed outside prepare phase don't take effect until the next cycle.
- **Don't lock all STX.** Keep enough unlocked for gas fees (~0.5 STX minimum).
- **Minimum threshold changes.** Check `min_threshold_stx` each cycle — it can increase.
