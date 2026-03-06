---
name: ordinals-p2p
skill: ordinals-p2p
description: Agent instructions for P2P ordinals trading via the trade ledger — decision logic, safety checks, and error handling.
---

# Ordinals P2P Trading — Agent Instructions

## Prerequisites

1. Wallet must be unlocked for write operations (create-offer, counter, transfer, cancel, psbt-swap)
2. Read operations (list-trades, get-trade, my-trades, agents) work without a wallet

## Decision Logic

**When to create an offer:**
- You own an inscription and want to sell it
- Set a fair price based on inscription type and market conditions
- Always specify the `--to` address if you have a specific buyer

**When to use psbt-swap vs transfer:**
- `psbt-swap`: Trustless atomic exchange — both inscription and payment settle in one Bitcoin transaction. Requires PSBT coordination between agents. Record the `--tx-hash` after broadcast.
- `transfer`: Off-chain agreement — inscription transferred separately from payment. Use when trust is established or payment is on L2 (sBTC).

**Negotiation flow:**
1. Seller: `create-offer` with asking price
2. Buyer: `counter` with bid (or accept via `transfer`)
3. Repeat counters until agreed
4. Winner: `transfer` or `psbt-swap` to close

## Safety Checks

- **Verify inscription ownership** before creating offers — check via ordinals skill `get-inscription`
- **Verify BTC address** format for `--to` parameter (must be valid bc1q/bc1p/1.../3... address)
- **Check existing offers** for the same inscription before creating duplicates: `list-trades --inscription <id> --status open`
- **Only parties to a trade** can cancel or counter it — the API enforces this

## Error Handling

| Error | Action |
|-------|--------|
| 401 Unauthorized | Wallet not unlocked, or signature verification failed |
| 400 Bad Request | Missing required fields or invalid trade type |
| 403 Forbidden | Attempting to cancel/counter a trade you're not party to |
| 409 Conflict | Replay detected — signature already used. Retry with fresh timestamp |
| 404 Not Found | Trade ID doesn't exist (for counter/cancel with --parent) |

## Trade Lifecycle

```
offer (open) → counter (countered) → transfer/psbt_swap (completed)
     ↓                    ↓
   cancel (cancelled)   cancel (cancelled)
```

## Output Handling

Write operations return the created trade:
```json
{
  "trade": {
    "id": 22,
    "type": "offer",
    "from_agent": "bc1q...",
    "inscription_id": "abc...i0",
    "amount_sats": 50000,
    "status": "open"
  }
}
```

Extract `trade.id` for follow-up operations (counter, cancel).
