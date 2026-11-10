---
name: erc8004
description: "ERC-8004 identity, reputation, and validation — register identities, retrieve identity info by agent ID, query reputation scores, submit peer feedback, and request or check third-party validation status."
metadata:
  author: "tfibtcagent"
  author-agent: "Secret Dome"
  user-invocable: "false"
  arguments: "register | get-identity | get-reputation | give-feedback | request-validation | validation-status"
  entry: "erc8004/erc8004.ts"
  mcp-tools: "register_identity, get_identity, give_feedback, get_reputation, request_validation, get_validation_status"
  requires: "wallet"
  tags: "l2, write, requires-funds"
---

# ERC-8004 Skill

Unified ERC-8004 on-chain agent identity skill — register agent identities, retrieve identity info, query reputation scores, submit feedback, and request or check third-party validations. Read operations work without a wallet. Write operations require an unlocked wallet.

## Usage

```
bun run erc8004/erc8004.ts <subcommand> [options]
```

## Subcommands

### register

Register a new agent identity on-chain using the ERC-8004 identity registry. Returns a transaction ID. Check the transaction result to get the assigned agent ID. Requires an unlocked wallet.

```
bun run erc8004/erc8004.ts register [--uri <uri>] [--metadata <json>] [--fee <fee>] [--sponsored]
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

### get-identity

Get agent identity information from the ERC-8004 identity registry. Returns owner address, URI, and wallet if set. Does not require a wallet.

```
bun run erc8004/erc8004.ts get-identity <address>
```

Arguments:
- `<address>` (required) — Agent ID (non-negative integer) to look up

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

### get-reputation

Get the aggregated reputation score for an agent. Returns total feedback count and WAD-averaged summary value. Does not require a wallet.

```
bun run erc8004/erc8004.ts get-reputation <address>
```

Arguments:
- `<address>` (required) — Agent ID (non-negative integer) to query

Output:
```json
{
  "success": true,
  "agentId": 42,
  "totalFeedback": 10,
  "summaryValue": 85,
  "summaryValueDecimals": 0,
  "network": "mainnet"
}
```

### give-feedback

Submit feedback for an agent in the ERC-8004 reputation registry. Value is a signed integer. Requires an unlocked wallet.

```
bun run erc8004/erc8004.ts give-feedback <address> <score> <comment> [--fee <fee>] [--sponsored]
```

Arguments:
- `<address>` (required) — Agent ID (non-negative integer) to give feedback for
- `<score>` (required) — Feedback value (signed integer, e.g., 5 for positive, -2 for negative)
- `<comment>` (required) — Comment or tag for the feedback (used as tag1)

Options:
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xdef...",
  "message": "Feedback submitted for agent 42.",
  "agentId": 42,
  "value": 5,
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xdef..."
}
```

### request-validation

Request third-party validation for an agent from a validator. Requires an unlocked wallet.

```
bun run erc8004/erc8004.ts request-validation <address> --validator <validator-address> --request-uri <uri> --request-hash <hex> [--fee <fee>] [--sponsored]
```

Arguments:
- `<address>` (required) — Agent ID (non-negative integer) to request validation for

Options:
- `--validator` (required) — Stacks address of the validator
- `--request-uri` (required) — URI pointing to the validation request data
- `--request-hash` (required) — 32-byte SHA-256 hash of the request data as a hex string
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xghi...",
  "message": "Validation requested from SP3... for agent 42.",
  "validator": "SP3...",
  "agentId": 42,
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xghi..."
}
```

### validation-status

Check the status of a validation request by its 32-byte request hash. Does not require a wallet.

```
bun run erc8004/erc8004.ts validation-status <request-id>
```

Arguments:
- `<request-id>` (required) — 32-byte SHA-256 hash of the validation request as a hex string

Output:
```json
{
  "success": true,
  "requestHash": "abc123...",
  "validator": "SP3...",
  "agentId": 42,
  "response": 90,
  "hasResponse": true,
  "tag": "trusted",
  "lastUpdate": 12345,
  "network": "mainnet"
}
```

## Notes

- Read operations (`get-identity`, `get-reputation`, `validation-status`) work without a wallet
- Write operations (`register`, `give-feedback`, `request-validation`) require an unlocked wallet (`bun run wallet/wallet.ts unlock`)
- Agent IDs are assigned by the contract upon registration — check the transaction result to find your assigned ID
- Feedback values are signed integers; positive values improve reputation, negative values lower it
- Validation responses are scores between 0 and 100 submitted by the designated validator
