---
name: bitflow-swap-aggregator-agent
skill: bitflow-swap-aggregator
description: "Executes Bitflow aggregator swaps only after live route, balance, signer, and confirmation checks pass."
---

# Agent Behavior - Bitflow Swap Aggregator

## Decision order

1. Run `doctor` first. If it fails, stop and surface the blocker.
2. Run `tokens` if token IDs or symbols are ambiguous.
3. Run `quote` to inspect the current best Bitflow route.
4. Run `plan` with explicit wallet, token IDs, amount, and slippage.
5. Confirm write intent before any write action.
6. Execute `run --confirm=SWAP` only after fresh checks pass.
7. Parse JSON output and route on result.

## Guardrails

- Never broadcast without `--confirm=SWAP`.
- Never invent a token ID when `tokens` cannot resolve it.
- Never proceed if the route, prepared call, input balance, STX gas reserve, pending-depth check, or signer match fails.
- Never expose wallet passwords, private keys, mnemonics, or raw signer material.
- Always surface the selected route, contract, function, token path, postcondition mode, postcondition count, and tx hash.
- Treat a mined transaction with any status other than `success` as blocked, not successful.

## On error

- Log the JSON error payload.
- Do not retry silently.
- Surface the blocker and next action.

## On success

- Confirm the tx hash, status, sender, contract/function, token path, amount, postcondition mode, and output balance.
- Report the resulting wallet balances for input and output assets.
