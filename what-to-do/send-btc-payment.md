---
title: Send BTC Payment
description: Transfer BTC on Bitcoin L1 to a recipient address with fee selection and inscription-safe UTXO handling.
skills: [wallet, btc]
estimated-steps: 5
order: 4
---

# Send BTC Payment

This workflow covers sending a Bitcoin L1 transfer from your agent wallet. The `btc` skill uses mempool.space for fee estimation and UTXO listing, and defaults to cardinal-only UTXO spending to protect any ordinal inscriptions you hold.

Before transferring, always check the current fee rates and your available balance to avoid overspending or underfunding the transaction.

## Prerequisites

- [ ] Wallet unlocked with BTC balance (check your bc1q address)
- [ ] Recipient Bitcoin address (bc1q..., bc1p..., or legacy format)
- [ ] Amount to send in satoshis (1 BTC = 100,000,000 satoshis)

## Steps

### 1. Unlock Wallet

BTC transfers require an unlocked wallet.

```bash
bun run wallet/wallet.ts unlock --password <your-password>
```

Expected output: `success: true`, `Bitcoin (L1).Native SegWit: bc1q...`.

### 2. Check BTC Balance

Confirm available balance before sending.

```bash
bun run btc/btc.ts balance
```

Expected output: `balance.satoshis` (total), `confirmed.satoshis`, `unconfirmed.satoshis`. Use only confirmed balance for transfers.

### 3. Check Current Fee Rates

Review network fee conditions to choose an appropriate fee tier.

```bash
bun run btc/btc.ts fees
```

Expected output:
```
fees.fast: ~10 minutes (next block)
fees.medium: ~30 minutes
fees.slow: ~1 hour
```

Choose `fast`, `medium`, or `slow` based on urgency.

### 4. Verify Cardinal UTXOs

Check that you have spendable UTXOs that do not contain inscriptions. The transfer command defaults to cardinal-only, but it is good practice to confirm.

```bash
bun run btc/btc.ts get-cardinal-utxos
```

Expected output: `type: "cardinal"`, `summary.count` > 0, `summary.totalValue.satoshis` covers the amount plus fees.

> Note: On testnet, inscription classification is not available. Skip this step on testnet.

### 5. Send the BTC Transfer

Execute the transfer. Amount is in satoshis. The command uses cardinal-only UTXOs by default.

```bash
bun run btc/btc.ts transfer \
  --recipient bc1qRECIPIENT... \
  --amount 100000 \
  --fee-rate medium
```

Expected output: `success: true`, `txid`, `explorerUrl` (mempool.space link), `transaction.fee.satoshis`, `transaction.utxoType: "cardinal-only"`.

> Note: Do NOT use `--include-ordinals` unless you intend to spend UTXOs that may contain valuable inscriptions.

## Verification

At the end of this workflow, verify:
- [ ] Transfer returned `success: true` with a `txid`
- [ ] `transaction.utxoType` is `"cardinal-only"` (unless ordinals were intentionally included)
- [ ] Transaction appears in mempool: `https://mempool.space/tx/<txid>`

## Related Skills

| Skill | Used For |
|-------|---------|
| `btc` | Balance checks, fee estimation, UTXO inspection, and transfer execution |
| `wallet` | Wallet unlock for transaction signing |

## See Also

- [Check Balances and Status](./check-balances-and-status.md)
- [Inbox and Replies](./inbox-and-replies.md)
