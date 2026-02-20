---
name: query
description: Stacks network and blockchain query operations — get STX fees, account info, transaction history, block info, mempool transactions, contract info and events, network status, and call read-only contract functions. All queries use the Hiro API.
user-invocable: false
arguments: get-stx-fees | get-account-info | get-account-transactions | get-block-info | get-mempool-info | get-contract-info | get-contract-events | get-network-status | call-read-only
---

# Query Skill

Provides Stacks network and blockchain query operations using the Hiro API. No wallet required for most queries; `get-account-info` and `get-account-transactions` fall back to the active wallet address if no address is provided.

## Usage

```
bun run query/query.ts <subcommand> [options]
```

## Subcommands

### get-stx-fees

Get current STX fee estimates for different priority levels.

```
bun run query/query.ts get-stx-fees
```

Output:
```json
{
  "network": "mainnet",
  "fees": {
    "low": { "microStx": 1000, "stx": "0.001 STX", "description": "Lower fee, may take longer to confirm" },
    "medium": { "microStx": 2500, "stx": "0.0025 STX", "description": "Standard fee, typical confirmation time" },
    "high": { "microStx": 5000, "stx": "0.005 STX", "description": "Higher fee, faster confirmation" }
  },
  "byTransactionType": {
    "tokenTransfer": { "low": 1000, "medium": 2500, "high": 5000 },
    "contractCall": { "low": 1500, "medium": 3000, "high": 6000 },
    "smartContract": { "low": 2000, "medium": 4000, "high": 8000 }
  },
  "unit": "micro-STX",
  "note": "1 STX = 1,000,000 micro-STX. Fees are estimates based on current mempool conditions."
}
```

### get-account-info

Get account information including nonce and STX balance.

```
bun run query/query.ts get-account-info [--address <stxAddress>]
```

Options:
- `--address` (optional) — Stacks address to check (uses active wallet if omitted)

Output:
```json
{
  "address": "SP...",
  "network": "mainnet",
  "nonce": 42,
  "balance": { "microStx": "1000000000", "stx": "1000 STX" },
  "explorerUrl": "https://explorer.hiro.so/address/SP...?chain=mainnet"
}
```

### get-account-transactions

Get transaction history for a Stacks account.

```
bun run query/query.ts get-account-transactions [--address <stxAddress>] [--limit 20] [--offset 0]
```

Options:
- `--address` (optional) — Stacks address (uses active wallet if omitted)
- `--limit` (optional) — Maximum results (default: 20)
- `--offset` (optional) — Pagination offset (default: 0)

Output:
```json
{
  "address": "SP...",
  "network": "mainnet",
  "total": 150,
  "limit": 20,
  "offset": 0,
  "transactions": [
    {
      "txId": "0x...",
      "type": "token_transfer",
      "status": "success",
      "sender": "SP...",
      "blockHeight": 145000,
      "fee": "1000",
      "explorerUrl": "https://explorer.hiro.so/txid/0x...?chain=mainnet"
    }
  ],
  "explorerUrl": "https://explorer.hiro.so/address/SP...?chain=mainnet"
}
```

### get-block-info

Get information about a specific Stacks block.

```
bun run query/query.ts get-block-info --height-or-hash <value>
```

Options:
- `--height-or-hash` (required) — Block height (integer) or block hash (0x-prefixed)

Output:
```json
{
  "network": "mainnet",
  "hash": "0x...",
  "height": 145000,
  "canonical": true,
  "burnBlockHeight": 840000,
  "burnBlockTime": 1700000000,
  "burnBlockTimeIso": "2024-01-01T00:00:00.000Z",
  "txCount": 12,
  "txIds": ["0x..."]
}
```

### get-mempool-info

Get pending transactions in the Stacks mempool.

```
bun run query/query.ts get-mempool-info [--sender-address <addr>] [--limit 20] [--offset 0]
```

Options:
- `--sender-address` (optional) — Filter by sender address
- `--limit` (optional) — Maximum results (default: 20)
- `--offset` (optional) — Pagination offset (default: 0)

Output:
```json
{
  "network": "mainnet",
  "total": 5,
  "limit": 20,
  "offset": 0,
  "transactions": [
    {
      "txId": "0x...",
      "type": "contract_call",
      "sender": "SP...",
      "fee": "2500",
      "nonce": 43,
      "receiptTime": "2024-01-01T00:00:00.000Z",
      "explorerUrl": "https://explorer.hiro.so/txid/0x...?chain=mainnet"
    }
  ]
}
```

### get-contract-info

Get information about a smart contract including its ABI.

```
bun run query/query.ts get-contract-info --contract-id <address.contract-name>
```

Options:
- `--contract-id` (required) — Contract ID in format `address.contract-name`

Output:
```json
{
  "contractId": "SP...contract-name",
  "network": "mainnet",
  "txId": "0x...",
  "blockHeight": 140000,
  "functions": [
    { "name": "transfer", "access": "public", "args": [...], "outputs": {...} }
  ],
  "variables": [...],
  "maps": [...],
  "fungibleTokens": [...],
  "nonFungibleTokens": [...],
  "explorerUrl": "https://explorer.hiro.so/txid/SP...contract-name?chain=mainnet"
}
```

### get-contract-events

Get events emitted by a smart contract.

```
bun run query/query.ts get-contract-events --contract-id <address.contract-name> [--limit 20] [--offset 0]
```

Options:
- `--contract-id` (required) — Contract ID in format `address.contract-name`
- `--limit` (optional) — Maximum results (default: 20)
- `--offset` (optional) — Pagination offset (default: 0)

Output:
```json
{
  "contractId": "SP...contract-name",
  "network": "mainnet",
  "limit": 20,
  "offset": 0,
  "events": [...],
  "explorerUrl": "https://explorer.hiro.so/txid/SP...contract-name?chain=mainnet"
}
```

### get-network-status

Get the current status of the Stacks network.

```
bun run query/query.ts get-network-status
```

Output:
```json
{
  "network": "mainnet",
  "serverVersion": "stacks-node 2.4.0.0.0",
  "status": "ready",
  "chainTip": { "block_height": 145000, "block_hash": "0x..." },
  "coreInfo": {
    "peerVersion": 4026533888,
    "stacksTipHeight": 145000,
    "burnBlockHeight": 840000,
    "networkId": 1
  }
}
```

### call-read-only

Call a read-only function on a smart contract.

```
bun run query/query.ts call-read-only --contract-id <id> --function-name <name> [--args <json>] [--sender <address>]
```

Options:
- `--contract-id` (required) — Contract ID in format `address.contract-name`
- `--function-name` (required) — Name of the read-only function
- `--args` (optional) — JSON array of hex-encoded Clarity values (default: `[]`)
- `--sender` (optional) — Sender address (uses active wallet or contract address if omitted)

The `--args` option accepts a JSON array of hex-encoded Clarity values. Use `@stacks/transactions` to encode values. For example, `uintCV(1)` serialized as hex would be `"0100000000000000000000000000000001"`.

Output:
```json
{
  "contractId": "SP...contract-name",
  "functionName": "get-balance",
  "network": "mainnet",
  "okay": true,
  "result": "0x0100000000000000000000000000000064",
  "cause": null
}
```

## Notes

- All queries use the Hiro API (`api.mainnet.hiro.so` or `api.testnet.hiro.so`)
- Network is controlled by the `NETWORK` environment variable (default: testnet)
- `get-account-info` and `get-account-transactions` fall back to the active wallet address
- `call-read-only` falls back to the contract's own address as sender if no wallet is active
