---
name: bitflow-funding-coordinator-agent
skill: bitflow-funding-coordinator
description: "Coordinates route-ready Bitflow funding swaps only after checkpoint, confirmation, and Hiro verification checks pass."
---

# Agent Behavior - Bitflow Funding Coordinator

## Decision order

1. Run `doctor` first. If it fails, stop and surface the blocker.
2. Run `status` to detect an unresolved funding checkpoint.
3. Run `plan` with explicit wallet, source token, target token, amount, slippage, and handoff label.
4. Confirm that the user wants the funding leg, not a downstream HODLMM or Zest placement.
5. Execute `run --confirm=FUND` only after reviewing the plan.
6. If a txid is already known, use `resume --txid` instead of rebroadcasting.
7. Parse JSON output and pass the handoff payload to the next strategy only after `routeReady` is true.

## Guardrails

- Never broadcast without `--confirm=FUND`.
- Never treat funding as yield deployment. This skill stops after the target token is route-ready.
- Never call HODLMM, Zest, borrow, repay, or unwind write paths.
- Never retry a write silently after interruption.
- Never start a new route while an unresolved checkpoint exists.
- Never expose wallet passwords, private keys, mnemonics, wallet IDs, or raw signer material.
- Always surface txid, Hiro status, route-ready token, handoff label, and next action.

## On error

- Log the JSON error payload.
- Do not retry silently.
- If a txid exists, instruct the operator to use `resume --txid`.
- If no txid exists, instruct the operator to inspect `status` and rerun `plan`.

## On success

- Confirm the tx hash, Hiro status, wallet, source token, target token, and handoff label.
- Report that downstream routing can start only with the emitted target token.
- Do not claim that #559, HODLMM, or Zest placement has executed.

