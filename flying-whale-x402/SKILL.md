---
name: flying-whale-x402
description: "Flying Whale x402 paid API client — query 7 live intelligence endpoints (market analysis, wallet report, risk score, contract audit, DeFi strategy, HODLMM analysis, full portfolio) via x402 micropayments on Stacks L2."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "list | probe | market-analysis | wallet-report | risk-score | contract-audit | defi-strategy | hodlmm-analysis | full-portfolio"
  entry: "flying-whale-x402/flying-whale-x402.ts"
  mcp-tools: ""
  requires: "wallet"
  tags: "l2, defi, write, mainnet-only, requires-funds"
---

# Flying Whale x402 Skill

## What it does
Client skill for Flying Whale's 7 x402 paid API endpoints on Cloudflare Workers. Each endpoint fetches real on-chain data (Hiro API, CoinGecko, mempool.space) and returns AI-powered structured analysis. Payment is per-call via x402 protocol using STX, sBTC, or USDCx.

## Why agents need it
Agents managing DeFi positions, auditing contracts, or monitoring portfolios on Stacks can get instant intelligence without building their own data pipelines. Pay-per-call with no signup or subscription.

## Pricing

| Tier | Endpoint | Price |
|------|----------|-------|
| Intelligence | market-analysis | 5,000 microSTX |
| Intelligence | wallet-report | 3,000 microSTX |
| Intelligence | risk-score | 2,000 microSTX |
| Professional | contract-audit | 50,000 microSTX |
| Professional | defi-strategy | 25,000 microSTX |
| Professional | hodlmm-analysis | 10,000 microSTX |
| Premium | full-portfolio | 100,000 microSTX |

## Safety notes
- All endpoints are POST with x402 payment header — each call costs microSTX.
- Read the price before calling. Use `probe` to check pricing without paying.
- `list` and `probe` are free (GET requests, no payment required).
- No wallet funds are moved directly — payment is handled by the x402 relay.

## Commands

### list
List all available endpoints with pricing and descriptions (free).
```
bun run flying-whale-x402/flying-whale-x402.ts list
```
Output:
```json
{
  "endpoints": [
    { "slug": "market-analysis", "name": "Market Analysis", "tier": "Intelligence", "price": 5000, "currency": "microSTX" },
    { "slug": "wallet-report", "name": "Wallet Report", "tier": "Intelligence", "price": 3000, "currency": "microSTX" }
  ],
  "total": 7,
  "accepts": ["STX", "sBTC", "USDCx"],
  "base": "https://flying-whale-api.flying-whale-ai.workers.dev"
}
```

### probe
Probe a specific endpoint for pricing and required input (free GET request).
```
bun run flying-whale-x402/flying-whale-x402.ts probe --endpoint market-analysis
```
Options:
- `--endpoint` (required) — Endpoint slug (e.g. `market-analysis`, `contract-audit`)

Output:
```json
{
  "service": "Market Analysis",
  "tier": "Intelligence",
  "price": "5,000 microSTX",
  "accepts": ["STX", "sBTC", "USDCx"],
  "requiredInput": { "query": "STX price analysis" },
  "endpoint": "https://flying-whale-api.flying-whale-ai.workers.dev/api/market-analysis"
}
```

### market-analysis
Real-time market analytics with live price data from CoinGecko and mempool.space. **5,000 microSTX**.
```
bun run flying-whale-x402/flying-whale-x402.ts market-analysis --query "STX price analysis"
```
Options:
- `--query` (required) — Market analysis query

### wallet-report
On-chain wallet classification from Hiro API balance and transaction data. **3,000 microSTX**.
```
bun run flying-whale-x402/flying-whale-x402.ts wallet-report --address SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW
```
Options:
- `--address` (required) — Stacks address to analyze

### risk-score
Deterministic DeFi risk scoring from on-chain positions. **2,000 microSTX**.
```
bun run flying-whale-x402/flying-whale-x402.ts risk-score --address SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW
```
Options:
- `--address` (required) — Stacks address to score

### contract-audit
Deep Clarity security audit of deployed contract source code. **50,000 microSTX**.
```
bun run flying-whale-x402/flying-whale-x402.ts contract-audit --contract-id SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.nft-trait
```
Options:
- `--contract-id` (required) — Fully qualified contract ID (SPaddress.contract-name)

### defi-strategy
Personalized DeFi strategy based on wallet holdings and risk tolerance. **25,000 microSTX**.
```
bun run flying-whale-x402/flying-whale-x402.ts defi-strategy --address SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW --goals "maximize yield" --risk-tolerance moderate
```
Options:
- `--address` (required) — Stacks address
- `--goals` (optional, default: "maximize yield") — Investment goals
- `--risk-tolerance` (optional, default: "moderate") — Risk tolerance: conservative, moderate, aggressive

### hodlmm-analysis
Bitflow HODLMM liquidity pool analysis with live market data. **10,000 microSTX**.
```
bun run flying-whale-x402/flying-whale-x402.ts hodlmm-analysis --pool stx-sbtc --address SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW
```
Options:
- `--pool` (required) — Pool identifier (e.g. `stx-sbtc`)
- `--address` (optional) — Stacks address for position-specific analysis

### full-portfolio
Complete portfolio intelligence combining all data sources. **100,000 microSTX**.
```
bun run flying-whale-x402/flying-whale-x402.ts full-portfolio --address SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW
```
Options:
- `--address` (required) — Stacks address for full portfolio analysis

## Output contract
All outputs are JSON to stdout. Paid endpoints return the upstream API response directly.

On error:
```json
{ "error": "descriptive error message" }
```

## Payment token flow

The `--payment-token` flag supplies an x402 payment credential for paid endpoint calls. Here's how it works:

1. **Token source**: The payment token is issued by the [x402 relay](https://x402-relay.aibtc.com) after the caller authorizes a micropayment from their Stacks wallet (STX, sBTC, or USDCx).
2. **How it's used**: The skill attaches the token as an `X-PAYMENT` header on the POST request. The Cloudflare Worker validates it with the relay before processing.
3. **Agent integration**: Agents with wallet access obtain the token automatically through the x402 protocol handshake — the relay returns a 402 response with payment details, the agent signs the payment, and the relay returns the token for the actual request.
4. **Manual usage**: If calling directly, first `probe` the endpoint to see pricing, then obtain a token from the relay's `/authorize` endpoint with the required amount.

If `--payment-token` is omitted, the POST request is sent without the header and the upstream server will return a 402 Payment Required response with pricing details.

## Error handling

Paid endpoint calls (`postWithPayment`) do not retry on failure — errors are surfaced immediately as JSON. Expected failure modes:

| HTTP Status | Cause | What to do |
|-------------|-------|------------|
| 402 | Missing or invalid payment token | Check wallet balance, re-authorize via x402 relay |
| 400 | Invalid input parameters | Fix the request body (check `probe` output for required fields) |
| 500 | Upstream data source failure (Hiro, CoinGecko) | Wait and retry manually — transient |
| 502/503 | Cloudflare Worker or relay timeout | Transient — wait 30s and retry once manually |
| 504 | Gateway timeout (Premium tier, large portfolios) | Increase timeout or retry with simpler query |

No automatic retry is intentional — paid calls should not silently re-spend funds on transient failures. The agent or user should decide whether to retry.

## Known constraints
- Mainnet only — all endpoints query mainnet data sources.
- Requires funded wallet — x402 payments deduct from the caller's STX/sBTC/USDCx balance.
- Payment is handled by x402 relay (https://x402-relay.aibtc.com), not direct token transfer.
- Response times vary: Intelligence tier ~3-5s, Professional ~5-15s, Premium ~15-30s.
- AI analysis is powered by Claude Haiku via OpenRouter — results are interpretive, not deterministic.

## Operator
Flying Whale | ERC-8004 #54 | zaghmout.btc
BTC: bc1qdfm56pmmq40me84aau2fts3725ghzqlwf6ys7p
STX: SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW
