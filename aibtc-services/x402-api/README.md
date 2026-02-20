# x402-api

Pay-per-use API marketplace exposing AI inference, Stacks blockchain utilities, hashing functions, and stateful storage — all gated by the x402 protocol on Stacks.

- **GitHub:** https://github.com/aibtcdev/x402-api
- **Production:** https://x402.aibtc.com (Stacks mainnet)
- **Staging:** https://x402.aibtc.dev (Stacks testnet)
- **Docs:** https://x402.aibtc.com/docs (Swagger UI)
- **Stack:** Cloudflare Workers, Hono.js, Chanfana (OpenAPI), Durable Objects (SQLite)

## Purpose

A pay-per-use API gateway where agents pay per request using the x402 protocol. Supports STX, sBTC, and USDCx as payment tokens. No API keys needed — just a Stacks wallet and a few microSTX per call.

## Agent Discovery Chain

| URL | Format | Purpose |
|-----|--------|---------|
| `https://x402.aibtc.com/.well-known/agent.json` | JSON | A2A agent card: skills, pricing, capabilities |
| `https://x402.aibtc.com/llms.txt` | Plaintext | Quick-start: what x402 is, tiers, payment flow |
| `https://x402.aibtc.com/llms-full.txt` | Plaintext | Full reference: all endpoints, schemas, examples |
| `https://x402.aibtc.com/topics` | Plaintext | Topic documentation index |
| `https://x402.aibtc.com/topics/inference` | Plaintext | LLM inference docs |
| `https://x402.aibtc.com/topics/hashing` | Plaintext | Hash endpoint docs |
| `https://x402.aibtc.com/topics/storage` | Plaintext | Storage endpoint docs |
| `https://x402.aibtc.com/topics/payment-flow` | Plaintext | x402 payment flow detail |
| `https://x402.aibtc.com/docs` | HTML | Swagger UI documentation |

All discovery routes are free (no payment required).

## API Categories

### Inference (`/inference/*`)

LLM chat completions via OpenRouter and Cloudflare AI.

| Endpoint | Description | Pricing |
|----------|-------------|---------|
| `GET /inference/openrouter/models` | List available models | Free |
| `POST /inference/openrouter/chat` | Chat completion via OpenRouter | Dynamic (cost + 20%) |
| `GET /inference/cloudflare/models` | List Cloudflare AI models | Free |
| `POST /inference/cloudflare/chat` | Chat completion via Cloudflare AI | Standard |

### Stacks Utilities (`/stacks/*`)

Stacks blockchain operations without needing a local node.

| Endpoint | Description | Pricing |
|----------|-------------|---------|
| `POST /stacks/address` | Validate and decode Stacks address | Standard |
| `POST /stacks/decode` | Decode Clarity values | Standard |
| `POST /stacks/profile` | Get account profile | Standard |
| `POST /stacks/verify` | Verify Stacks signature | Standard |

### Hashing (`/hashing/*`)

Clarity-compatible cryptographic hash functions.

| Endpoint | Description | Pricing |
|----------|-------------|---------|
| `POST /hashing/sha256` | SHA-256 hash | Standard |
| `POST /hashing/sha512` | SHA-512 hash | Standard |
| `POST /hashing/sha512-256` | SHA-512/256 hash | Standard |
| `POST /hashing/keccak256` | Keccak-256 hash | Standard |
| `POST /hashing/hash160` | Hash160 (Bitcoin-style) | Standard |
| `POST /hashing/ripemd160` | RIPEMD-160 hash | Standard |

### Storage (`/storage/*`)

Stateful per-agent storage with full lifecycle management.

| Endpoint | Description | Pricing |
|----------|-------------|---------|
| `POST /storage/kv` | Key-value store operations | Standard |
| `POST /storage/paste` | Text/content storage | Standard |
| `POST /storage/db` | Structured database operations | Standard |
| `POST /storage/sync` | Sync operations | Standard |
| `POST /storage/queue` | Queue operations | Standard |
| `POST /storage/memory` | In-memory operations | Standard |

## Pricing

| Tier | Cost | Applies To |
|------|------|------------|
| `free` | 0 | Model listing endpoints |
| `standard` | 0.001 STX | All paid endpoints (hashing, stacks, storage, Cloudflare AI) |
| `dynamic` | Varies | OpenRouter LLM (pass-through cost + 20% margin) |

## Payment

All paid endpoints use x402 v2 protocol with base64-encoded JSON headers.

**Supported tokens:** STX, sBTC, USDCx (select via `X-PAYMENT-TOKEN-TYPE` header)

**Payment flow:**

1. Request endpoint without payment header
2. Server returns HTTP 402 with `payment-required` header (base64-encoded requirements)
3. Client signs transaction and resends with `payment-signature` header (base64-encoded payload)
4. Payment verified via x402-relay, request processed
5. Response includes `payment-response` header (base64-encoded settlement result)

**Request headers:**
- `payment-signature` — Base64-encoded payment payload (on retry)
- `X-PAYMENT-TOKEN-TYPE` — Optional token selector (`STX`, `sBTC`, `USDCx`)

**Response headers:**
- `payment-required` — On 402: base64-encoded payment requirements
- `payment-response` — On success: base64-encoded settlement result

## Authentication

No API keys required. Payment via x402 protocol is the only authentication needed. The server identifies agents by their Stacks address derived from the payment transaction.

## Related Skills

- `x402` — x402 payment protocol integration
- `stx` — STX transfers for paying endpoints
- `sbtc` — sBTC payment option

## Configuration

**Environment variables (server-side):**

| Variable | Description |
|----------|-------------|
| `X402_SERVER_ADDRESS` | Stacks address receiving payments |
| `X402_NETWORK` | `mainnet` or `testnet` |
| `X402_FACILITATOR_URL` | x402 settlement relay URL |

**Production settlement:** https://x402-relay.aibtc.com
**Staging settlement:** https://x402-relay.aibtc.dev

## Common Workflows

### Discovery (no payment)

```bash
curl https://x402.aibtc.com/llms.txt
curl https://x402.aibtc.com/.well-known/agent.json
```

### SHA-256 Hash (standard tier)

```bash
# First request triggers 402:
curl -X POST https://x402.aibtc.com/hashing/sha256 \
  -H "Content-Type: application/json" \
  -d '{"data": "hello world"}'
# Returns: 402 with payment-required header

# After signing payment, retry with payment-signature header
```

### LLM Inference (dynamic pricing)

```bash
# List available models (free):
curl https://x402.aibtc.com/inference/openrouter/models

# Chat completion (dynamic pricing based on model + tokens):
# POST /inference/openrouter/chat with payment flow
```

## GitHub

https://github.com/aibtcdev/x402-api
