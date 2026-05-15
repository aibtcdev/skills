---
title: Bitflow Funding Coordinator
description: Acquire a target asset by swapping from a free wallet asset via Bitflow, with route discovery, quote freshness, and a recorded target-output handoff.
skills: [wallet, signing, settings, bitflow-swap-aggregator, nonce-manager, bitflow-funding-coordinator]
estimated-steps: 5
order: 26
---

# Bitflow Funding Coordinator

This guide acquires a target asset (for example, sBTC needed to seed a Zest deposit, or STX needed to repay debt) by routing a swap of a free wallet asset through `bitflow-swap-aggregator`. The coordinator chooses the best available route, holds the quote behind a freshness clock, persists a wallet-keyed checkpoint, and uses `nonce-manager` to serialize the funding write against any other in-flight transactions.

The coordinator is the "I need asset X to do Y" entry point — typically called before the leverage cycle, the unwind, the yield loop, or any other workflow that requires a specific asset balance the wallet does not currently hold.

All operations are mainnet-only. Write operations require an unlocked wallet. Every write leg passes through `--confirm FUND` and the `bitflow-swap-aggregator`'s own `--confirm SWAP` gate.

## Prerequisites

- [ ] Wallet unlocked on mainnet (`NETWORK=mainnet`)
- [ ] Free wallet balance of the source token above the swap amount
- [ ] STX gas reserve above 100,000 uSTX (single-leg swap)
- [ ] `--token-in` and `--token-out` known (use `bitflow get-tokens` to discover token IDs)
- [ ] No pending STX transactions from the sender in the mempool
- [ ] No unresolved funding checkpoint for this wallet (`status` returns `unresolvedCheckpoint: false`)

## Steps

### 1. Preflight — Doctor

```bash
NETWORK=mainnet bun run wallet/wallet.ts doctor

NETWORK=mainnet bun run bitflow-swap-aggregator/bitflow-swap-aggregator.ts doctor

NETWORK=mainnet bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts doctor \
  --wallet <your-stacks-address>
```

Expected output: each skill returns `"status": "success"`. The coordinator's doctor confirms `bitflow-swap-aggregator` is installed, `nonce-manager` is available, and reports any unresolved checkpoint blocking new funding writes.

### 2. Plan the Funding Swap

Generate the read-only execution plan. Fetches a fresh route quote from `bitflow-swap-aggregator` and projects the post-swap state.

```bash
NETWORK=mainnet bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts plan \
  --wallet <your-stacks-address> \
  --token-in STX \
  --token-out sBTC \
  --amount-in <decimal-source-amount> \
  --target-out <decimal-minimum-target>
```

Expected output: `routeId`, `nextRequiredAction: "Run funding swap with --confirm=FUND"`, `route` with quote details, the recorded `targetOut` handoff value, and projected gas.

> Note: `--target-out` is the operator's stated minimum desired output. In the v1 surface this value is **recorded for handoff**, not enforced as a hard floor — slippage protection is delegated to `--max-slippage-bps` (default tolerance applied by the aggregator). If you need a strict floor, set `--max-slippage-bps` to a tight bound and verify the swap aggregator's price-impact severity in its own quote output before running.

### 3. Execute the Swap

Run the planned funding swap with explicit confirmation.

```bash
NETWORK=mainnet bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts run \
  --wallet <your-stacks-address> \
  --token-in STX \
  --token-out sBTC \
  --amount-in <decimal-source-amount> \
  --target-out <decimal-minimum-target> \
  --confirm FUND
```

Expected output: a swap `txid`, the coordinator's checkpoint at `~/.aibtc/state/bitflow-funding-coordinator/<wallet>.json` (one file per wallet, not per route), `step` advancing to the post-confirmation state, and the `routeId` for cross-reference.

> Note: The coordinator's checkpoint is keyed by wallet address — only one funding operation per wallet at a time. If a prior funding operation is unresolved, the controller refuses with `UNRESOLVED_CHECKPOINT` until you `resume --txid <txid>` or `cancel`.

### 4. Resume on Failure (Conditional)

If Step 3 was interrupted before the swap landed (e.g. timeout during confirmation, network error), resume from the checkpoint. Resume requires `--txid <txid>` of the broadcast swap.

```bash
NETWORK=mainnet bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts resume \
  --wallet <your-stacks-address> \
  --txid <broadcast-swap-txid> \
  --confirm FUND
```

Expected output: re-reads on-chain status of the supplied txid against the checkpoint. Will not re-broadcast a leg whose recorded txid shows `tx_status: success`. The resume path runs three guards before accepting the txid:

- `RESUME_SENDER_MISMATCH` — the recorded txid's sender must match the configured `--wallet`
- `RESUME_TX_NOT_SWAP` — the recorded txid's contract function must be in the swap allowlist
- `RESUME_REQUIRES_TOKEN_OUT` — if no local checkpoint exists, the controller refuses to synthesize `tokenOut` from operator input alone

If any guard fires, the resume blocks with the corresponding code; do not blindly retry.

### 5. Verify Final Balance

Re-read the funding state and your wallet balance to confirm the target token arrived.

```bash
NETWORK=mainnet bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts status \
  --wallet <your-stacks-address>
```

Expected output: `checkpoint.step` reads `complete` (or `cancelled`); `unresolvedCheckpoint: false`; the recorded `routeId` and the on-chain status of any txid persisted by Step 3 or 4.

## Verification

At the end of this workflow, verify:

- [ ] All `doctor` checks (Step 1) returned success
- [ ] Plan output (Step 2) showed an acceptable route quote
- [ ] Run (Step 3) returned a `txid` and a `routeId`
- [ ] Wallet balance for `--token-out` increased by approximately the expected swap amount
- [ ] Status (Step 5) shows `unresolvedCheckpoint: false`

## Safety Contract

| Guard | Rule |
|-------|------|
| Confirm gate | Top-level `--confirm FUND`; `bitflow-swap-aggregator`'s own `--confirm SWAP` also passed |
| Quote freshness | Route quote re-fetched immediately before broadcast by the underlying aggregator |
| Slippage tolerance | Enforced via `--max-slippage-bps` (alias `--slippage-bps`); `--target-out` is recorded handoff metadata, not enforced as a floor in v1 |
| Mempool depth | Pre-flight check before broadcast via `--mempool-depth-limit` (default 0 = no pending sender txs allowed) |
| Nonce serialization | `nonce-manager` acquires/releases a nonce lease around the write; checkpoint persists `nonce` and `nonceState` |
| Sender match (resume) | `RESUME_SENDER_MISMATCH` blocks resume if the supplied txid's sender ≠ `--wallet` |
| Function allowlist (resume) | `RESUME_TX_NOT_SWAP` blocks resume if the supplied txid's contract function is not a known swap function |
| TokenOut synthesis (resume) | `RESUME_REQUIRES_TOKEN_OUT` blocks resume if no local checkpoint exists and operator has not supplied `--token-out` |
| Wallet-keyed checkpoint | One funding op per wallet; `UNRESOLVED_CHECKPOINT` blocks new run until resolved |
| PostConditionMode | `Deny` with explicit token-flow postconditions per the underlying swap aggregator |
| No blind retries | Failed/pending/unknown statuses do not auto-retry; use `resume --txid <txid> --confirm FUND` |

## Related Skills

| Skill | Used For |
|-------|---------|
| `wallet` | Wallet unlock for transaction signing |
| `signing` | Transaction signing primitive |
| `settings` | Read network config and gas defaults |
| `bitflow-swap-aggregator` | Underlying swap leg with route discovery, quote, slippage protection |
| `nonce-manager` | Nonce lease around the funding write to serialize against other in-flight transactions |
| `bitflow-funding-coordinator` | Top-level coordinator — wallet-keyed checkpoint, resume guards, route handoff |

## See Also

- [Swap Tokens](./swap-tokens.md)
- [Bitflow + Zest sBTC Leverage Cycle](./bitflow-zest-sbtc-leverage-cycle.md)
- [sBTC Leverage Position Unwind](./sbtc-leverage-unwind-planner.md)
