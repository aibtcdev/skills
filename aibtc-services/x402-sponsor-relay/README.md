# x402-sponsor-relay

Gasless transaction sponsorship service for AI agents on the Stacks blockchain. Accepts pre-signed sponsored transactions, covers the gas fee, verifies payment parameters, and broadcasts to the network.

- **GitHub:** https://github.com/aibtcdev/x402-sponsor-relay
- **Production:** https://x402-relay.aibtc.com (Stacks mainnet)
- **Staging:** https://x402-relay.aibtc.dev (Stacks testnet)
- **Docs:** https://x402-relay.aibtc.com/docs (Swagger UI)
- **Stack:** Cloudflare Workers, Hono.js, Chanfana, Durable Objects (SQLite)

## Purpose

Enables AI agents to perform Stacks transactions without holding STX for gas fees. Agents build sponsored transactions (fee = 0) and submit them to this relay, which sponsors the fee and broadcasts to the network. Also implements the x402 v2 facilitator API for compatibility with standard x402 client libraries.

## Agent Discovery Chain

| URL | Format | Purpose |
|-----|--------|---------|
| `https://x402-relay.aibtc.com/.well-known/agent.json` | JSON | A2A agent card: capabilities, auth methods, network config |
| `https://x402-relay.aibtc.com/llms.txt` | Plaintext | Quick-start: relay flow, key provisioning, examples |
| `https://x402-relay.aibtc.com/llms-full.txt` | Plaintext | Full reference: all endpoints, SIP-018 auth, receipt system |
| `https://x402-relay.aibtc.com/topics` | JSON | Topic documentation index |
| `https://x402-relay.aibtc.com/topics/sponsored-transactions` | Plaintext | Full relay flow with transaction diagram |
| `https://x402-relay.aibtc.com/topics/api-keys` | Plaintext | Key provisioning via BTC/STX sig, tiers, expiry |
| `https://x402-relay.aibtc.com/topics/authentication` | Plaintext | SIP-018 structured data auth |
| `https://x402-relay.aibtc.com/topics/errors` | Plaintext | All error codes with retry behavior |
| `https://x402-relay.aibtc.com/topics/x402-v2-facilitator` | Plaintext | x402 v2 spec compliance docs |

## Key Endpoints

### Core Relay

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | None | Service info |
| GET | `/health` | None | Health check with network and version |
| GET | `/docs` | None | Swagger UI documentation |
| GET | `/openapi.json` | None | OpenAPI 3.1 specification |
| POST | `/relay` | None | Submit pre-signed sponsored transaction for settlement |
| POST | `/sponsor` | API Key | Sponsor and broadcast transaction directly |
| GET | `/verify/:receiptId` | None | Verify a payment receipt |
| POST | `/access` | None | Access protected resource with receipt token |
| GET | `/fees` | None | Current fee estimates (clamped) |
| GET | `/stats` | None | Relay statistics (JSON) |
| GET | `/dashboard` | None | Public dashboard (HTML) |

### API Key Provisioning

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/keys/provision` | None | Provision API key via Bitcoin signature (BIP-137) |
| POST | `/keys/provision-stx` | None | Provision API key via Stacks signature |

### x402 v2 Facilitator (spec-compliant)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/settle` | None | Verify and broadcast payment (no sponsoring) |
| POST | `/verify` | None | Local validation only, no broadcast |
| GET | `/supported` | None | Supported payment kinds |

## Authentication

### Relay Endpoint (POST /relay)

No authentication required. Rate limited to 10 requests per minute per sender address.

Optional SIP-018 structured data authentication for enhanced security:
- Domain-bound signatures specific to x402-sponsor-relay
- Replay protection via nonce (unix timestamp ms)
- Time-bound authorization via expiry timestamp

### Sponsor Endpoint (POST /sponsor)

Requires an API key in the `Authorization: Bearer x402_sk_...` header.

**Obtaining a free API key:**

```bash
# Via Bitcoin signature (BIP-137)
POST /keys/provision
{
  "btcAddress": "bc1q...",
  "signature": "<BIP-137 signature of 'Bitcoin will be the currency of AIs'>",
  "message": "Bitcoin will be the currency of AIs"
}
```

Returns `{ apiKey: "x402_sk_..." }` valid for 30 days.

Note: During agent registration at aibtc.com, the platform automatically provisions a sponsor API key for the agent.

### API Key Tiers

| Tier | Requests/min | Requests/day | Daily Fee Cap |
|------|-------------|--------------|---------------|
| free | 10 | 100 | 100 STX |
| standard | 60 | 10,000 | 1,000 STX |
| unlimited | Unlimited | Unlimited | No cap |

## Relay Flow

Agents must build transactions with `sponsored: true` and `fee: 0n`:

1. Build a sponsored Stacks transaction (fee = 0)
2. Serialize to hex
3. POST to `/relay` with settlement parameters
4. Relay validates, sponsors fee, and broadcasts
5. Returns `txid`, `settlement` status, `sponsoredTx` hex, and `receiptId`
6. Use `GET /verify/:receiptId` to check confirmation

**Settlement states:**
- `confirmed` — Transaction confirmed on-chain within 60 seconds
- `pending` — Broadcast succeeded but confirmation timed out (safe, poll `/verify/:receiptId`)
- `failed` — Transaction aborted or dropped on-chain (not retryable)

**Idempotency:** Submitting the same sponsored tx hex within 5 minutes returns the cached result. Safe to retry on network failure.

## Request/Response Examples

### POST /relay

```json
{
  "transaction": "<hex-encoded-sponsored-tx>",
  "settle": {
    "expectedRecipient": "SP...",
    "minAmount": "1000000",
    "tokenType": "STX",
    "expectedSender": "SP..."
  }
}
```

```json
{
  "success": true,
  "txid": "0x...",
  "explorerUrl": "https://explorer.hiro.so/txid/0x...",
  "settlement": {
    "success": true,
    "status": "confirmed",
    "sender": "SP...",
    "recipient": "SP...",
    "amount": "1000000",
    "blockHeight": 12345
  },
  "sponsoredTx": "0x00000001...",
  "receiptId": "550e8400-..."
}
```

### POST /keys/provision

```json
{
  "btcAddress": "bc1q...",
  "signature": "H9L5yLFj...",
  "message": "Bitcoin will be the currency of AIs"
}
```

```json
{
  "success": true,
  "apiKey": "x402_sk_test_a1b2c3d4...",
  "metadata": {
    "tier": "free",
    "expiresAt": "2026-03-22T12:00:00.000Z"
  }
}
```

## Related Skills

- `stx` — build and sign sponsored Stacks transactions
- `tokens` — SIP-010 token transfers with sponsorship
- `sbtc` — sBTC transfers with sponsorship

## Common Workflows

### Gasless STX Transfer

1. Build sponsored transaction with `@stacks/transactions` (`sponsored: true`, `fee: 0n`)
2. Serialize to hex
3. POST to `/relay` with expected recipient and minimum amount
4. Wait for `settlement.status === "confirmed"`

### Check Relay Dashboard

```
GET https://x402-relay.aibtc.com/dashboard
```

Public HTML dashboard showing recent transactions and relay statistics.

## GitHub

https://github.com/aibtcdev/x402-sponsor-relay
