---
name: zest-borrow-asset-primitive-agent
skill: zest-borrow-asset-primitive
description: "Borrows from Zest only after live collateral, gas, pending transaction, signer, and confirmation checks pass."
---

# Agent Behavior - Zest Borrow Asset Primitive

## Decision order

1. Run `doctor` first. If it fails, stop and surface the blocker.
2. Run `status` to inspect current collateral and debt.
3. Treat `scaledDebt` as index-scaled principal, not the repayment amount. Use the reported debt-index estimate for planning and let Zest enforce final health on-chain.
4. Convert the requested borrow size to base units for the selected borrow asset.
5. Run `plan` with the requested borrow amount.
6. Confirm debt-creating intent before any write.
7. Execute `run --confirm=BORROW` only after the latest plan still looks safe.
8. Verify the returned tx through Hiro before treating the borrow as proof.

## Guardrails

- Never borrow without explicit operator intent.
- Never infer a safe borrow amount from collateral alone; require an operator-selected amount.
- Never proceed if the sender has pending STX transactions.
- Never accept a signer that does not match `--wallet`.
- Never create or import a wallet for this skill; use the existing AIBTC wallet runtime.
- Never treat this as a leverage loop, swap, repay, or unwind skill.
- Never hide the fact that borrowing creates liquidation risk.
- Never retry a failed or unknown transaction silently.
- Never use stale `status` output as write authority; `run` must re-read live state.
- Never continue past an `UNSUPPORTED_*` dependency result until the contract identifier has been re-verified.
- Never replace the live `v0-4-market.borrow` target with legacy helper or pool-borrow paths.
- Never use `borrow-helper-v2-1-5` or `borrow-helper-v2-1-7` for this V2 primitive.
- Never pass a bare principal for the V2 `receiver` argument; it must be optional, normally `(some --wallet)`.
- Never treat collateral setup as part of this primitive. Existing V2 collateral is required before borrowing.

## On error

- Surface the JSON error payload.
- Do not retry automatically.
- Tell the operator which read or write gate failed.
- If the failure is a contract readiness failure, name the configured V2 contract and say that live dependency verification is required before broadcast.

## On success

- Report tx hash, sender, contract, function, postcondition mode, and status.
- Report collateral asset, borrow asset, amount, and selected Zest contracts.
- Remind the caller that a leverage controller must wait for this tx to confirm before composing the next leg.
