---
name: bitflow-hodlmm-withdraw-agent
skill: bitflow-hodlmm-withdraw
description: "Agent powered Withdrawls from Bitflow's HOLDMM. Remove Liquidity."
---

# Agent Behavior - Bitflow HODLMM Withdraw

## Decision order

1. Run `doctor` first. If it returns `blocked` or `error`, stop and surface the blocker.
2. Run `status --wallet <address> --pool-id <pool>` to preview `withdrawableBins`, `selectedBins`, aggregate `totals`, and available selection modes.
3. Decide withdrawal scope from strategy:
   - no selector or `--all-bins` for full selected-pool exit,
   - `--bin-ids` for a strategy-selected subset,
   - `--bin-id` for a surgical single-bin withdrawal.
4. Confirm that the user intends to withdraw HODLMM liquidity. Do not treat this as an earnings-only claim.
5. Before any write, confirm no active pending STX transaction exists for the sender.
6. Ensure the AIBTC wallet is already unlocked for autonomous execution, or that the runtime provides an approved signer fallback.
7. Execute `run --confirm=EXIT` after the strategy has selected scope and accepted the fresh safety checks.
8. Parse the JSON output. If a txid is returned, verify it with Hiro and report sender, contract, function, and status.

## Guardrails

- Never broadcast without `--confirm=EXIT`.
- Never print wallet passwords, private keys, seed phrases, or raw signing material.
- Prefer the active/restored AIBTC wallet session. Do not require a password on every loop iteration.
- Never use stale `status` output as write authority. `run` must re-read live pool, bin, balance, and mempool state.
- Never proceed if the selected bin no longer exists or the wallet no longer has enough bin liquidity.
- Never proceed if the pending transaction depth is nonzero.
- Never proceed if estimated minimum outputs are both zero.
- Default scope is all eligible bins at `--withdraw-bps 10000`; narrow the scope only when strategy requires it.
- Use the latest `status.withdrawableBins` index as the decision surface for any bin subset.
- Do not use `--amount` with multi-bin withdrawals; use `--withdraw-bps` across the selected scope.
- Surface any postcondition limitation clearly; do not hide it as a successful safety check.

## On error

- Surface the exact JSON error payload.
- Do not retry silently.
- Suggest the next concrete action: retry later, refresh status, lower amount, or resolve wallet/signing setup.

## On success

- Confirm the tx hash.
- Confirm Hiro `tx_status: success`.
- Confirm sender equals the caller wallet used for the proof run.
- Confirm contract/function matches the HODLMM withdrawal claim.
- Summarize the pool, selected bins, aggregate amount, and token outputs.
