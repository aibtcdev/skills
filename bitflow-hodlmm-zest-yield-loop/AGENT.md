---
name: bitflow-hodlmm-zest-yield-loop-agent
skill: bitflow-hodlmm-zest-yield-loop
description: "Plans and runs HODLMM-Zest yield routes only through accepted primitive skill surfaces and saved checkpoints."
---

# Agent Behavior - Bitflow HODLMM-Zest Yield Loop

## Decision order

1. Run `doctor` first and inspect dependency, wallet, mempool, and checkpoint readiness.
2. Run `status` to read the current route posture.
3. Refuse a new route when unresolved checkpoint state exists.
4. Run `plan` with explicit `--source`, `--target`, amount, pool, and bin controls.
5. Inspect `economicCheck`, `freshness`, and `state`; do not treat a route as ready when either check reports blocked or missing reads.
6. Confirm route execution with the operator.
7. Run `run --confirm=ROUTE` only after the plan is acceptable.
8. Confirm each delegated write leg with that primitive's own confirmation token, persist the returned txid before Hiro polling, then require Hiro `tx_status=success` before marking the leg confirmed or advancing to the next leg.
9. If interrupted, run `resume --confirm=ROUTE` only from a supported saved checkpoint.

## Guardrails

- Never rebuild HODLMM deposit, HODLMM withdraw, or HODLMM move transaction internals in this controller.
- Never import source from another skill directory.
- Never proceed when a required primitive is missing, blocked, or returns invalid JSON.
- Never run a Zest write leg through a handoff payload, direct unconverted `suppliedShares`, or non-canonical market-contract read and call it proof.
- Never reject first-time HODLMM position creation solely because the wallet has no existing pool bins when the selected pool exists and exposes sBTC.
- Never add dependency skills beyond the #559 PRD without a PRD update.
- Never proceed without explicit `--confirm=ROUTE` for write execution.
- Never mark any leg as confirmed without a txid that verifies as `tx_status=success` on Hiro. If Hiro confirmation is interrupted after broadcast, resume from the saved txid instead of rebroadcasting.
- Never ignore `economicCheck`, `freshness`, or unresolved `state` fields in plan/status output.
- Never ignore unresolved saved state.
- Never expose secrets, private keys, mnemonics, passwords, or raw session payloads.
- Never describe this as a borrow, leverage, repay, or unwind skill.

## On error

- Parse the JSON error payload.
- If a checkpoint exists, surface the current checkpoint and next action.
- Do not retry silently.
- Do not start a new route over unresolved state.

## On success

- Report each primitive command result.
- Report transaction hashes returned by each primitive.
- Report final saved route state.
- Route any remaining Zest-write blocker to the operator instead of assuming completion.
