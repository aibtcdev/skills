---
name: identity
description: ERC-8004 on-chain agent identity and reputation management — register agent identities, query identity info, submit and retrieve reputation feedback, and manage third-party validation requests.
user-invocable: false
arguments: register | get | give-feedback | get-reputation | request-validation | get-validation-status | get-validation-summary
entry: identity/identity.ts
requires: [wallet]
tags: [l2, write]
---

# Identity Skill

Provides ERC-8004 on-chain agent identity, reputation, and validation operations. Read operations (get, get-reputation, get-validation-status, get-validation-summary) work without a wallet. Write operations (register, give-feedback, request-validation) require an unlocked wallet.

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

### give-feedback

Submit feedback for an agent using the ERC-8004 reputation registry. Feedback value is normalized to 18 decimals (WAD) internally for aggregation. Requires an unlocked wallet.

```
bun run identity/identity.ts give-feedback --agent-id <id> --value <n> --decimals <n> [options]
```

Options:
- `--agent-id` (required) — Agent ID to give feedback for
- `--value` (required) — Feedback value (e.g., `5` for a 5-star rating)
- `--decimals` (required) — Decimals for the value (e.g., `0` for integer ratings)
- `--tag1` (optional) — Optional tag 1 (max 64 chars)
- `--tag2` (optional) — Optional tag 2 (max 64 chars)
- `--endpoint` (optional) — Optional endpoint URL
- `--feedback-uri` (optional) — Optional feedback URI
- `--feedback-hash` (optional) — Optional feedback hash as hex string (32 bytes)
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xdef...",
  "message": "Feedback submitted successfully",
  "agentId": 42,
  "value": 5,
  "decimals": 0,
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xdef..."
}
```

### get-reputation

Get aggregated reputation summary for an agent from the ERC-8004 reputation registry. Returns average rating as a WAD string (18 decimals) and total feedback count.

```
bun run identity/identity.ts get-reputation --agent-id <id>
```

Options:
- `--agent-id` (required) — Agent ID to get reputation for

Output:
```json
{
  "success": true,
  "agentId": 42,
  "totalFeedback": 10,
  "summaryValue": "4500000000000000000",
  "summaryValueDecimals": 18,
  "network": "mainnet"
}
```

### request-validation

Request third-party validation for an agent using the ERC-8004 validation registry. The validator will be notified and can respond with a score (0-100). Must be called by the agent owner or an approved operator. Requires an unlocked wallet.

```
bun run identity/identity.ts request-validation --validator <addr> --agent-id <id> --request-uri <uri> --request-hash <hex>
```

Options:
- `--validator` (required) — Stacks address of the validator
- `--agent-id` (required) — Agent ID to request validation for
- `--request-uri` (required) — URI with validation request details
- `--request-hash` (required) — Unique request hash as hex string (32 bytes / 64 hex chars)
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount
- `--sponsored` (flag) — Submit as a sponsored transaction

Output:
```json
{
  "success": true,
  "txid": "0xghi...",
  "message": "Validation request submitted successfully",
  "validator": "SP3...",
  "agentId": 42,
  "requestHash": "a1b2c3...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/0xghi..."
}
```

### get-validation-status

Get the status of a validation request using the ERC-8004 validation registry. Returns validator, agent ID, response score (0-100), and response metadata.

```
bun run identity/identity.ts get-validation-status --request-hash <hex>
```

Options:
- `--request-hash` (required) — Request hash as hex string (32 bytes / 64 hex chars)

Output:
```json
{
  "success": true,
  "requestHash": "a1b2c3...",
  "validator": "SP3...",
  "agentId": 42,
  "response": 85,
  "responseHash": "d4e5f6...",
  "tag": "verified",
  "lastUpdate": 900000,
  "hasResponse": true,
  "network": "mainnet"
}
```

### get-validation-summary

Get validation summary for an agent using the ERC-8004 validation registry. Returns total validation count and average response score (0-100).

```
bun run identity/identity.ts get-validation-summary --agent-id <id>
```

Options:
- `--agent-id` (required) — Agent ID to get validation summary for

Output:
```json
{
  "success": true,
  "agentId": 42,
  "count": 3,
  "averageResponse": 88,
  "message": "3 validation(s) with average score 88/100",
  "network": "mainnet"
}
```

## Notes

- Read operations (get, get-reputation, get-validation-status, get-validation-summary) work without a wallet
- Write operations (register, give-feedback, request-validation) require an unlocked wallet (`bun run wallet/wallet.ts unlock`)
- Agent IDs are assigned by the contract upon registration — check the transaction result to find your assigned ID
- Feedback values use WAD encoding (18 decimals) internally; summaryValue is the raw WAD string
- Validation response scores are integers from 0 to 100
- Request hashes must be unique 32-byte values provided as 64-character hex strings
