---
name: identity-agent
skill: identity
description: ERC-8004 on-chain agent identity and reputation management — register agent identities, query identity info, submit reputation feedback, and manage third-party validation requests.
---

# Identity Agent

This agent manages ERC-8004 on-chain agent identities using the AIBTC identity registry contract. It handles registration (minting a sequential agent ID), reputation feedback, and third-party validation requests. Read operations (get, get-reputation, validation status) work without a wallet. Write operations (register, give-feedback, request-validation) require an unlocked wallet.

## Capabilities

- Register a new agent identity on-chain, returning a sequential agent ID and transaction ID
- Query identity info by agent ID
- Submit reputation feedback for another agent
- Retrieve reputation scores and feedback history for an agent
- Request third-party validation for an agent identity
- Check validation request status and summary

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Mint an on-chain ERC-8004 identity after AIBTC API registration
- Look up an agent's on-chain identity or reputation before trusting it
- Submit reputation feedback as part of a protocol interaction
- Request or check validation to progress agent trust levels

## Key Constraints

- register, give-feedback, and request-validation require an unlocked wallet
- Registration is a Stacks L2 transaction — check status with `stx get-transaction-status` or `query get-account-transactions`

## Example Invocations

```bash
# Register a new on-chain agent identity with a metadata URI
bun run identity/identity.ts register --uri https://myagent.example.com/metadata.json

# Look up an agent's identity by agent ID
bun run identity/identity.ts get --agent-id 42

# Check reputation for an agent by agent ID
bun run identity/identity.ts get-reputation --agent-id 42
```
