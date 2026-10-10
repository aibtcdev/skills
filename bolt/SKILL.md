---
name: bolt
description: "Pay Stacks fees in sBTC or USDCx when the wallet has no STX — send sBTC/USDCx, or have any contract call sponsored (e.g. ERC-8004 registration), paid in sBTC in the same request or from prepaid credit. Mainnet, no API key."
metadata:
  author: "ronoel"
  user-invocable: "false"
  arguments: "status | transfer | call | credit-balance | credit-deposit | credit-withdraw | sponsor-call"
  entry: "bolt/bolt.ts"
  requires: "wallet"
  tags: "l2, write, mainnet-only, requires-funds"
---

# bolt

[Bolt Protocol](https://boltproto.org) sponsors Stacks transactions: the wallet
signs, Bolt pays the STX network fee, and the wallet pays Bolt in sBTC or USDCx
instead. An address that holds no STX can transact.

- Non-custodial: the private key never leaves the wallet.
- No API key and no signup.
- Mainnet only. Every subcommand refuses to run unless `NETWORK=mainnet`.

| You want to | Subcommand | Cost |
|---|---|---|
| Send sBTC or USDCx to a Stacks address | `transfer` | from 10 sats or 100 micro-USDCx, inside the same transaction |
| Call any other contract without STX | `call` | from 20 sats of sBTC, paid in the same request; nothing is deposited |
| Call contracts often | `credit-deposit` once, then `sponsor-call` | the `--fee` you pass, from 10 sats per call, debited from the credit |

Amounts are integers in the token's smallest unit: sats for sBTC (8 decimals),
micro-USDCx for USDCx (6 decimals).

**Contract calls are paid in sBTC only**, by `call` or from credit. A wallet
that holds only USDCx can use `transfer` and nothing else.

## Subcommands

### `status`

```bash
NETWORK=mainnet bun run bolt/bolt.ts status
```

Whether Bolt is up, contract IDs and minimum fees. No wallet.

Output: `{ network, endpoint, status, docs, transfer: { sbtc, usdcx }, call, credit }`

### `transfer`

```bash
NETWORK=mainnet bun run bolt/bolt.ts transfer --token sbtc --recipient SP... --amount 1000
NETWORK=mainnet bun run bolt/bolt.ts transfer --token usdcx --recipient SP... --amount 2500000 --memo "order-42"
```

| Option | Required | Description |
|---|---|---|
| `--token` | yes | `sbtc` or `usdcx` |
| `--recipient` | yes | Stacks address; it receives exactly `--amount` |
| `--amount` | yes | smallest unit of the token |
| `--fee` | no | paid to Bolt in the same token; default is the minimum (10 sats / 100 micro-USDCx) |
| `--memo` | no | up to 34 bytes |

The wallet must hold `amount + fee` of the token. The transaction carries a
`Deny` post condition for exactly that amount.

On-chain this is a call to the Bolt contract, which moves the fee to Bolt and
then `--amount` to the recipient. A service that verifies a payment by looking
for a direct `transfer` call on the token contract (aibtc bounty payouts, inbox
payments recovered by txid) does not recognize it: pay those with `call` or
`sponsor-call` on the token's own `transfer` instead.

Output: `{ success, txid, from, recipient, token, amount, fee, unit, nonce, network, explorerUrl }`

### `call`

```bash
# Register an ERC-8004 identity with no STX and no deposit
NETWORK=mainnet bun run bolt/bolt.ts call \
  --contract SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2 \
  --function register-with-uri \
  --args '[{"type":"string-utf8","value":"https://aibtc.com/api/agents/SP..."}]'
```

| Option | Required | Description |
|---|---|---|
| `--contract` | yes | `ADDRESS.contract-name` |
| `--function` | yes | public function name |
| `--args` | no | JSON array, same typed format as `sponsor-call` below |
| `--post-condition-mode` | no | `deny` (default) or `allow` |
| `--post-conditions` | no | JSON array, same format as `sponsor-call` below |
| `--fee` | no | total sats to pay; default is the minimum: 20, or 2 per 50 bytes when the call is above 500 bytes |

Any contract call, paid in sBTC in the same request. The wallet signs two
transactions with consecutive nonces: a payment of `--fee` to Bolt, then the
call. Bolt broadcasts the payment and, right after it, the call. Nothing is
deposited and Bolt keeps no balance for the wallet.

- The wallet must hold `--fee` in sBTC, plus whatever the call itself moves.
- The fee pays for two transactions, half each, so it is twice what the same
  call costs on credit. A higher fee buys priority on the network for both.
- The payment is made once Bolt accepts the request, even if the call later
  fails on-chain: validate the call first, as with `sponsor-call`.
- If the network refuses the call after the payment was sent
  (`BOLT_CALL_NOT_SENT`), the half that was for the call becomes prepaid credit once the
  payment confirms: spend it with `sponsor-call` or take it back with
  `credit-withdraw`.
- Do not send another transaction from the wallet until both confirm. A wallet
  whose payment does not confirm can use only prepaid credit afterwards
  (`BOLT_CREDIT_ONLY`).
- Bolt's own contracts cannot be called this way — use `transfer`.

`call` costs twice as much per call as credit: use it for a call now and
then, and `credit-deposit` plus `sponsor-call` for calls made often.

Output: `{ success, txid, feeTxid, contract, function, feePaid, unit, nonce, feeNonce, network, explorerUrl }`

`txid` is the call, `feeTxid` the payment.

### `credit-balance`

```bash
NETWORK=mainnet bun run bolt/bolt.ts credit-balance
NETWORK=mainnet bun run bolt/bolt.ts credit-balance --address SP...
```

Prepaid credit of an address, in sats. No wallet needed with `--address`.
Run it after a `credit-deposit` confirms; the credit is available after that.

Output: `{ address, network, credit: { sats, callsAtMinimumFee } }`

### `credit-deposit`

```bash
NETWORK=mainnet bun run bolt/bolt.ts credit-deposit --amount 1000
```

| Option | Required | Description |
|---|---|---|
| `--amount` | yes | sats of credit to add |
| `--fee` | no | fee for the deposit itself, default 10 sats |

Moves `amount + fee` sBTC from the wallet; the deposit itself needs no STX.
Unused credit can be taken back with `credit-withdraw`.

A single call on credit costs at least 20 sats (deposit fee and call fee), 30
if a remainder is withdrawn afterwards; credit pays off over several calls.

Output: `{ success, txid, address, creditAdded, fee, unit, nonce, network, explorerUrl, next }`

### `credit-withdraw`

```bash
NETWORK=mainnet bun run bolt/bolt.ts credit-withdraw --amount 500
```

| Option | Required | Description |
|---|---|---|
| `--amount` | yes | sats of credit to withdraw, more than the 10-sat fee |

Takes credit back as sBTC. Bolt keeps 10 sats and sends the rest to the wallet
that owns the credit, never to another address. The wallet signs a message, not
a transaction, so it needs no STX. The credit is held by Bolt until then: the
withdrawal is processed by Bolt on request.

Output: `{ success, txid, address, creditWithdrawn, fee, received, unit, network, explorerUrl }`

`fee` and `received` are absent when the answer was lost and the command recovered
the payout by sending the same request again.

### `sponsor-call`

```bash
# Build, sign and send in one step: register an ERC-8004 identity without STX
NETWORK=mainnet bun run bolt/bolt.ts sponsor-call \
  --contract SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2 \
  --function register-with-uri \
  --args '[{"type":"string-utf8","value":"https://aibtc.com/api/agents/SP..."}]'

# Or send a call that was already signed as sponsored
NETWORK=mainnet bun run bolt/bolt.ts sponsor-call --serialized-tx 0x8080...
```

| Option | Required | Description |
|---|---|---|
| `--contract` | with `--function` | `ADDRESS.contract-name` |
| `--function` | with `--contract` | public function name |
| `--args` | no | JSON array, same typed format as the `contract` skill |
| `--post-condition-mode` | no | `deny` (default) or `allow` |
| `--post-conditions` | no | JSON array, see below |
| `--serialized-tx` | instead of the above | hex of a contract call this wallet signed with `sponsored: true`, fee 0 |
| `--fee` | no | sats of credit to spend; default is the minimum: 10, or 1 per 50 bytes when the transaction is above 500 bytes |

Every typed argument needs both `type` and `value`, including an empty optional:
write `{"type":"none","value":null}`. Without `value` it is read as a tuple and
the network refuses the call with `BadFunctionArgument`. For example, an sBTC
`transfer` with no memo:

```json
[{"type":"uint","value":100},{"type":"principal","value":"SP...sender"},{"type":"principal","value":"SP...recipient"},{"type":"none","value":null}]
```

Post conditions use the `contract` skill's JSON shape, `stx` and `ft` types:

```json
[{"type":"ft","principal":"SP...","asset":"SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token","assetName":"sbtc-token","conditionCode":"eq","amount":"1000"}]
```

Bolt's own contracts cannot be called this way — use `transfer`. Very large
transactions may be refused.

How the fee works:

- Without `--fee`, the command spends the minimum: 10 sats for a transaction of
  up to 500 bytes, or 1 sat per 50 bytes above that (3,000 bytes cost 60). If
  Bolt answers with a higher minimum, the command pays that one instead, once.
  A `--fee` you pass is never raised.
- A higher `--fee` buys priority: Bolt pays the network 50 micro-STX per sat of
  fee (this rate can change), so the minimum of 10 pays 500 micro-STX. The
  minimum is enough when the network is not congested.
- The wallet signs the fee together with the call, so only the wallet that
  signed the transaction can set what it costs. That is why `--serialized-tx`
  needs the wallet that signed it unlocked.
- The fee is debited when Bolt accepts the call and returned if the network
  refuses it. A call that is broadcast and later fails on-chain is still paid.

Output: `{ success, txid, contract?, function?, creditSpent, unit, nonce?, network, explorerUrl }`

## Errors

Errors are `{ error, code, suggestion, docsRef, details }` with a non-zero exit code.
`details` has the HTTP `status` and, when Bolt sends them, `boltCode` (Bolt's own
refusal code), `txid`, `withdrawal` and `minimumFee`.

| `code` | Meaning | Charged? |
|---|---|---|
| `BOLT_MAINNET_ONLY` | `NETWORK` is not `mainnet` | no |
| `BOLT_INVALID_ARGUMENT` | a flag is missing or malformed, or `--serialized-tx` was signed by another wallet | no |
| `BOLT_INVALID_TRANSACTION` | the transaction as built was refused | no |
| `BOLT_INVALID_NONCE` | the address has pending transactions; wait for them to confirm. `details.txid`, when present, is a call Bolt already broadcast with this nonce (and `details.feeTxid` its payment, for `call`) | no |
| `BOLT_INSUFFICIENT_CREDIT` | credit below `--fee` | no |
| `BOLT_INSUFFICIENT_BALANCE` | wallet below `amount + fee`, or below the `--fee` of a `call` | no |
| `BOLT_FEE_TOO_LOW` | fee under the minimum | no |
| `BOLT_CONTRACT_NOT_ON_CREDIT` | `sponsor-call` aimed at a Bolt contract | no |
| `BOLT_TEMPORARILY_UNAVAILABLE` | try again later | no |
| `BOLT_RATE_LIMITED` | too many requests; wait before sending again | no |
| `BOLT_CREDIT_ONLY` | Bolt takes only prepaid credit from this address: use `credit-deposit` and `sponsor-call` | no |
| `BOLT_CALL_NOT_SENT` | `call`: the payment was sent and the call was not; `details.credit` sats become prepaid credit once `details.feeTxid` confirms | yes, kept as credit |
| `BOLT_REFUND_FAILED` | the network refused the transaction and the amount was not returned; do not send again | yes |
| `BOLT_WITHDRAWAL_REPEATED` | the same withdrawal request was sent twice; `details.withdrawal` is the outcome of the first (`sent`, `confirmed`, `not_paid`, `pending`, `unknown`) and `details.txid` its payout | no |
| `BOLT_WITHDRAWAL_UNKNOWN` | the outcome of a withdrawal could not be confirmed; do not send again | credit held until resolved |
| `BOLT_SENT_UNCONFIRMED` | a write got no answer, was sent again unchanged, and its nonce was already taken: the first attempt was most likely broadcast | probably |
| `BOLT_CALL_UNKNOWN` | the outcome of a `sponsor-call` or `call` could not be confirmed; `details.txid` is the transaction to look up, or `details.feeTxid` when it is the payment of a `call` that has no answer; do not send again | fee held until resolved |
| `BOLT_REJECTED` | the network refused the transaction; `error` names its reason (`BadNonce`, `TooMuchChaining`, `FeeTooLow`, `NoSuchContract`, `NoSuchPublicFunction`, `BadFunctionArgument`, …) | no |

## Reference

- API guide: <https://boltproto.org/llms-full.txt>
- Contracts: `SP3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02ZHQCMVJ.boltproto-sbtc-v2`, `SP3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02ZHQCMVJ.boltproto-usdcx-v1`
