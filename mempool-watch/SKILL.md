---
name: mempool-watch
description: "Bitcoin mempool monitoring — check transaction confirmation status, retrieve address transaction history, and inspect current mempool state. Data sourced from mempool.space."
metadata:
  author: "teflonbtc"
  author-agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "tx-status | address-history | mempool-stats"
  entry: "mempool-watch/mempool-watch.ts"
  mcp-tools: "get_btc_mempool_info, get_btc_transaction_status, get_btc_address_txs"
  requires: ""
  tags: "l1, read-only"
---

# Mempool Watch Skill

Monitor the Bitcoin mempool and track on-chain activity using the mempool.space public API (no authentication required). Works on both mainnet and testnet.

## Usage

```
bun run mempool-watch/mempool-watch.ts <subcommand> [options]
```

## Subcommands

### tx-status

Check the confirmation status of a Bitcoin transaction.

```
bun run mempool-watch/mempool-watch.ts tx-status --txid <txid>
```

Options:
- `--txid` (required) — Bitcoin transaction ID to look up

Output:
```json
{
  "txid": "abc123...",
  "network": "mainnet",
  "confirmed": true,
  "blockHeight": 880000,
  "blockHash": "000000...",
  "blockTime": "2026-01-01T00:00:00.000Z",
  "confirmations": 42,
  "explorerUrl": "https://mempool.space/tx/abc123..."
}
```

If unconfirmed:
```json
{
  "txid": "abc123...",
  "network": "mainnet",
  "confirmed": false,
  "blockHeight": null,
  "blockHash": null,
  "blockTime": null,
  "confirmations": 0,
  "explorerUrl": "https://mempool.space/tx/abc123..."
}
```

### address-history

Retrieve the transaction history for a Bitcoin address.

```
bun run mempool-watch/mempool-watch.ts address-history --address <addr> [--limit <n>]
```

Options:
- `--address` (required) — Bitcoin address to look up
- `--limit` (optional) — Maximum number of transactions to return (default: 10, max: 25)

Output:
```json
{
  "address": "bc1q...",
  "network": "mainnet",
  "count": 3,
  "transactions": [
    {
      "txid": "abc123...",
      "confirmed": true,
      "blockHeight": 880000,
      "blockTime": "2026-01-01T00:00:00.000Z",
      "fee": 1200,
      "valueIn": 500000,
      "valueOut": 498800,
      "explorerUrl": "https://mempool.space/tx/abc123..."
    }
  ],
  "explorerUrl": "https://mempool.space/address/bc1q..."
}
```

### mempool-stats

Get current Bitcoin mempool statistics including pending transaction count, backlog size, and fee histogram.

```
bun run mempool-watch/mempool-watch.ts mempool-stats
```

Output:
```json
{
  "network": "mainnet",
  "pendingTransactions": 12400,
  "pendingVsize": 8500000,
  "totalFees": 120000000,
  "recommendedFees": {
    "fast": { "satPerVb": 15, "target": "~10 minutes (next block)" },
    "medium": { "satPerVb": 8, "target": "~30 minutes" },
    "slow": { "satPerVb": 3, "target": "~1 hour" },
    "economy": { "satPerVb": 1, "target": "~24 hours" }
  },
  "feeHistogram": [[15, 200000], [8, 500000], [3, 1000000]]
}
```

## Notes

- All subcommands use the public mempool.space API — no authentication or wallet required
- Defaults to testnet unless `NETWORK=mainnet` is set
- `confirmations` in `tx-status` is estimated from current block height minus the transaction's block height
- `address-history` returns the most recent transactions first; mempool.space paginates via `after_txid` which is not exposed here — use `--limit` to control result size
