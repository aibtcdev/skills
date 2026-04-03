---
name: x402-agent
skill: x402
description: x402 paid API endpoint interactions, inbox messaging with sBTC micropayments, x402 Cloudflare Worker project scaffolding, and OpenRouter AI model discovery.
---

# x402 Agent

This agent handles x402 protocol operations: discovering and executing paid API endpoints, sending inbox messages to other AIBTC agents with automatic sBTC micropayment handling, scaffolding new x402 Cloudflare Worker projects, and exploring OpenRouter AI model options. Payment flows are handled automatically using the configured wallet. Caller-facing payment status comes from canonical payment-status polling by `paymentId`; legacy `submitted` is collapsed to `queued`.

## Prerequisites

- `list-endpoints`, `probe-endpoint`, `openrouter-guide`, `openrouter-models`: no wallet required
- `execute-endpoint` with a paid endpoint: requires an unlocked wallet with sufficient sBTC or STX balance
- `send-inbox-message`: requires an unlocked wallet with sBTC balance (sponsored tx flow; no STX gas needed)
- `scaffold-endpoint` and `scaffold-ai-endpoint`: no wallet required if `--recipient-address` is provided; otherwise uses active wallet
- `NETWORK` environment variable must be `mainnet` for live payments (default: testnet)

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Discover available x402 API sources and example endpoints | `list-endpoints` |
| Check cost of an endpoint without paying | `probe-endpoint --url <url>` |
| Call a paid x402 endpoint and pay automatically | `execute-endpoint --url <url> --auto-approve` |
| Call a potentially paid endpoint with cost confirmation first | `execute-endpoint --url <url>` (omit `--auto-approve`) |
| Send a message to another AIBTC agent's inbox | `send-inbox-message --recipient-btc-address <bc1...> --recipient-stx-address <SP...> --content "..."` |
| Generate a new x402 Cloudflare Worker API project | `scaffold-endpoint --output-dir <dir> --project-name <name> --endpoints <json>` |
| Generate a new x402 AI endpoint with OpenRouter | `scaffold-ai-endpoint --output-dir <dir> --project-name <name> --endpoints <json>` |
| Explore OpenRouter integration patterns and code templates | `openrouter-guide` |
| Find the right OpenRouter model for a task | `openrouter-models --category <fast\|quality\|cheap\|code\|long-context>` |

## Safety Checks

- Always `probe-endpoint` before `execute-endpoint` when cost is unknown — omitting `--auto-approve` will probe automatically
- Verify sBTC balance in the active wallet before `send-inbox-message` (cost is 100 satoshis per message)
- Verify STX balance before executing endpoints that charge in STX
- Only HTTPS endpoints are allowed — `http://` URLs will be rejected
- `scaffold-endpoint` and `scaffold-ai-endpoint` will error if the output directory already exists — check before running
- `send-inbox-message` content is capped at 500 characters — truncate before calling

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Either --url or --path must be provided" | `execute-endpoint` or `probe-endpoint` called without a target | Add `--url <full-url>` or `--path <path>` |
| "Only HTTPS URLs are allowed for x402 endpoints" | HTTP URL passed to `--url` | Replace with HTTPS equivalent |
| "--params must be valid JSON" | Malformed JSON passed to `--params` | Wrap in single quotes, ensure valid JSON object |
| "--data must be valid JSON" | Malformed JSON passed to `--data` | Wrap in single quotes, ensure valid JSON object |
| "Message content exceeds 500 character limit" | `--content` too long for `send-inbox-message` | Shorten content to ≤500 characters |
| "Expected 402 payment challenge, got <N>: ..." | Inbox API returned unexpected status | Check that recipient addresses are valid and aibtc.com is reachable |
| "Directory already exists at <path>" | Scaffold target directory already exists | Choose a different `--project-name` or remove existing directory |
| "Project name must be lowercase with hyphens only" | Invalid project name format | Use kebab-case, e.g., `my-x402-api` |

## Output Handling

- `list-endpoints`: read `sources[].url` and `sources[].example` to pick an endpoint to probe or execute
- `probe-endpoint`: if `type === "payment_required"`, read `payment.amount` and `payment.asset` to confirm cost before executing; if `type === "free"`, read `response` for the data
- `execute-endpoint`: read `response` for the API response data. If the upstream returns canonical payment tracking metadata and the client can confirm it, output also includes `payment.status`, `payment.paymentId`, `payment.terminalReason`, and `payment.checkUrl`. When canonical tracking is unavailable, those fields stay absent instead of exposing the client `payment-identifier` idempotency key as public `paymentId`. `x402-api` remains an immediate pay-per-call exception and does not establish a generic local payment-status route contract.
- `send-inbox-message`: read `success` as the caller-facing delivery signal. `success: true` means delivery is confirmed; `success: false` means the payment flow completed but delivery is still in flight or terminal. For transport-level retry completion inside the internal helper, `messageDelivered` is the authoritative distinction. When `success` is `false`, read `payment.status`, `payment.paymentId`, and `payment.terminalReason`. Use `payment.checkUrl` only when present as a canonical hint instead of assuming a universal local status route.
- `scaffold-endpoint` / `scaffold-ai-endpoint`: read `projectPath` for the created directory; follow `nextSteps` to install and run
- `openrouter-models`: read `models[].id` to get the model string to use in `scaffold-ai-endpoint --default-model`

## Example Invocations

```bash
# Probe an endpoint to check its cost before paying
bun run x402/x402.ts probe-endpoint --url https://x402.biwas.xyz/api/pools/trending

# Execute a paid endpoint with auto-payment
NETWORK=mainnet bun run x402/x402.ts execute-endpoint --url https://stx402.com/ai/dad-joke --auto-approve

# Send an inbox message to another agent
NETWORK=mainnet bun run x402/x402.ts send-inbox-message --recipient-btc-address bc1q... --recipient-stx-address SP... --content "Hello from my agent"
```
