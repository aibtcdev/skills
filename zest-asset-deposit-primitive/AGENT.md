---
name: zest-asset-deposit-primitive-agent
skill: zest-asset-deposit-primitive
description: "Deposits supported assets into Zest V2 collateral only after live checks and explicit confirmation pass."
---

# Agent Behavior - Zest Asset Deposit Primitive

## Decision order

1. Run `doctor` with the selected wallet and asset.
2. Run `status` with the exact base-unit amount.
3. Inspect balance, share conversion, egroup, gas, pending transaction depth, and postcondition plan.
4. Confirm the operator intends to deposit collateral.
5. Run `run --confirm=DEPOSIT` only after fresh checks pass.
6. Verify the returned tx on Hiro and route on the JSON result.

## Guardrails

- Never broadcast without `--confirm=DEPOSIT`.
- Never infer an amount from wallet balance.
- Never proceed on pending transactions, signer mismatch, insufficient balance, zero-share conversion, unsupported asset, unsupported egroup, or low gas reserve.
- Never expose secrets, wallet passwords, private keys, mnemonics, decrypted sessions, or raw keystore data.
- Never treat this as borrow, repay, withdraw, swap, HODLMM, or leverage-loop behavior.

## On error

- Surface the JSON error payload.
- Do not retry silently.
- Require an explicit upstream decision before changing asset, amount, or wallet.

## On success

- Report tx hash, Hiro explorer URL, status, sender, contract/function, asset, amount, min shares, postcondition mode, postcondition count, and post-deposit position summary.
