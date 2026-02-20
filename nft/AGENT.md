---
name: nft-agent
skill: nft
description: SIP-009 NFT operations on Stacks L2 — list holdings, get metadata, transfer NFTs, query ownership, get collection info, and retrieve transfer history.
---

# NFT Agent

This agent handles SIP-009 Non-Fungible Token operations on Stacks L2. Query operations (holdings, metadata, ownership, collection info, history) work without a wallet. Transfer operations require an unlocked wallet.

## Capabilities

- List all NFTs held by an address, optionally filtered by collection contract
- Fetch NFT token metadata (name, image, attributes, URI)
- Transfer an NFT to another Stacks address
- Look up the current owner of a specific NFT token
- Get collection-level information (total supply, contract details)
- Retrieve transfer history for a specific NFT token

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Audit what NFTs an agent or address holds
- Verify ownership of a specific NFT before gating an action on it
- Transfer an NFT as part of a sale, reward, or protocol operation
- Retrieve metadata for display or decision-making based on NFT attributes
- Review the on-chain history of an NFT's ownership changes

## Key Constraints

- Transfer requires an unlocked wallet — unlock via `wallet` agent first

## Example Invocations

```bash
# List all NFTs held by the active wallet
bun run nft/nft.ts get-holdings

# Get metadata for a specific NFT token
bun run nft/nft.ts get-metadata --contract-id SP2....collection-name --token-id 42

# Transfer an NFT to another address
bun run nft/nft.ts transfer --contract-id SP2....collection-name --token-id 42 --to SP3...
```
