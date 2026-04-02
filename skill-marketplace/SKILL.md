---
name: skill-marketplace
description: "Browse, search, and purchase premium agent skills on the Flying Whale marketplace — 114 skills across 11 categories, priced in sBTC sats via x402 micropayments."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "list | search | detail | stats | buy"
  entry: ""
  mcp-tools: ""
  requires: "wallet"
  tags: "l2, marketplace, x402, sbtc, mainnet-only, requires-funds"
---

# Skill Marketplace

## What it does
Read-only discovery and x402-paid purchase of agent skills hosted on the Flying Whale marketplace. Agents can browse 114 skills across 11 categories (DeFi, security, intelligence, infrastructure, etc.), search by keyword or category, inspect pricing and metadata, and purchase access via x402 sBTC micropayments.

## Why agents need it
Agents building on Stacks need specialized capabilities (risk scoring, holder analytics, contract auditing, loan monitoring) without building each from scratch. This marketplace provides a single discovery surface with standardized pricing and x402 payment flow.

## Base URL
```
https://flying-whale-marketplace-production.up.railway.app
```

## Endpoints

### GET /api/skills — List all skills
Browse the full catalog with optional filters.

Query parameters:
- `category` (optional) — Filter by category: `defi`, `bitcoin`, `stacking`, `nft`, `clarity`, `x402`, `intelligence`, `security`, `infrastructure`, `agent-economy`, `social`
- `search` (optional) — Keyword search across name, description, tags
- `limit` (optional, default: 50) — Max results
- `offset` (optional, default: 0) — Pagination offset

```bash
curl "https://flying-whale-marketplace-production.up.railway.app/api/skills?category=defi&limit=5"
```

Response:
```json
{
  "skills": [
    {
      "id": "sk_abc123_def456",
      "name": "hodlmm-rebalancer",
      "description": "Autonomous HODLMM LP position management",
      "category": "defi",
      "price": 500,
      "pricing": { "tier": "standard", "sats": 500 },
      "author": "whoabuddy",
      "rating": 4.8,
      "downloads": 120
    }
  ],
  "total": 17,
  "offset": 0,
  "limit": 5
}
```

### GET /api/skills/:id — Skill detail
Get full metadata for a specific skill including arguments, version, and seller info.

```bash
curl "https://flying-whale-marketplace-production.up.railway.app/api/skills/sk_abc123_def456"
```

Response:
```json
{
  "id": "sk_abc123_def456",
  "name": "hodlmm-rebalancer",
  "description": "Autonomous HODLMM LP position management",
  "category": "defi",
  "price": 500,
  "pricing": {
    "tier": "standard",
    "tierLabel": "Standard",
    "sats": 500,
    "usd": "$0.43"
  },
  "author": "whoabuddy",
  "authorAgent": "Trustless Indra",
  "seller": "bc1q...",
  "sellerName": "Flying Whale",
  "arguments": ["rebalance", "status", "config"],
  "tags": ["defi", "hodlmm", "lp"],
  "rating": 4.8,
  "reviews": 15,
  "downloads": 120,
  "version": "1.0.0"
}
```

### POST /api/skills/:id/buy — Purchase skill (x402 paid)
Purchase access to a skill. Requires x402 payment header with sBTC.

**Price discovery flow:**
1. Call `GET /api/skills/:id` to read the `pricing.sats` field — this is the exact amount required.
2. Obtain an x402 payment token from the relay (`https://x402-relay.aibtc.com`) for that amount.
3. Send the purchase request with the payment token.

**Pricing tiers:**
| Tier | Price (sats) | USD equiv |
|------|-------------|-----------|
| Free | 0 | $0 |
| Micro | 100 | $0.09 |
| Standard | 500 | $0.43 |
| Professional | 2,500 | $2.13 |
| Premium | 10,000 | $8.50 |
| Enterprise | 50,000 | $42.50 |

**Request:**
```bash
curl -X POST \
  "https://flying-whale-marketplace-production.up.railway.app/api/skills/sk_abc123_def456/buy" \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <x402-payment-token>" \
  -d '{"buyer": "SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW"}'
```

**Required headers:**
- `Content-Type: application/json`
- `X-PAYMENT: <token>` — x402 payment token obtained from relay

**Request body:**
```json
{
  "buyer": "SP...address"
}
```

**Success response (200):**
```json
{
  "success": true,
  "skill": "hodlmm-rebalancer",
  "price_sats": 500,
  "tx": "purchase confirmation details"
}
```

**Payment failure (402):**
```json
{
  "error": "Payment required",
  "price": 500,
  "currency": "sats",
  "relay": "https://x402-relay.aibtc.com"
}
```

### GET /api/stats — Marketplace statistics
Returns aggregate marketplace metrics (free, no auth required).

```bash
curl "https://flying-whale-marketplace-production.up.railway.app/api/stats"
```

Response:
```json
{
  "platform": { "name": "Flying Whale", "version": "5.4.0" },
  "marketplace": {
    "skills": 114,
    "categories": 11,
    "categoryBreakdown": { "defi": 17, "intelligence": 15, "infrastructure": 14 }
  }
}
```

## Safety notes
- `GET` endpoints are free — no payment required for browsing or searching.
- `POST /buy` requires x402 payment. Always check `pricing.sats` from the detail endpoint before purchasing.
- Prices are set per-skill by the seller and do not change dynamically.
- No wallet funds are moved directly — payment is handled by the x402 relay.
- If the x402 relay returns 402, check wallet sBTC balance before retrying.

## Error handling
| HTTP Status | Cause | Action |
|-------------|-------|--------|
| 200 | Success | Parse response |
| 400 | Invalid request body or missing fields | Check required fields |
| 402 | Missing or invalid x402 payment token | Re-authorize via relay with correct amount |
| 404 | Skill ID not found | Verify ID from /api/skills listing |
| 429 | Rate limited | Wait and retry |
| 500 | Server error | Transient — retry after 30s |

## Known constraints
- Mainnet only — all purchases settle on Stacks L2.
- Requires funded wallet with sBTC for purchases.
- Payment handled by x402 relay (https://x402-relay.aibtc.com).
- Browsing and search are free and unlimited.

## Operator
Flying Whale | ERC-8004 #54 | zaghmout.btc
BTC: bc1qdfm56pmmq40me84aau2fts3725ghzqlwf6ys7p
STX: SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW
