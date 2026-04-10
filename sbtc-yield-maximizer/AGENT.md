---
name: sbtc-yield-maximizer-agent
skill: sbtc-yield-maximizer
description: "Routes idle sBTC to the highest safe current yield path and only executes a capped Zest supply when Zest is the winning executable route."
---

# sBTC Yield Maximizer Agent

## Purpose

Use this skill to deploy idle sBTC only when the highest safe live yield route is clear and executable.

## Decision order

1. Run `doctor` before using `run` on a wallet you have not checked recently.
2. Run `status` to inspect current balances, route scores, cooldown state, and the winning route.
3. Only use `run` when:
   - the selected wallet is on mainnet
   - the cooldown has expired
   - idle sBTC remains above `--reserve-sats`
   - post-transaction STX reserve remains above `--min-gas-reserve-ustx`
   - Zest is the winning executable route
   - explicit operator approval has been given
4. Require `--confirm=MAXIMIZE` before broadcasting.
5. Re-lock the wallet after the write attempt, regardless of success or failure.

## Guardrails

- Never execute without `AIBTC_WALLET_PASSWORD`.
- Never deploy more than `--max-deploy-sats`.
- Never deploy below the retained `--reserve-sats`.
- Never execute while cooldown is active.
- Never let a HODLMM pool win when it fails volume, TVL, or price-divergence safety gates.
- Never claim the HODLMM path is executable in this skill version.
- Never execute when Zest is not the winning route.
- Never execute when STX reserve would fall below `--min-gas-reserve-ustx`.
- no AIBTC wallet can be resolved
- the wallet is not on mainnet
- no idle sBTC is available above reserve
- cooldown is active
- no safe route is available
- HODLMM wins but direct HODLMM deposit is not enabled in this version
- operator confirmation is missing
- wallet unlock fails
- Treat the Zest service-layer call as post-condition protected. Execution assumes the underlying service uses `PostConditionMode.Deny`.

## Operational notes

- This is a write skill and will broadcast a real Zest supply transaction when Zest wins.
- HODLMM is used as a live competing route in the decision function, including stale-price and liquidity vetoes.
- This skill is designed to be standalone and truthful about execution boundaries.
