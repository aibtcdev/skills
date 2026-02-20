---
name: nft
description: SIP-009 NFT operations on Stacks L2 — list NFT holdings, get token metadata, transfer NFTs, get token owner, get collection information, and get transfer history. Transfer operations require an unlocked wallet.
user-invocable: false
arguments: get-holdings | get-metadata | transfer | get-owner | get-collection-info | get-history
---

# NFT Skill

Provides SIP-009 NFT (Non-Fungible Token) operations on Stacks L2. Transfer operations require an unlocked wallet (use `bun run wallet/wallet.ts unlock` first). Query operations work without a wallet.

## Usage

```
bun run nft/nft.ts <subcommand> [options]
```

## Subcommands

### get-holdings

List all NFTs owned by an address.

```
bun run nft/nft.ts get-holdings [--address <addr>] [--contract-id <id>] [--limit <n>] [--offset <n>]
```

Options:
- `--address` (optional) — Stacks address to check (uses active wallet if omitted)
- `--contract-id` (optional) — Filter by specific NFT collection contract ID
- `--limit` (optional) — Maximum number of results (default: 20)
- `--offset` (optional) — Offset for pagination (default: 0)

Output:
```json
{
  "address": "SP2...",
  "network": "mainnet",
  "total": 5,
  "nfts": [
    { "collection": "SP2....nft-contract::my-nft", "tokenId": "u1" },
    { "collection": "SP2....nft-contract::my-nft", "tokenId": "u2" }
  ]
}
```

### get-metadata

Get metadata for a specific NFT (SIP-016).

```
bun run nft/nft.ts get-metadata --contract-id <id> --token-id <n>
```

Options:
- `--contract-id` (required) — NFT collection contract ID (e.g., `SP2....my-nft`)
- `--token-id` (required) — Token ID of the NFT (integer)

Output:
```json
{
  "contractId": "SP2....my-nft",
  "tokenId": 1,
  "network": "mainnet",
  "metadata": {
    "name": "My NFT #1",
    "description": "...",
    "image": "https://..."
  }
}
```

### transfer

Transfer an NFT (SIP-009) to a recipient address. Requires an unlocked wallet.

```
bun run nft/nft.ts transfer --contract-id <id> --token-id <n> --recipient <addr> [--fee low|medium|high|<microStx>]
```

Options:
- `--contract-id` (required) — NFT collection contract ID
- `--token-id` (required) — Token ID of the NFT to transfer (integer)
- `--recipient` (required) — Stacks address to send to
- `--fee` (optional) — Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "from": "SP2...",
  "recipient": "SP3...",
  "contractId": "SP2....my-nft",
  "tokenId": 1,
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet"
}
```

### get-owner

Get the current owner of a specific NFT.

```
bun run nft/nft.ts get-owner --contract-id <id> --token-id <n>
```

Options:
- `--contract-id` (required) — NFT collection contract ID
- `--token-id` (required) — Token ID of the NFT (integer)

Output:
```json
{
  "contractId": "SP2....my-nft",
  "tokenId": 1,
  "network": "mainnet",
  "owner": "SP2..."
}
```

### get-collection-info

Get information about an NFT collection including its name, total supply, and available functions.

```
bun run nft/nft.ts get-collection-info --contract-id <id>
```

Options:
- `--contract-id` (required) — NFT collection contract ID

Output:
```json
{
  "network": "mainnet",
  "contractId": "SP2....my-nft",
  "name": "my-nft",
  "totalSupply": 10000,
  "functions": ["transfer", "get-owner", "get-last-token-id", "get-token-uri"]
}
```

### get-history

Get the transfer history of NFTs in a collection.

```
bun run nft/nft.ts get-history --contract-id <id> [--limit <n>] [--offset <n>]
```

Options:
- `--contract-id` (required) — NFT collection contract ID
- `--limit` (optional) — Maximum number of results (default: 20)
- `--offset` (optional) — Offset for pagination (default: 0)

Output:
```json
{
  "contractId": "SP2....my-nft",
  "network": "mainnet",
  "total": 150,
  "events": [
    {
      "sender": "SP2...",
      "recipient": "SP3...",
      "tokenId": "u1",
      "txId": "abc123...",
      "blockHeight": 150000
    }
  ]
}
```

## Notes

- Query operations (get-holdings, get-metadata, get-owner, get-collection-info, get-history) use the public Hiro API
- Transfer operations require an unlocked wallet
- NFT token IDs are typically positive integers starting from 1
- Collection contract IDs use the format: `SP<deployer-address>.<contract-name>`
