---
name: bolt-agent
skill: bolt
description: Gasless Stacks transactions via Bolt Protocol — sBTC/USDCx transfers with the fee paid in the token, and prepaid sBTC gas credit that sponsors any contract call. Mainnet only.
---

# bolt agent guide

## Prerequisites

- `NETWORK=mainnet`. The repo default is testnet and every subcommand refuses it.
- `status` and `credit-balance --address`: nothing else. No wallet, no funds.
- `transfer`, `credit-deposit`, `sponsor-call`: an unlocked wallet (the `wallet`
  skill) holding the token being moved. No STX is needed for any of them.
- Credit is sBTC only. A wallet holding only USDCx can `transfer` USDCx and
  nothing else.

## When to invoke

- The wallet holds sBTC or USDCx but no STX, and needs to send it → `transfer`.
- The wallet needs to call a contract and has no STX for the fee →
  `credit-deposit` once, then `sponsor-call`.
- The wallet has STX and a self-paid transaction would do → use the `sbtc`,
  `tokens` or `contract` skill instead.

## Decision logic

1. Run `status` once per session. If it fails, do not sign anything.
2. Plain sBTC/USDCx payment → `transfer`. No credit needed.
3. Any other contract call → check `credit-balance`. If it is below the fee for
   the calls you plan, run `credit-deposit`, wait for the transaction to
   confirm, then run `credit-balance` again before `sponsor-call`.
4. Send calls one after another, not in parallel.

## Safety checks

- Keep `--post-condition-mode deny` and pass `--post-conditions` for every
  asset the call moves.
- Verify `--recipient` and `--contract` before signing. A broadcast transfer
  cannot be undone.
- Treat the `txid` in the output as broadcast, not confirmed. Check it with the
  `query` skill before acting on the result.
- `--serialized-tx` sends bytes signed elsewhere: only pass a transaction you
  built or decoded yourself.
- If a command ends without a JSON result (timeout, network error), do not run
  it again blindly: the transaction may already be broadcast. Check the
  address's recent transactions with the `query` skill first.

## Cost guardrails

- Credit is not withdrawable at this time. Deposit for the calls you plan, not
  a round number.
- `sponsor-call --fee` defaults to the minimum (10 sats; more only for a
  transaction above 500 bytes). A higher fee buys priority on the network;
  pass one only when the call is urgent and the network is congested.
- No error spends credit: a `sponsor-call` the network refuses (`BOLT_REJECTED`)
  gets its fee back. A call that is broadcast and then fails on-chain is still
  paid, so validate it first: the contract and function exist, the arguments
  match the ABI, the post conditions cover what it moves.

## Error handling

| `code` | What to do |
|---|---|
| `BOLT_INVALID_NONCE` | Wait for the address's pending transactions to confirm, then run the same command again. Do not retry in a loop. |
| `BOLT_INSUFFICIENT_CREDIT` | `credit-deposit`, wait for confirmation, `credit-balance`, then retry. |
| `BOLT_INSUFFICIENT_BALANCE` | Fund the wallet or lower `--amount`; the wallet needs `amount + fee`. |
| `BOLT_CONTRACT_NOT_ON_CREDIT` | The target is one of Bolt's own contracts. Use `transfer`. |
| `BOLT_INVALID_TRANSACTION` | Nothing charged. Fix the call (contract, function, arguments, post conditions) before sending again. |
| `BOLT_TEMPORARILY_UNAVAILABLE` | Nothing charged. Try again later. |
| `BOLT_RATE_LIMITED` | Stop sending writes for a while. |
| `BOLT_REJECTED` | The network refused the transaction. Nothing charged. `error` names the reason: `BadNonce` → wait for pending transactions, then sign again; `NotEnoughFunds` → the wallet lacks what the call moves; `NoSuchContract`, `NoSuchPublicFunction`, `BadFunctionArgument` → fix the call. Do not resend unchanged. |
| `BOLT_MAINNET_ONLY` | Set `NETWORK=mainnet`. |
