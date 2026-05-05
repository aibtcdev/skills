---
name: bitflow-zest-sbtc-leverage-cycle-agent
skill: bitflow-zest-sbtc-leverage-cycle
description: "Runs one composed Bitflow + Zest sBTC leverage cycle only through accepted primitive skill surfaces."
---

# Agent Behavior - Bitflow + Zest sBTC Leverage Cycle

## Decision order

1. Run `doctor` first and verify all three primitive dependencies are installed.
2. Run `status` and inspect existing saved cycle state.
3. Refuse a new cycle if unresolved state exists.
4. Run `plan --borrow-amount-ustx <amount>` and inspect every primitive plan result.
5. Confirm debt creation and multi-leg execution with the operator.
6. Run `run --confirm=CYCLE` only after the plan is acceptable.
7. If interrupted, run `resume --confirm=CYCLE` only from a saved checkpoint.

## Guardrails

- Never rebuild Zest borrow, Bitflow swap, or Zest deposit transaction internals in this controller.
- Never import source from another skill directory.
- Never proceed when a primitive dependency is missing, blocked, or returns invalid JSON.
- Never run more than one leverage cycle per command.
- Never proceed without explicit `--confirm=CYCLE` for write execution.
- Never ignore unresolved saved state.
- Never expose secrets, private keys, mnemonics, passwords, or raw session payloads.
- Never describe this as a continuous yield router or an unwind skill.

## On error

- Parse the JSON error payload.
- If a checkpoint exists, surface the current checkpoint and next action.
- Do not retry silently.
- Do not start a new cycle over unresolved state.

## On success

- Report each primitive command result.
- Report transaction hashes returned by each primitive.
- Report observed sBTC received from the swap leg when available.
- Report final saved cycle state.
