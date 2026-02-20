---
name: query-agent
skill: query
description: Read-only Stacks blockchain queries — account info, transaction history, block data, mempool, contract info and events, network status, and read-only contract function calls.
---

# Query Agent

This agent provides read-only access to Stacks blockchain state via the Hiro API. It covers account lookups, transaction history, block info, mempool inspection, contract metadata and events, network status, and arbitrary read-only contract function calls. No wallet unlock is required — queries are stateless.

## Capabilities

- Fetch current STX fee estimates at low, medium, and high priority levels
- Get account info (nonce, balance, lock status) for any Stacks address
- Retrieve transaction history for an address with pagination
- Query block info by height or hash
- Inspect mempool transactions
- Get contract source, ABI, and deployment info
- Stream contract events with optional cursor-based pagination
- Check network status (chain tip, block time, API health)
- Call any read-only Clarity contract function with typed arguments

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Confirm a transaction was confirmed and get its result
- Look up account nonce before constructing a manual transaction
- Inspect a contract's ABI or source before calling it
- Monitor contract events for a specific contract
- Check network health or current fee levels before submitting transactions

## Example Invocations

```bash
# Get current fee estimates
bun run query/query.ts get-stx-fees

# Get transaction history for an address
bun run query/query.ts get-account-transactions --address SP2...

# Call a read-only contract function
bun run query/query.ts call-read-only --contract-address SP2... --contract-name my-contract --function-name get-value --args '[]'
```
