---
name: sbtc-yield-maximizer-agent
skill: sbtc-yield-maximizer
description: "Routes idle sBTC to the highest safe current yield path and executes either Zest supply or a HODLMM rebalance when the winning route is safely executable."
---

# sBTC Yield Maximizer Agent

## Purpose

Use this skill to deploy or reposition sBTC only when the highest safe live yield route is clear and executable.

## Decision order

1. Run `doctor` before using `run` on a wallet you have not checked recently.
2. Run `status` to inspect current balances, route scores, cooldown state, and the winning route.
3. Only use `run` when:
   - the selected wallet is on mainnet
   - the router cooldown has expired
   - sender mempool depth is within the configured limit
   - idle sBTC remains above `--reserve-sats`
   - post-transaction STX reserve remains above `--min-gas-reserve-ustx`
   - the winning route leads by at least `--min-apy-diff-bps`
   - Zest and HODLMM APY reads are fresh within `--max-data-age-seconds`
   - explicit operator approval has been given
4. If Zest wins, execute the Zest write path.
5. If HODLMM wins, call `hodlmm-move-liquidity run` via CLI rather than importing its source.
6. Use `hodlmm-move-liquidity scan` as the no-broadcast HODLMM preflight check, then respect `hodlmm-move-liquidity`'s per-pool cooldown before delegated execution.
7. Serialize writes so only one leg is active at a time.
8. Require `--confirm=MAXIMIZE` before broadcasting.
9. Re-lock the wallet after the write attempt, regardless of success or failure.

## Guardrails

- Never execute without `AIBTC_WALLET_PASSWORD`.
- Never deploy more than `--max-deploy-sats`.
- Never deploy below the retained `--reserve-sats`.
- Never execute while the router cooldown is active.
- Never execute while pending mempool depth exceeds `--mempool-depth-limit`.
- Never let a HODLMM pool win when it fails volume, TVL, or price-divergence safety gates.
- Never let a route win when its APY data is stale.
- Never rotate when the winning APY edge is below `--min-apy-diff-bps`.
- Never bypass `hodlmm-move-liquidity` for the HODLMM write path.
- Never expose the wallet password through subprocess CLI arguments.
- Never execute when STX reserve would fall below `--min-gas-reserve-ustx`.
- Refuse when no AIBTC wallet can be resolved.
- Refuse when the wallet is not on mainnet.
- Refuse when no idle sBTC is available above reserve.
- Refuse when cooldown is active.
- Refuse when mempool depth is non-zero and execution is configured to wait for a clear lane.
- Refuse when no safe route is available.
- Refuse when `hodlmm-move-liquidity` is unavailable but HODLMM is the winning route.
- Refuse when operator confirmation is missing.
- Refuse when wallet unlock fails.
- Treat the Zest service-layer call as post-condition protected. Execution assumes the underlying service uses `PostConditionMode.Deny`.
- Treat the HODLMM leg as protected by `hodlmm-move-liquidity`'s contract-level min-DLP and max-liquidity-fee guards.

## Operational notes

- This is a write skill and will broadcast a real Zest supply transaction or a real HODLMM rebalance when the winning route passes all gates.
- HODLMM is used as a live competing route in the decision function, including stale-price, liquidity, freshness, and LP-position checks.
- This skill is designed to remain a single self-contained directory while composing with upstream primitives through CLI orchestration.
