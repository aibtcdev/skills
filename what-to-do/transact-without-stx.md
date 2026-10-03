---
title: Transact Without STX
description: Send sBTC or USDCx, or make any contract call such as an ERC-8004 registration, when the wallet holds no STX for fees — the fee is paid in sBTC or USDCx through Bolt Protocol.
skills: [wallet, bolt, stx]
estimated-steps: 6
order: 26
---

# Transact Without STX

Every Stacks transaction needs an STX fee. An agent that holds sBTC or USDCx but no STX can still transact through [Bolt Protocol](https://boltproto.org): the agent signs the transaction, Bolt pays the STX fee, and the agent pays Bolt in sBTC or USDCx.

There are two paths:

- **Send sBTC or USDCx** — use `transfer`. The fee (from 10 sats or 100 micro-USDCx) is taken inside the same transaction. No setup.
- **Any other contract call** — prepay gas credit in sBTC once with `credit-deposit`, then each `sponsor-call` spends 10 sats of it. Credit is sBTC only and is not withdrawable at this time, so deposit what you plan to use.

Bolt is mainnet only. Every command below runs with `NETWORK=mainnet`.

## Prerequisites

- [ ] Wallet unlocked (see the `wallet` skill)
- [ ] sBTC in the wallet for the credit path, or the token being sent for a transfer
- [ ] `NETWORK=mainnet`

## Steps

### 1. Check that Bolt is up

```bash
NETWORK=mainnet bun run bolt/bolt.ts status
```

Expected output: `status: "ok"`, contract IDs and minimum fees. If this fails, stop here and do not sign anything.

### 2. Send sBTC or USDCx (transfer path)

If all you need is to send tokens, this is the only step.

```bash
NETWORK=mainnet bun run bolt/bolt.ts transfer --token sbtc --recipient SP... --amount 1000
```

Expected output: `success: true`, `txid`, `fee` (10 sats), `explorerUrl`. The wallet must hold `amount + fee` of the token. Use `--token usdcx` and micro-USDCx amounts for USDCx.

### 3. Check your credit (contract call path)

```bash
NETWORK=mainnet bun run bolt/bolt.ts credit-balance
```

Expected output: `credit.sats` and `credit.callsAtMinimumFee`. If it covers the calls you plan, skip to step 5.

### 4. Deposit credit

Deposit only what you plan to use: 10 sats per call. The deposit itself needs no STX.

```bash
NETWORK=mainnet bun run bolt/bolt.ts credit-deposit --amount 100
```

Expected output: `success: true`, `txid`, `creditAdded: "100"`.

Wait for the deposit to confirm, then read the balance again:

```bash
NETWORK=mainnet bun run stx/stx.ts get-transaction-status --txid <txid>
NETWORK=mainnet bun run bolt/bolt.ts credit-balance
```

Expected output: `status: "success"`, then `credit.sats` including the deposit. The credit is available after that.

### 5. Make the contract call

Example: register an ERC-8004 identity without STX.

```bash
NETWORK=mainnet bun run bolt/bolt.ts sponsor-call \
  --contract SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2 \
  --function register-with-uri \
  --args '[{"type":"string-utf8","value":"https://aibtc.com/api/agents/<your-stx-address>"}]'
```

Expected output: `success: true`, `txid`, `creditSpent: "10"`.

Any other public function works the same way. Pass `--post-conditions` for every asset the call moves and keep `--post-condition-mode deny`.

### 6. Confirm on-chain

```bash
NETWORK=mainnet bun run stx/stx.ts get-transaction-status --txid <txid>
```

Expected output: `status: "success"`. For the ERC-8004 example, continue with step 5 of [Register ERC-8004 Identity](./register-erc8004-identity.md) to read your `agentId`.

## Verification

At the end of this workflow, verify:
- [ ] `status` returned `status: "ok"`
- [ ] The transfer or sponsored call returned `success: true` with a `txid`
- [ ] The transaction reached `success` on-chain
- [ ] For the credit path, `credit-balance` dropped by the fee of each call

## Related Skills

| Skill | Used For |
|-------|---------|
| `bolt` | Transfers, credit deposit and balance, sponsored contract calls |
| `stx` | Monitoring transaction status |
| `wallet` | Wallet unlock for transaction signing |

## See Also

- [Register ERC-8004 Identity](./register-erc8004-identity.md)
- [Check Balances and Status](./check-balances-and-status.md)
