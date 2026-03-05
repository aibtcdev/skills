---
name: styx-agent
skill: styx
description: BTC→sBTC conversion via Styx protocol — full headless deposit flow including PSBT signing, broadcast, and status tracking.
---

# Styx Agent Instructions

## Prerequisites

1. Wallet must be unlocked (`bun run wallet/wallet.ts unlock`) for deposit operations
2. Wallet must have BTC balance at the `btcAddress` sufficient for deposit + fees
3. Pool must have available liquidity (check with `pool-status`)

## Decision Logic

**When to use Styx vs native sBTC deposit:**
- Styx: Fast, pool-based, smaller amounts (10k-1M sats), third-party liquidity
- Native sBTC (`sbtc/sbtc.ts deposit`): Direct protocol deposit, larger amounts, requires Taproot keys

**Pool selection:**
- `main` (default): Legacy pool, max 300k sats, supports sbtc/usda/pepe swaps
- `aibtc`: AI BTC pool, max 1M sats, supports sbtc/aibtc swaps

## Deposit Flow

1. **Pre-flight checks:**
   ```
   bun run styx/styx.ts pool-status --pool main
   bun run styx/styx.ts fees
   ```
   Verify `estimatedAvailable` > your deposit amount. Check fee rates.

2. **Execute deposit:**
   ```
   bun run styx/styx.ts deposit --amount 50000 --stx-receiver SP2GH... --btc-sender bc1q... --fee medium
   ```
   This handles the full flow: reservation → PSBT → sign → broadcast → status update.

3. **Track status:**
   ```
   bun run styx/styx.ts status --id <deposit-id>
   ```
   Poll until status reaches `confirmed`.

## Safety Checks

- **Never deposit more than pool's `estimatedAvailable`** — the deposit will fail
- **Verify BTC balance** covers amount + estimated fee before depositing
- **Min 10,000 sats** — deposits below this are rejected
- **Max varies by pool** — 300,000 sats (main) or 1,000,000 sats (aibtc)
- **Always update status after broadcast** — failing to do so locks pool liquidity

## Error Handling

| Error | Action |
|-------|--------|
| `HTTP error! status: 400` | Invalid params (check amount limits, addresses) |
| `HTTP error! status: 401` | API key issue — use default SDK instance |
| `HTTP error! status: 503` | Styx backend down — retry after 5 minutes |
| Insufficient pool liquidity | Wait or try the other pool |
| PSBT signing failure | Check wallet unlock state and BTC key availability |
| Broadcast failure | Check mempool.space for network congestion |

## Output Handling

The `deposit` command returns:
```json
{
  "success": true,
  "depositId": "abc123",
  "txid": "def456...",
  "explorerUrl": "https://mempool.space/tx/def456...",
  "amount": { "sats": 50000, "btc": "0.00050000" },
  "pool": "main",
  "status": "broadcast"
}
```

Extract `depositId` and `txid` for follow-up tracking.
