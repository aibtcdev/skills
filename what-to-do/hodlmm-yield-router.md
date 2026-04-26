---
title: HODLMM Yield Router
description: Route idle sBTC between HODLMM LP and Zest lending based on matched-freshness APY. No idle capital.
skills: [wallet, hodlmm-move-liquidity, hodlmm-flow, sbtc-yield-maximizer, zest-yield-manager]
estimated-steps: 6
order: 22
---

# HODLMM Yield Router

This guide orchestrates five skills — `wallet`, `hodlmm-move-liquidity`, `hodlmm-flow`, `sbtc-yield-maximizer`, and `zest-yield-manager` — into a complete no-idle-capital loop for sBTC. It reads bin state and live APY from both venues, decides where capital earns more, rebalances the HODLMM position if needed, and routes capital to the winning venue. All write legs go through each primitive's own `--confirm` gate; this guide does not bypass them.

All operations are mainnet-only. Write operations require an unlocked wallet.

## Prerequisites

- [ ] Wallet unlocked on mainnet (`NETWORK=mainnet`)
- [ ] sBTC balance above your chosen minimum threshold
- [ ] STX balance above gas reserve (50,000 uSTX minimum per write tx; allow 150,000 uSTX for a full rotation)
- [ ] Pool ID known (e.g. `dlmm_1` through `dlmm_8`; use `hodlmm-move-liquidity scan` to discover)
- [ ] No pending STX transactions from the sender address in the mempool

## Steps

### 1. Preflight — Doctor All Skills

Run the `doctor` subcommand on every skill used by this workflow. All must pass before proceeding.

```bash
NETWORK=mainnet bun run wallet/wallet.ts doctor

NETWORK=mainnet bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts doctor --wallet <your-stacks-address>

NETWORK=mainnet bun run hodlmm-flow/hodlmm-flow.ts doctor

NETWORK=mainnet bun run sbtc-yield-maximizer/sbtc-yield-maximizer.ts doctor

NETWORK=mainnet bun run zest-yield-manager/zest-yield-manager.ts doctor
```

Expected output: each skill returns `"status": "success"` or equivalent healthy state. If any skill returns an error, resolve it before continuing. Common issues: wallet locked, insufficient STX for gas, Pyth oracle unreachable (retry Zest doctor after 30s).

Also confirm your sBTC balance is above your minimum deployment threshold.

### 2. Read State — Matched-Freshness APY Fetch

Read HODLMM bin state and flow APY, then immediately read Zest APY. Both reads must be timestamped within 30 seconds of each other — **not just each read individually fresh, but the gap between them must be ≤ 30s**.

```bash
# Record start time before first read
HODLMM_READ_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

NETWORK=mainnet bun run hodlmm-flow/hodlmm-flow.ts flow --pool-id <pool-id>
```

Record `timestamp` from the `hodlmm-flow` output as `ts_hodlmm`.

```bash
# Immediately after — no delays between these two commands
NETWORK=mainnet bun run sbtc-yield-maximizer/sbtc-yield-maximizer.ts status
```

Record the read timestamp from the `sbtc-yield-maximizer` output as `ts_zest`.

**Staleness check (abort if either condition is true):**

- Either read is more than 30s old relative to wall clock now
- `|ts_zest - ts_hodlmm| > 30s`

If the staleness check fails, discard both reads and repeat from the top of this step. Do not carry stale data into the decision step.

**Key fields to extract:**

From `hodlmm-flow`: `metrics.binVelocity` (bins/hour), `verdict.rangeLifespanHours`, `verdict.lpSafety`, and the implicit fee APY available from `sbtc-yield-maximizer status` HODLMM candidate section.

From `sbtc-yield-maximizer status`: the winning route field and its APY, plus the top HODLMM candidate APY and the Zest lending APY.

### 3. Compare and Decide

Using the APY values from Step 2, apply the routing decision:

```
hodlmm_apy  = top HODLMM pool APY (from sbtc-yield-maximizer status)
zest_apy    = Zest sBTC lending APY (from sbtc-yield-maximizer status)
diff_bps    = (hodlmm_apy - zest_apy) * 10000
```

Positive `diff_bps` means HODLMM wins; negative means Zest wins.

Decision table:

| Condition | Target | Action |
|-----------|--------|--------|
| `abs(diff_bps) < 50` | No-op | APY gap is below the 50 bps minimum threshold. Hold current position. |
| `hodlmm_apy > zest_apy + 0.005` (i.e. diff ≥ 50 bps) | HODLMM | Route capital to HODLMM. Rebalance bins if drifted (Step 4), then route capital (Step 5). |
| `zest_apy > hodlmm_apy + 0.005` (i.e. diff ≥ 50 bps) | Zest | Route capital to Zest lending (Step 5). Skip Step 4. |

Also apply flow-safety check: if `verdict.lpSafety` from `hodlmm-flow` is `"unsafe"`, disqualify HODLMM as the winning venue regardless of APY. A toxic-flow pool should not receive new capital.

If the decision is no-op, skip to Step 6 (log and cooldown).

### 4. Rebalance Bins If Needed (HODLMM Target Only)

Skip this step if the target venue from Step 3 is Zest.

First scan for drift:

```bash
NETWORK=mainnet bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts scan --wallet <your-stacks-address>
```

Check `in_range` for your pool. If `"in_range": true`, your bins are already positioned — skip to Step 5.

If `"in_range": false` (drifted):

```bash
# Preview the move plan (no on-chain action)
NETWORK=mainnet bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts run \
  --wallet <your-stacks-address> \
  --pool <pool-id>
```

Review the dry-run output: confirm `"atomic": true`, check the new bin range and estimated gas. If the plan looks correct:

```bash
# Execute the atomic rebalance (one tx via move-relative-liquidity-multi)
# Set password via env var — avoids exposure in ps aux and shell history
export WALLET_PASSWORD="<your-wallet-password>"

NETWORK=mainnet bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts run \
  --wallet <your-stacks-address> \
  --pool <pool-id> \
  --confirm
```

Expected output: `"decision": "EXECUTED"` with a `transaction.txid`. If the response is `"decision": "IN_RANGE"`, bins are already centered — skip the confirmation tx and continue to Step 5.

> **Note on `run` in this step vs. Step 5 Path B:** Here, `run --confirm` rebalances bins via `move-relative-liquidity-multi` — capital stays in HODLMM, only the bin range shifts. In Step 5 Path B, the same `run` command triggers capital consolidation and withdrawal from the HODLMM pool entirely. The two operations are distinct: this step preserves position, Path B liquidates it.

> Note: This is the `move-relative-liquidity-multi` atomic path. Withdraw and deposit happen in one on-chain call — either both succeed or neither does. No nonce sequencing is required for this single leg.

If the skill returns `"status": "blocked"` with a cooldown message, the 4-hour per-pool cooldown is active. Either wait out the cooldown or treat this as a no-op and hold current position.

### 5. Route Capital

This step has two sub-paths based on the rotation direction. Each write leg checks the mempool first: abort if any pending STX transaction from the sender is detected. Nonces must be serialized between legs — do not broadcast the second transaction until the first is confirmed or confirmed absent from the mempool.

#### Path A: Rotate Zest → HODLMM

Capital is currently in Zest lending and should move to HODLMM LP.

**Leg 1 — Withdraw from Zest:**

```bash
NETWORK=mainnet bun run zest-yield-manager/zest-yield-manager.ts run \
  --action=withdraw \
  --amount=<amount-in-sats>
```

Wait for the withdrawal transaction to confirm (check `status: "success"` in output). Do not proceed to Leg 2 until Leg 1 is settled. Verify sBTC has returned to your wallet.

**Leg 2 — Deposit into HODLMM:**

With bins rebalanced in Step 4 and sBTC returned from Leg 1, your sBTC is sitting idle in the wallet — it must be explicitly deposited. Verify the withdrawal landed by confirming your sBTC balance increased, then run the deposit to supply the newly available capital:

```bash
NETWORK=mainnet bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts scan \
  --wallet <your-stacks-address>
```

Confirm `supplied_sats` is zero (capital has left Zest) and sBTC wallet balance reflects the withdrawal. Then supply to HODLMM:

```bash
NETWORK=mainnet bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts run \
  --wallet <your-stacks-address> \
  --pool <pool-id> \
  --confirm
```

Expected output: `"decision": "EXECUTED"` with a deposit `txid`.

#### Path B: Rotate HODLMM → Zest

Capital is currently in HODLMM LP and should move to Zest lending.

**Leg 1 — Consolidate/withdraw from HODLMM:**

> **Note:** This `run --confirm` call triggers capital consolidation (withdrawal mode), not bin rebalancing. Since Zest is the target and Step 4 was skipped, bins may or may not be in range — that is irrelevant here. The skill will consolidate liquidity and return sBTC to your wallet regardless of bin position. Expected output: `"decision": "WITHDRAWN"`. A response of `"decision": "IN_RANGE"` here means no capital was deployed in HODLMM — verify your position before proceeding.

```bash
# Set password via env var — avoids exposure in ps aux and shell history
export WALLET_PASSWORD="<your-wallet-password>"

NETWORK=mainnet bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts run \
  --wallet <your-stacks-address> \
  --pool <pool-id> \
  --confirm
```

Wait for the HODLMM transaction to confirm before proceeding. Verify sBTC balance has increased in your wallet.

**Leg 2 — Supply to Zest:**

```bash
NETWORK=mainnet bun run zest-yield-manager/zest-yield-manager.ts run \
  --action=supply \
  --amount=<amount-in-sats>
```

Expected output: `"status": "success"` with a `txid`.

#### No rotation needed

If capital is already in the winning venue, skip this step entirely and proceed to Step 6.

### 6. Verify and Cooldown

Read your position in the target venue to confirm the route succeeded.

**If target is HODLMM:**

```bash
NETWORK=mainnet bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts scan \
  --wallet <your-stacks-address>
```

Confirm `"in_range": true` for your pool.

**If target is Zest:**

```bash
NETWORK=mainnet bun run zest-yield-manager/zest-yield-manager.ts run --action=status
```

Confirm `supplied_sats` reflects the routed amount.

Emit a structured JSON log summarizing the routing decision:

```json
{
  "timestamp": "<ISO-8601>",
  "ts_hodlmm": "<read-timestamp-from-step-2>",
  "ts_zest": "<read-timestamp-from-step-2>",
  "hodlmm_apy": "<value>",
  "zest_apy": "<value>",
  "diff_bps": "<value>",
  "decision": "<HODLMM | ZEST | NO_OP>",
  "action_taken": "<description>",
  "txids": []
}
```

Apply the **1-hour cross-protocol meta-cooldown** before running this workflow again — on top of the 4-hour per-pool cooldown that `hodlmm-move-liquidity` enforces internally. Do not re-run this workflow within 1 hour of any write execution.

## Verification

At the end of this workflow, verify:

- [ ] All five `doctor` checks passed in Step 1
- [ ] Both APY reads were within 30s of each other (matched-freshness)
- [ ] Decision was based on a ≥ 50 bps gap, or no-op was correctly applied
- [ ] If bins were drifted, `hodlmm-move-liquidity run` returned `"decision": "EXECUTED"` or `"IN_RANGE"`
- [ ] All write legs used `--confirm` and completed with `"status": "success"`
- [ ] Nonces were serialized — second leg not broadcast until first confirmed
- [ ] Position in target venue verified via scan/status read
- [ ] Structured log emitted
- [ ] 1-hour meta-cooldown noted for next execution

## Safety Contract

| Guard | Rule |
|-------|------|
| Matched-freshness | `max(\|ts_zest - ts_hodlmm\|) <= 30s` — not just each read individually fresh |
| Minimum APY diff | 50 bps default — no rotation on marginal differentials |
| Flow safety gate | Disqualify HODLMM if `verdict.lpSafety == "unsafe"` from `hodlmm-flow` |
| Mempool depth | Abort any write leg if a pending STX tx from the sender is in the mempool |
| Nonce serialization | Withdraw + deposit legs must be sequential; verify nonce between legs |
| Bin-drift path | `hodlmm-move-liquidity run` uses `move-relative-liquidity-multi` — one atomic tx, no nonce race within this leg |
| Cross-protocol rotation | Two STX txs (withdraw + deposit) — must be serialized; second tx only after first confirmed |
| Cooldown | 1h meta-cooldown (this guide) + 4h per-pool (enforced inside `hodlmm-move-liquidity`) |
| Confirm gates | All write legs pass through each primitive's own `--confirm` gate — this guide does not bypass them |
| Gas reserve | Ensure at least 150,000 uSTX available for a full two-leg rotation |

## Related Skills

| Skill | Used For |
|-------|---------|
| `wallet` | Wallet unlock for transaction signing |
| `hodlmm-move-liquidity` | Bin drift scan, atomic bin rebalance, HODLMM capital consolidation |
| `hodlmm-flow` | Swap flow analysis, flow toxicity check, bin velocity and range lifespan |
| `sbtc-yield-maximizer` | Live APY comparison across HODLMM and Zest lending routes |
| `zest-yield-manager` | Zest sBTC supply, withdraw, and position status |

## See Also

- [Check Balances and Status](./check-balances-and-status.md)
- [Swap Tokens](./swap-tokens.md)
