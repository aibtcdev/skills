---
title: Bitflow HODLMM + Zest sBTC Yield Loop
description: Route idle sBTC into a HODLMM DLMM LP position and an offsetting Zest borrow, capturing yield on both sides with breakeven and APY-edge safety gates.
skills: [wallet, signing, settings, bitflow-swap-aggregator, zest-borrow-asset-primitive, bitflow-hodlmm-zest-yield-loop]
estimated-steps: 6
order: 25
---

# Bitflow HODLMM + Zest sBTC Yield Loop

This guide composes a sBTC yield loop on mainnet by combining a Bitflow HODLMM DLMM liquidity-provision leg with a Zest borrow against the resulting LP position. The result captures DLMM fee APY on the LP side and offsets the borrow cost via the borrowed-asset's own deployment, only when the live APY edge clears the configured minimum and breakeven gates.

The controller never opens a yield loop on stale data. It re-fetches HODLMM pool metrics and Zest borrow APY immediately before broadcast, refuses to proceed if either reading is older than the freshness window, and refuses to proceed if the projected APY edge is below the configured minimum or below breakeven (gas + fees + slippage).

All operations are mainnet-only. Write operations require an unlocked wallet. Every write leg passes through `--confirm ROUTE` and the underlying primitive's confirm gate.

## Prerequisites

- [ ] Wallet unlocked on mainnet (`NETWORK=mainnet`)
- [ ] sBTC balance above your chosen deployment threshold (default min: 50,000 sats)
- [ ] STX gas reserve above 200,000 uSTX (allow ~70,000 uSTX per write leg × up to 3 legs)
- [ ] Either: a target HODLMM DLMM pool ID, OR omit `--pool-id` to auto-pick the highest-APR sBTC-paired DLMM pool from live Bitflow API
- [ ] Min APY edge configured (default: 50 bps over Zest borrow rate, controlled via `--min-apy-edge-bps`)
- [ ] Max data age configured (default freshness window: 30 seconds, controlled via `--max-data-age-seconds`)
- [ ] No pending STX transactions from the sender in the mempool

## Steps

### 1. Preflight — Doctor

```bash
NETWORK=mainnet bun run wallet/wallet.ts doctor

NETWORK=mainnet bun run bitflow-swap-aggregator/bitflow-swap-aggregator.ts doctor

NETWORK=mainnet bun run zest-borrow-asset-primitive/zest-borrow-asset-primitive.ts doctor --wallet <your-stacks-address>

NETWORK=mainnet bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts doctor \
  --wallet <your-stacks-address>
```

Expected output: each skill returns `"status": "success"`. The yield-loop controller's doctor reports the discovered DLMM pool universe and the current best-APR pool when `--pool-id` is omitted.

### 2. Read State — Live Pool Metrics + Zest APY

The controller's `economicCheck.liveGate` enforces freshness: both APY reads must be timestamped within the configured `--max-data-age-seconds` window of each other (default 30s).

```bash
NETWORK=mainnet bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts status \
  --wallet <your-stacks-address> \
  --pool-id <pool-id-or-omit-for-auto>
```

Expected output: `pool` (DLMM pool selected, with live APR/TVL/fee data from Bitflow `/api/app/v1/pools`), `borrowAsset` (Zest borrow APY for the offsetting leg), `economicCheck.liveGate` (with read-timestamp + freshness-pass fields), `walletBalance.sbtcSats`.

If `economicCheck.liveGate` reports any of the blocking conditions — `STALE_POOL_DATA`, `MIN_APY_EDGE_NOT_MET`, or `BELOW_BREAKEVEN` — the controller refuses to plan or run a route on this pool right now. Either wait for conditions to change, retry to refresh data, or pick a different pool.

### 3. Plan the Route

Generate the read-only execution plan. The plan re-checks pool freshness and the APY-edge gate; it refuses to emit a runnable plan if either fails.

```bash
NETWORK=mainnet bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts plan \
  --wallet <your-stacks-address> \
  --source idle \
  --target hodlmm \
  --pool-id <pool-id-or-omit> \
  --amount-sats <sbtc-deploy-amount>
```

Expected output: `routeId`, ordered `route.legs[]` (typically deposit-then-borrow), `economicCheck.apyEdgeBps`, `economicCheck.gasEstimateStatus` (one of `controller_baseline_with_primitive_authoritative` or `delegated_to_primitives`), `economicCheck.liveGate.status`.

> Note: Pool APY changes block-by-block. The plan output's freshness clock is set by `--max-data-age-seconds` (default 30s). If you wait longer than that before `run`, re-run `plan` first.

### 4. Execute the Route

Run the planned route with explicit confirmation. Each leg waits for confirmation before the next is broadcast.

```bash
NETWORK=mainnet bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts run \
  --wallet <your-stacks-address> \
  --source idle \
  --target hodlmm \
  --pool-id <pool-id-or-omit> \
  --amount-sats <sbtc-deploy-amount> \
  --confirm ROUTE
```

Expected output: a per-leg result with `txid` and `primitiveResult`, plus a final completion state and a checkpoint at `~/.aibtc/state/bitflow-hodlmm-zest-yield-loop/<routeId>.json`.

> Note: If any leg fails, the controller halts and persists `state: blocked_partial_route` in the checkpoint. Resume; do **not** re-run `run`.

### 5. Resume on Failure (Conditional)

If Step 4 was interrupted before completion, resume from the checkpoint. Resume requires both the confirmation token AND a `--txid` if a primitive transaction has been broadcast and observed.

```bash
NETWORK=mainnet bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts resume \
  --wallet <your-stacks-address> \
  --txid <observed-txid> \
  --confirm ROUTE
```

Expected output: re-reads on-chain status of the supplied txid, validates against the checkpoint, and advances state from the first unresolved leg. Will not re-broadcast a leg whose recorded txid shows `tx_status: success`.

### 6. Verify and Cooldown

Re-read the route position post-execution to confirm the legs settled.

```bash
NETWORK=mainnet bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts status \
  --wallet <your-stacks-address>
```

Expected output: `position.hodlmmLp` reflects the deployed sBTC; `position.zestDebt` reflects the offsetting borrow; `economicCheck.realizedApyEdgeBps` close to the value projected in Step 3.

Apply a 1-hour cross-protocol meta-cooldown before running this workflow again on the same wallet.

## Verification

At the end of this workflow, verify:

- [ ] All `doctor` checks (Step 1) returned success
- [ ] `economicCheck.liveGate` (Step 2) reported no `STALE_POOL_DATA` / `MIN_APY_EDGE_NOT_MET` / `BELOW_BREAKEVEN` blocks
- [ ] `economicCheck.apyEdgeBps` met or exceeded the configured min and breakeven held
- [ ] All legs in Step 4 returned `tx_status: success`
- [ ] Post-route status (Step 6) shows both LP position and offsetting borrow settled
- [ ] Checkpoint at `~/.aibtc/state/bitflow-hodlmm-zest-yield-loop/<routeId>.json` shows route completion (no `blocked_partial_route`)
- [ ] 1-hour meta-cooldown noted for next execution on this wallet

## Safety Contract

| Guard | Rule |
|-------|------|
| Confirm gate | Top-level `--confirm ROUTE`; each primitive's own confirm gate also passed |
| Freshness window | `--max-data-age-seconds` (default 30s) between APY reads; staleness blocks plan and run |
| Min APY edge | Default 50 bps over Zest borrow APY; configurable via `--min-apy-edge-bps`; route refuses if edge falls below |
| Breakeven gate | Route refuses if projected gross APY edge does not cover gas + fees + slippage |
| Pool universe | DLMM-classified pools only (`types.includes("DLMM")`); auto-pick best-APR sBTC-paired DLMM pool when `--pool-id` omitted |
| Mempool depth | Pre-flight check before every write leg via `--mempool-depth-limit` |
| Nonce serialization | Each leg waits for the prior's confirmation; no concurrent broadcasts |
| PostConditionMode | `Deny` on every write leg via the underlying primitive |
| Cooldown | 1-hour meta-cooldown after a complete run on the same wallet |
| No blind retries | Failed/pending/unknown statuses do not auto-retry; use `resume --txid <observed-txid> --confirm ROUTE` |

## Related Skills

| Skill | Used For |
|-------|---------|
| `wallet` | Wallet unlock for transaction signing |
| `signing` | Transaction signing primitive |
| `settings` | Read network config and gas defaults |
| `bitflow-swap-aggregator` | Optional swap leg between deposit asset and borrow-collateral asset |
| `zest-borrow-asset-primitive` | Offsetting Zest borrow leg |
| `bitflow-hodlmm-zest-yield-loop` | Top-level controller — direct HODLMM DLMM deposit + leg orchestration |

## See Also

- [HODLMM Yield Router](./hodlmm-yield-router.md)
- [Bitflow + Zest sBTC Leverage Cycle](./bitflow-zest-sbtc-leverage-cycle.md)
- [Swap Tokens](./swap-tokens.md)
