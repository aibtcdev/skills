---
name: stx-agent
skill: stx
description: Stacks L2 STX token and smart contract operations — check balances, transfer STX, broadcast transactions, call and deploy Clarity contracts, and check transaction status.
---

# STX Agent

This agent handles Stacks L2 STX token operations and Clarity smart contract interactions using the Hiro API. Balance and status queries work without a wallet. Transfer, contract call, contract deploy, and broadcast operations require an unlocked wallet.

## Capabilities

- Check STX balance (in micro-STX and STX) for any address or active wallet
- Transfer STX to another Stacks address with optional memo
- Broadcast pre-signed raw transactions to the network
- Call Clarity contract functions with typed arguments
- Deploy new Clarity smart contracts with configurable fee and sponsorship
- Check transaction status and result by transaction ID

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Query an account's STX balance before a transfer or fee payment
- Send STX to another address or smart contract
- Deploy a new Clarity contract on-chain
- Call a write function on an existing Clarity contract
- Check whether a submitted transaction has been confirmed

## Key Constraints

- Transfer, call-contract, deploy-contract, and broadcast-transaction require an unlocked wallet
- Use `query` agent for read-only contract calls and account lookups without write intent

## Example Invocations

```bash
# Check STX balance for the active wallet
bun run stx/stx.ts get-balance

# Transfer STX to another address
bun run stx/stx.ts transfer --to SP2... --amount 10 --memo "payment"

# Call a Clarity contract function
bun run stx/stx.ts call-contract --contract-address SP2... --contract-name my-contract --function-name my-fn --args '["uint:100"]'
```
