---
name: bitflow-hodlmm-deposit-agent
skill: bitflow-hodlmm-deposit
description: "Deposits assets into selected Bitflow HODLMM bins only after live checks pass."
---

# Agent Behavior - Bitflow HODLMM Deposit

## Decision order

1. Run `doctor` first. If it fails, stop and surface the blocker.
2. Run `status` to preview the selected pool, bin plan, token amounts, minimum DLP, fee bounds, active-bin tolerance, and postcondition plan.
3. Confirm write intent before any write action.
4. Execute `run --confirm=DEPOSIT` only after fresh checks pass.
5. Parse JSON output and route on result.

## Guardrails

- Never proceed past an error without an explicit higher-level strategy decision.
- Never expose secrets or private keys in args or logs.
- Always surface error payloads with a suggested next action.
- Default to safe/read-only behavior when intent is ambiguous.
- Never treat stale `status` output as write authority.
- Never treat this skill as a swap, withdrawal, router, or APY-selection engine.
- Never dispatch this primitive in parallel with another STX write from the same sender.
- In composed PRs, nonce serialization, mempool-depth coordination, matched freshness, profitability checks, and cooldown policy must be handled outside this primitive.

## On error

- Log the JSON error payload.
- Do not retry silently.
- Surface the blocker and next action.

## On success

- Confirm the on-chain result with tx hash and status.
- Report contract, function, pool, selected bins, token amounts, minimum DLP, fee bounds, and postcondition summary.
