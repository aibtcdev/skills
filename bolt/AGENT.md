---
name: bolt-agent
skill: bolt
description: Gasless Stacks transactions via Bolt Protocol — sBTC/USDCx transfers with the fee paid in the token, and prepaid sBTC gas credit that sponsors any contract call. Mainnet only.
---

# bolt agent guide

## Prerequisites

- `NETWORK=mainnet`. The repo default is testnet and every subcommand refuses it.
- `status` and `credit-balance --address`: nothing else. No wallet, no funds.
- `transfer`, `credit-deposit`, `credit-withdraw`, `sponsor-call`: an unlocked wallet (the `wallet`
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
   Exception: a payment that a service verifies by txid (an aibtc bounty
   payout, an inbox payment recovered by txid). Those checks accept only a
   direct `sbtc-token.transfer` call, and `transfer` here calls the Bolt
   contract. Pay those with `sponsor-call` on `sbtc-token` `transfer`.
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
- A write that gets no answer (timeout, dropped connection) is sent once more,
  unchanged, by the command itself; that is safe because Bolt runs a signed
  request once. If a command still ends without a JSON result, do not run it
  again blindly: the transaction may already be broadcast. Check the address's
  recent transactions with the `query` skill first.

## Cost guardrails

- Unused credit comes back with `credit-withdraw`, less a 10-sat fee, and only
  to the wallet that deposited it. Bolt holds the credit until then.
- `sponsor-call --fee` defaults to the minimum (10 sats; more only for a
  transaction above 500 bytes). A higher fee buys priority on the network
  (Bolt pays it 50 micro-STX per sat of fee); pass one only when the call is
  urgent and the network is congested.
- One call alone costs at least 20 sats: 10 for the deposit, 10 for the call,
  and 10 more to withdraw a remainder. Deposit for several calls at once.
- A `sponsor-call` the network refuses (`BOLT_REJECTED`) gets its fee back;
  only `BOLT_REFUND_FAILED` and `BOLT_CALL_UNKNOWN` leave it spent. A call that is broadcast and then fails on-chain is still
  paid, so validate it first: the contract and function exist, the arguments
  match the ABI, the post conditions cover what it moves.

## Error handling

| `code` | What to do |
|---|---|
| `BOLT_INVALID_NONCE` | Wait for the address's pending transactions to confirm, then run the same command again. Do not retry in a loop. If `details.txid` is present, Bolt already broadcast a call with that nonce: check that transaction before sending anything. |
| `BOLT_INSUFFICIENT_CREDIT` | For `sponsor-call`: `credit-deposit`, wait for confirmation, `credit-balance`, then retry. For `credit-withdraw`: lower `--amount`. |
| `BOLT_INSUFFICIENT_BALANCE` | Fund the wallet or lower `--amount`; the wallet needs `amount + fee`. |
| `BOLT_CONTRACT_NOT_ON_CREDIT` | The target is one of Bolt's own contracts. Use `transfer`. |
| `BOLT_INVALID_TRANSACTION` | Nothing charged. Fix the call (contract, function, arguments, post conditions) before sending again. |
| `BOLT_TEMPORARILY_UNAVAILABLE` | Nothing charged. Try again later. |
| `BOLT_RATE_LIMITED` | Stop sending writes for a while. |
| `BOLT_REFUND_FAILED` | The fee was debited and not returned. Stop; do not send again. Bolt was notified. |
| `BOLT_WITHDRAWAL_REPEATED` | That withdrawal request was already used. `details.withdrawal` says how it ended: `sent` or `confirmed` → paid, `details.txid` is the payout, do not withdraw again for it; `not_paid` → the credit is in the balance, run the command again; `pending` or `unknown` → wait and check `credit-balance`, do not sign a new one. |
| `BOLT_WITHDRAWAL_UNKNOWN` | Stop. Do not send again; check `credit-balance` later. Bolt was notified. |
| `BOLT_SENT_UNCONFIRMED` | The command got no answer, sent the same request again, and its nonce was already taken: the first attempt was most likely broadcast. Check the address's recent transactions with the `query` skill; run the command again only if the operation is not there. |
| `BOLT_CALL_UNKNOWN` | Stop. The fee was debited and Bolt could not confirm the broadcast. Look `details.txid` up with the `query` skill; do not run the command again. Bolt was notified. |
| `BOLT_REJECTED` | The network refused the transaction. Nothing charged. `error` names the reason: `BadNonce` or `TooMuchChaining` → wait for pending transactions, then sign again; `FeeTooLow` → raise `--fee`; `NoSuchContract`, `NoSuchPublicFunction`, `BadFunctionArgument` → fix the call (a common cause of the last one: an empty optional written without `"value":null`). Do not resend unchanged. |
| `BOLT_MAINNET_ONLY` | Set `NETWORK=mainnet`. |
