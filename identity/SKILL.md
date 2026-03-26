---
name: identity
description: "ERC-8004 on-chain agent identity management — register agent identities, update URI and metadata, manage operator approvals, set/unset agent wallet, transfer identity NFTs, and query identity info."
metadata:
  author: "whoabuddy"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "register | get | set-uri | set-metadata | set-approval | set-wallet | unset-wallet | transfer | get-metadata | get-last-id"
  entry: "identity/identity.ts"
  requires: "wallet"
  mcp-tools: "register_identity, get_identity, identity_get_last_id, identity_get, identity_get_metadata, identity_register, identity_set_uri, identity_set_metadata, identity_set_approval, identity_set_wallet, identity_unset_wallet, identity_transfer"
  tags: "l2, write"
---

# Identity Skill

Provides ERC-8004 on-chain agent identity operations using the identity-registry contract. Read operations (get, get-metadata, get-last-id) work without a wallet. Write operations (register, set-uri, set-metadata, set-approval, set-wallet, unset-wallet, transfer) require an unlocked wallet.

## Usage

```
bun run identity/identity.ts <subcommand> [options]
```

## Subcommands

### register

Register a new agent identity on-chain using the ERC-8004 identity registry. Returns a transaction ID. Check the transaction result to get the assigned agent ID. Requires an unlocked wallet.

```
bun run identity/identity.ts register [--uri <uri>] [--metadata <json>] [--fee <fee>] [--sponsored]
```

Options:
- `--uri` (optional) — URI pointing to agent metadata (IPFS, HTTP, etc.)
- `--metadata` (optional) — JSON array of `{"key": "...", "value": "<hex>"}` pairs (values are hex-encoded buffers)
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xabc...",
  "message": "Identity registration transaction submitted. Check transaction result to get your agent ID.",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xabc..."
}
```

### get

Get agent identity information from the ERC-8004 identity registry. Returns owner address, URI, and wallet if set.

```
bun run identity/identity.ts get --agent-id <id>
```

Options:
- `--agent-id` (required) — Agent ID to look up (non-negative integer)

Output:
```json
{
  "success": true,
  "agentId": 42,
  "owner": "SP1...",
  "uri": "ipfs://...",
  "wallet": "SP2...",
  "network": "mainnet"
}
```

### set-uri

Update the URI for an agent identity. Caller must be the agent owner or an approved operator. Requires an unlocked wallet.

```
bun run identity/identity.ts set-uri --agent-id <id> --uri <uri> [--fee <fee>] [--sponsored]
```

Options:
- `--agent-id` (required) — Agent ID to update (non-negative integer)
- `--uri` (required) — New URI pointing to agent metadata (IPFS, HTTP, etc.)
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xdef...",
  "message": "Identity URI update transaction submitted.",
  "agentId": 42,
  "uri": "ipfs://newuri...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xdef..."
}
```

### set-metadata

Set a metadata key-value pair for an agent identity. Value must be a hex-encoded buffer (max 512 bytes). The key `agentWallet` is reserved and will be rejected by the contract. Caller must be the agent owner or an approved operator. Requires an unlocked wallet.

```
bun run identity/identity.ts set-metadata --agent-id <id> --key <key> --value <hex> [--fee <fee>] [--sponsored]
```

Options:
- `--agent-id` (required) — Agent ID to update (non-negative integer)
- `--key` (required) — Metadata key (string)
- `--value` (required) — Metadata value as a hex-encoded buffer (e.g., `616c696365` for "alice")
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xghi...",
  "message": "Metadata set transaction submitted.",
  "agentId": 42,
  "key": "name",
  "valueHex": "616c696365",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xghi..."
}
```

### set-approval

Approve or revoke an operator for an agent identity. Approved operators can update URI, metadata, and wallet on behalf of the owner. Only the NFT owner can call this. Requires an unlocked wallet.

```
bun run identity/identity.ts set-approval --agent-id <id> --operator <address> [--approved] [--fee <fee>] [--sponsored]
```

Options:
- `--agent-id` (required) — Agent ID to update (non-negative integer)
- `--operator` (required) — Stacks address of the operator to approve or revoke
- `--approved` (flag) — Grant approval (omit to revoke)
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xjkl...",
  "message": "Operator SP3... approved for agent 42.",
  "agentId": 42,
  "operator": "SP3...",
  "approved": true,
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xjkl..."
}
```

### set-wallet

Set the agent wallet for an identity to tx-sender (the active wallet address). This links the active Stacks address to the agent ID without requiring a separate signature. Caller must be the agent owner or an approved operator. Requires an unlocked wallet.

```
bun run identity/identity.ts set-wallet --agent-id <id> [--fee <fee>] [--sponsored]
```

Options:
- `--agent-id` (required) — Agent ID to update (non-negative integer)
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xmno...",
  "message": "Agent wallet set to tx-sender (SP1...) for agent 42.",
  "agentId": 42,
  "wallet": "SP1...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xmno..."
}
```

### unset-wallet

Remove the agent wallet association from an agent identity. Caller must be the agent owner or an approved operator. Requires an unlocked wallet.

```
bun run identity/identity.ts unset-wallet --agent-id <id> [--fee <fee>] [--sponsored]
```

Options:
- `--agent-id` (required) — Agent ID to update (non-negative integer)
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xpqr...",
  "message": "Agent wallet cleared for agent 42.",
  "agentId": 42,
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xpqr..."
}
```

### transfer

Transfer an agent identity NFT to a new owner. The active wallet (tx-sender) must equal the current owner. Transfer automatically clears the agent wallet association. Requires an unlocked wallet.

```
bun run identity/identity.ts transfer --agent-id <id> --recipient <address> [--fee <fee>] [--sponsored]
```

Options:
- `--agent-id` (required) — Agent ID (token ID) to transfer (non-negative integer)
- `--recipient` (required) — Stacks address of the new owner
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xstu...",
  "message": "Identity NFT transfer submitted for agent 42.",
  "agentId": 42,
  "sender": "SP1...",
  "recipient": "SP4...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xstu..."
}
```

### get-metadata

Read a metadata value by key from the ERC-8004 identity registry. Returns the raw buffer value as a hex string. Does not require a wallet.

```
bun run identity/identity.ts get-metadata --agent-id <id> --key <key>
```

Options:
- `--agent-id` (required) — Agent ID to query (non-negative integer)
- `--key` (required) — Metadata key to read

Output:
```json
{
  "success": true,
  "agentId": 42,
  "key": "name",
  "valueHex": "616c696365",
  "network": "mainnet"
}
```

### get-last-id

Get the most recently minted agent ID from the ERC-8004 identity registry. Returns null if no agents have been registered. Does not require a wallet.

```
bun run identity/identity.ts get-last-id
```

Output:
```json
{
  "success": true,
  "lastAgentId": 99,
  "network": "mainnet"
}
```

## Notes

- Read operations (get, get-metadata, get-last-id) work without a wallet
- Write operations require an unlocked wallet (`bun run wallet/wallet.ts unlock`)
- Agent IDs are assigned by the contract upon registration — check the transaction result to find your assigned ID
- Operator approvals allow a delegate address to update URI, metadata, and wallet for an agent
- Transfer automatically clears the agent wallet association; use `set-wallet` after transfer if needed
- The `agentWallet` key is reserved — use `set-wallet` / `unset-wallet` subcommands instead
