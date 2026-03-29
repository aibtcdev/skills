---
name: hodlmm-bin-guardian
skill: hodlmm-bin-guardian
description: "Autonomous LP range monitor for Bitflow HODLMM pools. Checks if a wallet's position is in the active earning bin and recommends HOLD or REBALANCE based on live Bitflow price data, gas estimates, and cooldown state. Read-only — all write actions require human approval."
---

# HODLMM Bin Guardian — Agent Safety Rules

## Decision order
- Maximum estimated gas per rebalance: **50 STX** (2 contract calls: withdraw + add)
- Slippage cap: **0.5%** — measured as deviation between HODLMM active-bin price and Bitflow app reported token price
- Cooldown between rebalances: **4 hours** (state tracked in `~/.hodlmm-guardian-state.json`)

## Guardrails
Refuse to recommend REBALANCE if ANY of the following are true:
1. **24h pool volume < $10,000 USD** — insufficient activity to justify rebalance cost
2. **Slippage > 0.5%** — HODLMM bin price deviates too far from Bitflow app token price
3. **Estimated gas > 50 STX** — transaction cost exceeds the spend limit
4. **Cooldown has not elapsed** — last rebalance was < 4 hours ago

## In-Range Check
The real in-range check requires a `--wallet` address. Without it, `in_range` is `null` and no REBALANCE recommendation is made.

When `--wallet` is provided:
- Fetches user's actual position bins from Bitflow: `/api/app/v1/users/{address}/positions/{poolId}/bins`
- Filters to bins where `user_liquidity > 0`
- `in_range = true` if `active_bin_id` is within the user's liquidity bins

## Autonomous Actions Allowed
- Fetch public API data (Bitflow HODLMM, Bitflow ticker, Hiro) — always allowed
- Compute and output JSON recommendation — always allowed
- Read/write cooldown state file (`~/.hodlmm-guardian-state.json`) — always allowed

## Actions Requiring Human Approval
- `add-liquidity-simple` — any transaction adding liquidity
- `withdraw-liquidity-simple` — any transaction withdrawing liquidity
- Any transaction spending STX or sBTC

## Output Contract
Always return strict JSON:
```json
{
  "status": "success | error",
  "action": "HOLD | REBALANCE | CHECK | <error description>",
  "data": {
    "in_range": "boolean | null",
    "active_bin": "number",
    "user_bin_range": "{ min, max, count, bins } | null",
    "can_rebalance": "boolean",
    "refusal_reasons": "string[] | null",
    "slippage_ok": "boolean",
    "slippage_pct": "number",
    "bin_price_raw": "number",
    "pool_price_usd": "number | null",
    "market_price_usd": "number | null",
    "slippage_source": "string",
    "gas_ok": "boolean",
    "gas_estimated_stx": "number",
    "cooldown_ok": "boolean",
    "cooldown_remaining_h": "number",
    "last_rebalance_at": "string | null",
    "volume_ok": "boolean",
    "volume_24h_usd": "number",
    "liquidity_usd": "number",
    "apr_24h_pct": "number",
    "pool_id": "string",
    "pool_name": "string",
    "fee_bps": "number"
  },
  "error": "null | { code, message, next }"
}
```
