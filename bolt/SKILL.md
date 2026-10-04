---
name: bolt
description: "Pay Stacks fees in sBTC or USDCx when the wallet has no STX — send sBTC/USDCx, or prepay sBTC credit and have any contract call sponsored (e.g. ERC-8004 registration). Mainnet, no API key."
metadata:
  author: "ronoel"
  user-invocable: "false"
  arguments: "status | transfer | credit-balance | credit-deposit | sponsor-call"
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
| Call any other contract without STX | `credit-deposit` once, then `sponsor-call` | the `--fee` you pass, from 10 sats per call, debited from the credit |

Amounts are integers in the token's smallest unit: sats for sBTC (8 decimals),
micro-USDCx for USDCx (6 decimals).

**Prepaid credit is sBTC only.** There is no USDCx credit: a wallet that holds
only USDCx can use `transfer` and nothing else.

## Subcommands

### `status`

```bash
NETWORK=mainnet bun run bolt/bolt.ts status
```

Whether Bolt is up, contract IDs and minimum fees. No wallet.

Output: `{ network, endpoint, status, docs, transfer: { sbtc, usdcx }, credit }`

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

Output: `{ success, txid, from, recipient, token, amount, fee, unit, nonce, network, explorerUrl }`

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
Credit is not withdrawable at this time — deposit what you plan to use.

Output: `{ success, txid, address, creditAdded, fee, unit, nonce, network, explorerUrl, next }`

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
| `--serialized-tx` | instead of the above | hex of a contract call signed with `sponsored: true`, fee 0 |
| `--fee` | no | sats of credit to spend; default is the minimum: 10, or 1 per 50 bytes when the transaction is above 500 bytes |

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
- A higher `--fee` buys priority: Bolt pays the network a fee in proportion to
  it. The minimum is enough when the network is not congested.
- The fee is debited when Bolt accepts the call and returned if the network
  refuses it. A call that is broadcast and later fails on-chain is still paid.

Output: `{ success, txid, contract?, function?, creditSpent, unit, nonce?, network, explorerUrl }`

## Errors

Errors are `{ error, code, suggestion, docsRef }` with a non-zero exit code.

| `code` | Meaning | Charged? |
|---|---|---|
| `BOLT_MAINNET_ONLY` | `NETWORK` is not `mainnet` | no |
| `BOLT_INVALID_ARGUMENT` | a flag is missing or malformed | no |
| `BOLT_INVALID_TRANSACTION` | the transaction as built was refused | no |
| `BOLT_INVALID_NONCE` | the address has pending transactions; wait for them to confirm | no |
| `BOLT_INSUFFICIENT_CREDIT` | credit below `--fee` | no |
| `BOLT_INSUFFICIENT_BALANCE` | wallet below `amount + fee` | no |
| `BOLT_FEE_TOO_LOW` | fee under the minimum | no |
| `BOLT_CONTRACT_NOT_ON_CREDIT` | `sponsor-call` aimed at a Bolt contract | no |
| `BOLT_TEMPORARILY_UNAVAILABLE` | try again later | no |
| `BOLT_RATE_LIMITED` | too many requests; wait before sending again | no |
| `BOLT_REFUND_FAILED` | the network refused the transaction and the fee was not returned; do not send again | `sponsor-call`: yes |
| `BOLT_REJECTED` | the network refused the transaction; `error` names its reason (`BadNonce`, `TooMuchChaining`, `FeeTooLow`, `NoSuchContract`, `NoSuchPublicFunction`, `BadFunctionArgument`, …) | no |

## Reference

- API guide: <https://boltproto.org/llms-full.txt>
- Contracts: `SP3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02ZHQCMVJ.boltproto-sbtc-v2`, `SP3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02ZHQCMVJ.boltproto-usdcx-v1`
