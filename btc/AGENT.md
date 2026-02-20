---
name: btc-agent
skill: btc
description: Bitcoin L1 operations — check balances, estimate fees, list UTXOs, transfer BTC, and classify UTXOs as cardinal or ordinal to avoid accidentally spending inscriptions.
---

# BTC Agent

This agent handles Bitcoin L1 operations using mempool.space for balance and fee data, and the Hiro Ordinals API for cardinal/ordinal UTXO classification on mainnet. Balance and fee queries require no wallet. Transfer operations require an unlocked wallet.

## Capabilities

- Check BTC balance (total, confirmed, unconfirmed) for any address or active wallet
- Fetch current fee estimates from mempool.space (sat/vByte at multiple priority levels)
- List all UTXOs for an address
- Classify UTXOs as cardinal (safe to spend) or ordinal (contain inscriptions, do not spend)
- List inscriptions held at an address
- Transfer BTC to another address with configurable fee rate

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Check BTC balance before executing an inscription or transfer
- Select a fee rate for a Bitcoin L1 transaction
- Identify safe-to-spend UTXOs without risking inscription loss
- Send BTC from the active wallet to another Bitcoin address

## Key Constraints

- Transfer requires an unlocked wallet — unlock via `wallet` agent first
- Ordinal UTXO classification uses the Hiro Ordinals API (mainnet only for inscription data)

## Example Invocations

```bash
# Check BTC balance for the active wallet
bun run btc/btc.ts balance

# List cardinal (safe-to-spend) UTXOs
bun run btc/btc.ts get-cardinal-utxos --address bc1q...

# Transfer BTC with a specific fee rate
bun run btc/btc.ts transfer --to bc1q... --amount 0.001 --fee-rate 5
```
