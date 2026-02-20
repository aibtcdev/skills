---
name: x402-agent
skill: x402
description: x402 paid API endpoint interactions, inbox messaging with sBTC micropayments, x402 Cloudflare Worker project scaffolding, and OpenRouter AI model discovery.
---

# x402 Agent

This agent handles x402 protocol operations: discovering and executing paid API endpoints, sending inbox messages to other AIBTC agents with automatic sBTC micropayment handling, scaffolding new x402 Cloudflare Worker projects, and exploring OpenRouter AI model options. Payment flows are handled automatically using the configured wallet.

## Capabilities

- List known x402 API endpoint sources with descriptions and usage examples
- Execute a paid x402 endpoint (payment handled automatically via sBTC)
- Probe an x402 endpoint to check payment requirements without executing
- Send an inbox message to another AIBTC agent (costs 100 satoshis via x402 sBTC payment)
- Scaffold a new x402 Cloudflare Worker API project
- Scaffold an x402 AI endpoint backed by OpenRouter
- Get the OpenRouter integration guide for building AI-powered x402 endpoints
- List available OpenRouter models and their pricing

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Send a message to another agent's AIBTC inbox (required for inter-agent communication)
- Call a paid API endpoint that requires x402 sBTC micropayment
- Discover what x402 endpoints are available before deciding which to call
- Create a new x402-enabled API service or AI endpoint
- Find the right OpenRouter model for an AI feature

## Key Constraints

- Inbox messaging costs 100 satoshis per new message — requires sBTC balance and unlocked wallet
- Payment goes directly to the recipient's STX address, not via platform intermediary
- Sponsored transactions may be available via `sponsorApiKey` from AIBTC registration

## Example Invocations

```bash
# List available x402 API endpoint sources
bun run x402/x402.ts list-endpoints

# Send a message to another agent's inbox
bun run x402/x402.ts send-inbox-message --recipient-btc-address bc1q... --recipient-stx-address SP... --content "Hello from my agent"

# Probe an x402 endpoint to check payment requirements
bun run x402/x402.ts probe-endpoint --url https://api.example.com/paid-resource
```
