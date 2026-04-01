---
name: flying-whale-x402-agent
skill: flying-whale-x402
description: "Flying Whale x402 paid API client — 7 intelligence endpoints across 3 pricing tiers. Requires funded wallet for paid calls."
---

# Agent Behavior — Flying Whale x402

## Decision order

1. Call `list` to see all available endpoints and pricing (free).
2. Call `probe --endpoint <slug>` to check required input and exact price (free).
3. Confirm the user wants to spend the stated amount before calling a paid endpoint.
4. Call the specific endpoint with required parameters.
5. Parse the JSON response and present key findings to the user.

## When to use which endpoint

| User goal | Endpoint | Price |
|-----------|----------|-------|
| "What's happening with STX/BTC market?" | `market-analysis` | 5K |
| "Tell me about this wallet" | `wallet-report` | 3K |
| "How risky is this address?" | `risk-score` | 2K |
| "Is this contract safe?" | `contract-audit` | 50K |
| "What should I do with my DeFi positions?" | `defi-strategy` | 25K |
| "How is this HODLMM pool performing?" | `hodlmm-analysis` | 10K |
| "Give me a full picture of this portfolio" | `full-portfolio` | 100K |

## Guardrails

- Always call `probe` before a paid endpoint if the user hasn't confirmed the price.
- Never call `contract-audit` or `full-portfolio` without explicit user confirmation — these are high-cost.
- Never expose wallet passwords, private keys, or payment tokens in output.
- If an endpoint returns an error, do not retry automatically — surface the error to the user.
- `list` and `probe` are always safe to call — they are free GET requests.

## Output contract

All commands return JSON to stdout.

**list output:**
```json
{
  "endpoints": [{ "slug": "string", "name": "string", "tier": "string", "price": "number", "currency": "microSTX" }],
  "total": "number",
  "accepts": ["STX", "sBTC", "USDCx"],
  "base": "string"
}
```

**probe output:**
```json
{
  "service": "string",
  "tier": "string",
  "price": "string",
  "accepts": ["string"],
  "requiredInput": "object",
  "endpoint": "string"
}
```

**Paid endpoint output:** Varies by endpoint — structured JSON with analysis results.

## On error

- Errors are returned as JSON: `{ "error": "descriptive message" }`
- Common errors: "Payment failed", "Invalid input", "Upstream timeout"
- x402 payment errors mean insufficient balance or relay issue — check wallet balance.
- Do not retry silently — surface the error to the user.

## On success

- Present the key findings from the analysis in a readable format.
- Include the price paid and endpoint used for transparency.
- For `contract-audit`, highlight any security issues found.
- For `risk-score`, explain the risk level and what it means.
