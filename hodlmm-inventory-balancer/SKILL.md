---
name: hodlmm-inventory-balancer
description: "Detects HODLMM LP inventory drift (token-ratio imbalance from one-sided swap flow) and restores the target ratio via a corrective Bitflow swap plus a hodlmm-move-liquidity redeploy, gated by the 4h per-pool cooldown."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk — Agent #77"
  user-invocable: "false"
  arguments: "install-packs | doctor | status | recommend | run | reset-marker"
  entry: "hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts"
  requires: "wallet, signing, settings, bitflow, hodlmm-bin-guardian, hodlmm-move-liquidity"
  tags: "defi, write, mainnet-only, requires-funds"
---

# HODLMM Inventory Balancer

## What it does

Detects **inventory drift** — the silent token-ratio imbalance that builds up in a HODLMM LP position when swap flow repeatedly drains one side of the pair even while the active bin holds its price. Computes a **price-weighted** exposure ratio across every user bin (price × liquidity share, not raw token counts, handling bins below/at/above the active bin correctly), compares it to an operator-configured target (default 50:50), and when the absolute deviation exceeds `--min-drift-pct` (default 5%) executes a corrective swap via the Bitflow SDK and a redeploy via `hodlmm-move-liquidity run --confirm`.

## Why agents need it

Without this skill an agent that wanted symmetric sBTC/STX exposure ends up directionally pulled by swap flow — 70/30 instead of 50/50 — while still appearing "in range." Symmetric-exposure management is what separates a real market maker from a passive directional position-taker. This skill closes the gap `hodlmm-move-liquidity` doesn't: it fixes *inventory* drift where move-liquidity only fixes *price* drift.

## Safety notes

- **Writes to chain.** Executes a Bitflow swap and (unless `--skip-redeploy`) an atomic bin-to-bin redeploy via `hodlmm-move-liquidity` CLI (which itself calls the DLMM router's multi-move family). Mainnet only. Proven end-to-end on `dlmm_1` across 2 full cycles: swap `cd71c8a5…` + redeploy `0349cbb0…`, then swap `134df5e1…` + redeploy `9cbe5903…`.
- **`run` requires `--confirm=BALANCE`.** Without it, the command exits with the computed plan in dry-run form.
- **JingSwap explicitly excluded in v1** — unaudited. Only pools whose pair is tradeable via Bitflow are eligible.
- **Min drift threshold** `--min-drift-pct` default 5%. Below that, no-op. Avoids thrashing on noise.
- **Max correction size** `--max-correction-sats` caps a single balancing swap. Prevents an outsized correction during extreme flow events.
- **Bitflow quote staleness gate** `--max-quote-staleness-seconds` default 45s (one full 15–19s pipeline cycle of margin on top of freshness floor).
- **Explicit slippage** — every corrective swap sends `minimum-output` computed from a slippage budget. Default 0.5%, overridable via env var `INVENTORY_BALANCER_SLIPPAGE_BPS` (integer bps) or `--slippage-bps` flag.
- **4-hour per-pool cooldown gate.** The skill reads `~/.hodlmm-move-liquidity-state.json` and refuses to start a cycle that would have the redeploy step blocked (unless `--skip-redeploy` is passed, in which case the swap-only correction still writes a state marker for later redeploy resumption).
- **Meta-cooldown** 1 hour across the balancer itself to prevent re-correcting inside the same swap-flow event.
- **Post-conditions**: `PostConditionMode.Allow` with a **dual-pin envelope** on every chain-writing leg. Each leg is sided per-token (skip the asset whose total is 0) and routes STX vs FT through `resolveTokenAsset()` so the two codepaths cannot drift apart.
  - **Corrective swap (default + 3-leg leg 2)** — mirrors the canonical `swap-simple-multi` pattern: `Pc.principal(sender).willSendLte(amount_in)` on the input token + `Pc.principal(pool.pool_contract).willSendGte(min_out)` on the output token. `min_out` is the same value passed to the router's `min-received` uint argument (`ERR_MINIMUM_RECEIVED` fires internally if undersold). Live proof tx [`0xf4f49328…`](https://explorer.hiro.so/txid/0xf4f4932800a80234845a8d199556ad9c0ff4aa99874a95c819c13779b164cbc8?chain=mainnet): `post_condition_mode: allow`, 2 post-conditions (sender `lte 6,468 sbtc-token` + pool `gte 4,993,915 usdcx-token`), 2 `fungible_token_asset` events, `tx_status: success`.
  - **3-leg withdraw-slice (leg 1)** — three-pin envelope: `Pc.principal(sender).willSendLte(total_shares).ft(pool.pool_contract, 'pool-token')` (DLP burn cap) + `Pc.principal(pool.pool_contract).willSendGte(total_min_x_raw)` + `…willSendGte(total_min_y_raw)` (X/Y receive floors). Asset name `pool-token` verified live on tx [`0x89315a8b…`](https://explorer.hiro.so/txid/0x89315a8b935b3e4db32ad753b77af4bf853f28dc5b04ca6aa25d7cca9fc1cf8a?chain=mainnet) burn event; uniform across all DLMM pools (single template deployer). These pins ride alongside the contract-level aggregate `min-x-amount-total` / `min-y-amount-total` floors and per-bin `min-x` / `min-y` on each position tuple — four-layer safety envelope on a single tx.
  - **3-leg redeposit (leg 3)** — wallet-level send caps on the sender: `Pc.principal(sender).willSendLte(total_x_raw × 1.05)` + `…willSendLte(total_y_raw × 1.05)`. The 5% headroom matches the per-tuple `max-(x|y)-liquidity-fee` ceiling in the function args.
  - Allow mode (vs Deny + per-fee enumeration) preserved because per-bin `bin-liquidity-fee` accruals and protocol fees route inside `dlmm-core`'s `unclaimed-protocol-fees` map / bin balances and don't always emit FT transfer events.
  - Default-mode redeploy (the `hodlmm-move-liquidity` CLI invocation) inherits its own contract-level slippage (`max-liquidity-fee` ≤ 5%; `min-dlp` handled upstream with bin-price-aware semantics).
- **Wallet-balance precondition**: the corrective swap transfers the over-weight token **from the sender's wallet**, so the operator must hold a free balance of that token. If all of the over-weight side is locked inside LP bins, the agent either tops up externally or withdraws a slice from the position first (outside this skill's v1 scope).
- **Refusal conditions** (enumerated in AGENT.md): pool volume too thin for corrective swap, Bitflow quote staleness exceeds gate, previous-cycle state marker unresolved, wallet gas reserve below floor, wallet balance of input token below required amount, move-liquidity cooldown active and `--skip-redeploy` not passed.

## Commands

### install-packs

Installs the Stacks SDK packages the executor needs. Idempotent.

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts install-packs
```

### doctor

Pre-flight: wallet readable, Bitflow App + Quotes APIs reachable, at least one HODLMM pool with a user position, move-liquidity cooldown status surfaced as minutes remaining, prior state-marker inspected for unresolved cycles, wallet STX gas reserve sufficient.

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts doctor
```

### status

Read-only. Per eligible pool: current effective token ratio, target ratio, absolute deviation, active bin, cooldown minutes remaining, last cycle outcome from the state marker.

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts status [--pool <id>]
```

### recommend

Dry-run of the full cycle: computes the corrective swap plan (direction, `amount_in`, `minimum_out`) and the redeploy plan (via `hodlmm-move-liquidity` CLI `--dry-run`). Prints JSON without broadcasting. Useful as a pre-check before `run`.

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts recommend [--pool <id>] [--target-ratio 50:50] [--min-drift-pct 5]
```

### run

Core execution. Requires `--confirm=BALANCE` (the word `BALANCE`, not just any value). Without it, behaves like `recommend`. Full cycle: cooldown check → corrective swap → state marker → redeploy → state marker cleared. If `--skip-redeploy` is passed, executes the swap only and leaves a `swap_done_redeploy_pending` marker so a later run picks up from the redeploy step without re-swapping.

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts run \
  --confirm=BALANCE \
  [--pool <id>] \
  [--target-ratio 50:50] \
  [--min-drift-pct 5] \
  [--max-correction-sats 500000] \
  [--max-quote-staleness-seconds 45] \
  [--slippage-bps 50] \
  [--skip-redeploy] \
  [--force-direction "X->Y" | "Y->X"] \
  [--force-amount-in-raw <n>] \
  [--allow-rebalance-withdraw] \
  [--max-slice-bps <0..8000>]
```

Wallet password is read from the `WALLET_PASSWORD` env var. There is no `--password` CLI flag by design — an argv entry would surface in `/proc/<pid>/cmdline` and `ps auxww` for the process lifetime (same exposure class @arc0btc/@diegomey flagged on the child-process invocation of `hodlmm-move-liquidity`).

### Opt-in 3-leg mode: `--allow-rebalance-withdraw`

v1's swap + `move-liquidity-multi` redeploy is value-conserving and bin-to-bin — it cannot convert one LP side into the other when a position is sprawled. Setting `--allow-rebalance-withdraw` on `run` switches the executor to a 3-tx flow:

1. **Withdraw-slice** — `dlmm-liquidity-router-v-1-1.withdraw-relative-liquidity-same-multi`. Picks the largest overweight bin, withdraws a share fraction sized to shift `|current − target| × total_value` back to wallet (capped at `--max-slice-bps`, default 80%).
2. **Corrective swap** — same `swap-simple-multi` path as the default mode, sized to convert 100% of the withdraw proceeds to the underweight token.
3. **Redeposit** — `dlmm-liquidity-router-v-1-1.add-relative-liquidity-same-multi` at active ± 1 bin, placing the swap output on the underweight side (X above active, Y below). `active-bin-tolerance` is `noneCV()` — a tolerance value would race-abort with `ERR_ACTIVE_BIN_TOLERANCE (u5008)` on the resume path where the broadcast-to-inclusion gap can be hours, and on high-volume pools the active bin can move arbitrarily far in that window. Wallet-side bounds (per-bin x/y-amount, max-liquidity-fee at 5%, min-dlp ≥ 1) preserve fund safety.

The redeposit *replaces* the move-liquidity CLI invocation in this path — the 3-leg flow IS the redeploy. Use default mode (swap + move-liquidity recenter) for in-range small-drift corrections; use `--allow-rebalance-withdraw` when the position is sprawled or the deviation is too large for the swap alone.

**Resume on partial failure.** If a 3-leg cycle is interrupted between legs (process killed, network blip, gas shortfall mid-cycle), the state file captures `last_cycle_status` plus a `rebalance_pending_details` snapshot of the swap + redeposit plans at the moment leg 1 succeeds. Re-running `run --pool <id> --allow-rebalance-withdraw --confirm BALANCE` picks up where the prior cycle stopped:

- `withdraw_done_swap_pending` → verifies the withdraw landed `success` on-chain via `probeTxStatus`, then broadcasts legs 2 + 3 from the snapshot.
- `withdraw_done_swap_done_redeposit_pending` → verifies the swap landed `success`, then broadcasts leg 3 from the snapshot.

If the prior tx aborted (status ≠ `success`), the resume is refused and the operator is pointed at the explorer + `reset-marker`. If the snapshot is missing (state file from before this fix shipped, or manually edited), the resume is also refused with the same `reset-marker` hint — the planner re-plans against the current ratio after the marker is cleared.

`--force-direction` + `--force-amount-in-raw` are an operator escape hatch for cases the planner refuses (e.g. wallet holds the under-weight side while the over-weight side is fully in the LP). Both flags must be supplied together.

### reset-marker

Operator escape hatch for stuck cycles. Clears the per-pool entry from `~/.hodlmm-inventory-balancer-state.json` so the next `run` starts fresh and re-plans against the current ratio. Use when:

- A 3-leg `rebalance_pending_details` snapshot is missing (legacy marker from a pre-fix state file)
- A prior leg's tx aborted on-chain and the operator wants to abandon the resume rather than chase it
- The state entry is corrupted (manual edit, partial write)

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts reset-marker --pool <id> --confirm
```

`--confirm` is required (irreversible). On success, returns the cleared entry in `data.cleared` so the operator has a record of what was discarded.

## Output contract

Every command emits a single-line JSON object to stdout:

```json
{ "status": "success" | "error" | "blocked", "action": "run" | "recommend" | ..., "data": { }, "error": null }
```

The `data` object on a successful `run` includes:

- `pool_id`, `pair`
- `ratio_before`, `ratio_after`, `target_ratio`, `deviation_before`, `deviation_after`
- `swap`: `{ direction, amount_in, minimum_out, tx_id, explorer }`
- `redeploy`: `{ tx_id, explorer }` (null when `--skip-redeploy`)
- `state_marker`: `{ path, status }`

Errors are `{ "error": "message" }`, never a raw stack trace.

## Known constraints

- Mainnet only. No testnet fallback.
- Pools must be tradeable on Bitflow SDK in v1. JingSwap-only pairs excluded.
- Pool state reads have a ~15–19s Bitflow pipeline freshness floor — quote-staleness gate defaults to 45s accordingly.
- Redeploy cadence is bounded by `hodlmm-move-liquidity`'s 4h per-pool cooldown regardless of drift magnitude.
- Bins strictly below the active price hold only Y; strictly above hold only X. The ratio computer handles this asymmetry; do not naively sum raw reserves.
- **Tempo characteristic.** The heavy ratio correction happens in the first cycle on a sprawled/drifted position — cycle 1 of the live proof moved the position from 14.58 % X / 85.42 % Y (221 bins spread 460–680) to 27.05 % X / 72.95 % Y (13 bins concentrated 617–627). A second cycle on an already-concentrated position produces minimal further ratio movement because the downstream `move-liquidity-multi` is bin-to-bin and does not deposit newly-swapped wallet tokens into the LP. Meaningful second-cycle correction would require a withdraw-all → swap-to-target → redeposit flow, which is v2 scope.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @cliqueengagements
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/494
