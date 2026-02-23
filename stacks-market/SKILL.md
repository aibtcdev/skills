---
name: stacks-market
description: "Prediction market trading on stacksmarket.app — discover markets, quote LMSR prices, buy/sell YES/NO shares, and redeem winnings. Uses the market-factory-v18-bias contract on Stacks mainnet. Write operations require an unlocked wallet with STX."
user-invocable: false
arguments: list-markets | search-markets | get-market | quote-buy | quote-sell | buy-yes | buy-no | sell-yes | sell-no | redeem | get-position
requires: [wallet]
tags: [l2, defi, prediction-market, write, mainnet-only, requires-funds]
---

# Stacks Market — Prediction Market Skill

Trade prediction markets on [stacksmarket.app](https://www.stacksmarket.app) via the on-chain contract `SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA.market-factory-v18-bias`.

## Contract Overview

- **Type**: LMSR (Logarithmic Market Scoring Rule) with bias/virtual liquidity
- **Currency**: STX (1 share = 1 STX = 1,000,000 uSTX)
- **Market IDs**: Epoch millisecond timestamps (e.g., `1771853629839`)
- **Shares**: YES and NO — if your side wins, each share redeems for 1 STX

## Discovering Markets

### REST API (primary method)

Base URL: `https://api.stacksmarket.app`

#### List / Search Markets

```bash
# All markets (paginated)
curl -s "https://api.stacksmarket.app/api/polls?limit=20"

# Search by keyword
curl -s "https://api.stacksmarket.app/api/polls?search=bitcoin&limit=10"
```

#### Filter Parameters

| Parameter | Values | Notes |
|-----------|--------|-------|
| `search` | keyword string | Searches title/description |
| `limit` | number | Results per page |
| `isActive` | `true` / `false` | API-level active flag |
| `isResolved` | `true` | Only resolved markets |
| `status` | `active` / `ended` / `resolved` | Status filter |
| `featured` | `true` | Featured markets only |
| `category` | `Crypto`, `Politics`, etc. | Category filter |

#### Get Single Market (with trade history)

```bash
# Use MongoDB _id (NOT marketId)
curl -s "https://api.stacksmarket.app/api/polls/{_id}"
```

Returns: full poll object + `orderBook` + `tradeHistory` array.

#### Response Structure

```json
{
  "polls": [
    {
      "_id": "699c573ea7bb5ad25fee68a0",
      "marketId": "1771853629839",
      "title": "Will BTC close between $65,500 and $66,500 at 17:00 UTC?",
      "description": "Full resolution rules and source...",
      "category": "Politics",
      "options": [
        {
          "text": "Yes",
          "impliedProbability": 48,
          "totalVolume": 237,
          "totalTrades": 2
        },
        {
          "text": "No",
          "impliedProbability": 52,
          "totalVolume": 169,
          "totalTrades": 1
        }
      ],
      "endDate": "2026-02-23T16:30:00.000Z",
      "isActive": true,
      "isResolved": false,
      "winningOption": null,
      "totalVolume": 209040000,
      "totalTrades": 3,
      "uniqueTraders": 3,
      "maxTradeLimit": 100000000,
      "creationStatus": "confirmed"
    }
  ]
}
```

#### Market State Logic

Check BOTH API fields AND time to determine true status:

```python
from datetime import datetime, timezone
now = datetime.now(timezone.utc)
end = datetime.fromisoformat(poll["endDate"].replace("Z", "+00:00"))

tradeable = poll["isActive"] and not poll["isResolved"] and end > now
ended_unresolved = not poll["isResolved"] and end <= now
resolved = poll["isResolved"]  # winningOption: 0=Yes, 1=No
```

**Important**: `isActive` can be `True` even after `endDate` passes — the admin must manually resolve.

### On-Chain Queries (for live pricing data)

```bash
# Encode market ID as Clarity uint: 0x01 + 16-byte big-endian hex
MARKET_ID=1771853629839
HEX_ARG=$(python3 -c "print('0x01' + format($MARKET_ID, '032x'))")

curl -s -X POST "https://api.hiro.so/v2/contracts/call-read/SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA/market-factory-v18-bias/get-market-snapshot" \
  -H "Content-Type: application/json" \
  -d "{\"sender\":\"SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA\",\"arguments\":[\"$HEX_ARG\"]}"
```

### Read-Only Functions

| Function | Args | Returns |
|----------|------|---------|
| `get-market-snapshot` | `(m uint)` | Full market state tuple |
| `get-status` | `(m uint)` | `"open"` or `"resolved"` |
| `get-pool` | `(m uint)` | Pool balance in uSTX |
| `get-b` | `(m uint)` | Liquidity parameter (STX) |
| `get-yes-balance` | `(m uint) (who principal)` | User's YES shares |
| `get-no-balance` | `(m uint) (who principal)` | User's NO shares |
| `get-yes-supply` | `(m uint)` | Total YES shares outstanding |
| `get-no-supply` | `(m uint)` | Total NO shares outstanding |
| `get-cap` | `(m uint) (who principal)` | User's spending cap (uSTX) |
| `get-spent` | `(m uint) (who principal)` | User's amount spent (uSTX) |
| `get-fee-params` | none | `{protocolBps, lpBps, pctDrip, pctBrc, pctTeam}` |

## Quoting Prices

Always quote before buying to see the actual cost.

### Quote Buy (by share count)
```
quote-buy-yes (m uint) (amount uint)  → {cost, feeProtocol, feeLP, total, drip, brc20, team}
quote-buy-no  (m uint) (amount uint)  → same
```
- `amount` = number of shares (in STX units, `u10` = 10 shares)
- `total` = what you'll actually pay in uSTX

### Quote Buy (by budget)
```
quote-buy-yes-by-sats (m uint) (budget uint)  → {shares, budget, baseBudget, quote}
quote-buy-no-by-sats  (m uint) (budget uint)  → same
```
- `budget` = total uSTX to spend (e.g., `u5000000` = 5 STX)

### Quote Sell
```
quote-sell-yes (m uint) (amount uint)  → {proceeds, feeProtocol, feeLP, total, drip, brc20, team}
quote-sell-no  (m uint) (amount uint)  → same
```
- `total` = net proceeds you receive (after fees) in uSTX

### Quoting via Hiro API (recommended)

MCP `call_read_only_function` returns `okay: false` for quote functions. Use the Hiro API directly:

```bash
MARKET_ID=1770756378700
HEX_M=$(python3 -c "print('0x01' + format($MARKET_ID, '032x'))")
HEX_AMT="0x0100000000000000000000000000000002"  # u2

curl -s -X POST "https://api.hiro.so/v2/contracts/call-read/SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA/market-factory-v18-bias/quote-buy-no" \
  -H "Content-Type: application/json" \
  -d "{\"sender\":\"YOUR_STX_ADDRESS\",\"arguments\":[\"$HEX_M\",\"$HEX_AMT\"]}"
```

Response is a hex-encoded Clarity tuple. To decode the `total` field:
```python
# Find "total" in hex: 05746f74616c = string "total"
# After field name: type byte 01 (uint) + 16 hex digits = value
idx = result_hex.find('05746f74616c01')
total_ustx = int(result_hex[idx+14:idx+46], 16)
total_stx = total_ustx / 1_000_000
```

## Buying Shares

### Auto Buy (RECOMMENDED — sets cap + slippage protection)
```clarity
(contract-call? .market-factory-v18-bias buy-yes-auto
  (m uint)           ;; market ID (epoch millis)
  (amount uint)      ;; shares to buy (STX units)
  (target-cap uint)  ;; spending cap in uSTX (bumps up if needed)
  (max-cost uint)    ;; max total cost in uSTX (slippage protection)
)

(contract-call? .market-factory-v18-bias buy-no-auto
  (m uint) (amount uint) (target-cap uint) (max-cost uint)
)
```

### Via MCP Tools

```bash
# Execute buy (broadcasts tx, costs STX)
mcporter call aibtc.call_contract \
  contractAddress="SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA" \
  contractName="market-factory-v18-bias" \
  functionName="buy-no-auto" \
  functionArgs='[1770756378700, 2, 2000000, 2000000]'
```

### ⚠️ Critical: MCP Arg Format Differences

| Tool | Arg format | Example |
|------|-----------|---------|
| `call_contract` (write) | **Numeric JSON** | `[1770756378700, 2, 2000000, 2000000]` |
| `call_read_only_function` | Clarity strings | `["u1770756378700", "u1"]` |
| Hiro API direct | Hex-encoded | `"0x01" + 16-byte big-endian` |

**`call_contract` rejects Clarity "u..." strings with `BadFunctionArgument`**. Always use plain numbers.

### Simple Buy (requires pre-set cap)
```clarity
(contract-call? .market-factory-v18-bias buy-yes (m uint) (amount uint))
(contract-call? .market-factory-v18-bias buy-no  (m uint) (amount uint))
```
Fails with `u730` if no spending cap is set. Use `*-auto` instead.

## Selling Shares

### Auto Sell (RECOMMENDED — slippage protection)
```clarity
(contract-call? .market-factory-v18-bias sell-yes-auto
  (m uint) (amount uint) (min-proceeds uint)
)
(contract-call? .market-factory-v18-bias sell-no-auto
  (m uint) (amount uint) (min-proceeds uint)
)
```

### Simple Sell
```clarity
(contract-call? .market-factory-v18-bias sell-yes (m uint) (amount uint))
(contract-call? .market-factory-v18-bias sell-no  (m uint) (amount uint))
```

## Redeeming After Resolution

When a market is resolved (`isResolved: true`, `winningOption: 0 or 1`):
```clarity
(contract-call? .market-factory-v18-bias redeem (m uint))
```
- Winning shares pay 1 STX each (1,000,000 uSTX)
- Losing shares pay nothing
- Burns all your shares and transfers payout

## Pricing Model (LMSR)

The contract uses a **Logarithmic Market Scoring Rule** with bias:

- **Price** of YES ≈ `exp(qYes/b) / (exp(qYes/b) + exp(qNo/b))` (adjusted for bias)
- **b** = liquidity parameter (`initialLiquidity / ln(2)`)
- **Bias** shifts initial pricing without affecting redemption value
- LMSR guarantees market always has liquidity (no empty order book)

**Cost formula**: `b * ln(exp((q+n)/b) + exp(q'/b)) - b * ln(exp(q/b) + exp(q'/b))`

## Fee Structure

- **Protocol fee**: split among drip vault (50%), BRC20 vault (30%), team wallet (20%)
- **LP fee**: sent to LP wallet
- Fees calculated as basis points on base cost
- Current fee params readable via `get-fee-params`

## Error Codes

| Code | Meaning |
|------|---------|
| u100 | Market not open |
| u704 | Invalid amount (zero) |
| u706 | Only admin |
| u720 | Market paused |
| u721 | Market not initialized |
| u722 | Exceeds max trade limit |
| u730 | No spending cap set (use `*-auto` functions) |
| u731 | Exceeds spending cap |
| u732 | Slippage exceeded |
| u760 | Insufficient STX balance |
| u770 | No shares to sell |
| u771 | Pool liquidity insufficient |
| u783 | Trade would make pool insolvent |

## Workflow

1. **Discover** — `GET /api/polls?search=keyword&limit=10`
2. **Filter** — `endDate > now` AND `isActive=true` AND `isResolved=false`
3. **Quote** — Hiro API `call-read` with `quote-buy-yes` / `quote-buy-no`
4. **Buy** — MCP `call_contract` with `buy-yes-auto` / `buy-no-auto` (numeric args)
5. **Monitor** — Re-query API or `get-market-snapshot`
6. **Sell** (optional) — `sell-*-auto` to exit before resolution
7. **Redeem** — After resolution, call `redeem` to collect winnings

## Gotchas & Lessons Learned

1. **MCP `call_contract` needs numeric args** — `["u1770756378700"]` fails with `BadFunctionArgument`. Use `[1770756378700]`.
2. **MCP `call_read_only_function` fails for quote functions** — returns `okay: false`. Use Hiro API directly.
3. **Hex encoding for Hiro API**: uint128 = `0x01` + 16-byte big-endian. Python: `'0x01' + format(market_id, '032x')`
4. **Decoding responses**: Find field name in hex (e.g., `05746f74616c` = "total"), skip type byte, read 16 hex digits.
5. **Set `target-cap >= max-cost`** — cap is per-market cumulative.
6. **Gas fees**: ~0.05-0.1 STX per tx on top of share cost.
7. **Redeem after resolution** — winnings don't auto-distribute.
8. **`isActive` outlives `endDate`** — always compare time, not just the flag.
9. **`_id` vs `marketId`** — detail endpoint needs MongoDB `_id`, not `marketId`.
