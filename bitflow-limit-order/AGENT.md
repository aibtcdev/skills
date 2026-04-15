---
name: bitflow-limit-order-agent
skill: bitflow-limit-order
description: "Agent behavior rules for Bitflow limit order execution — price-conditional swap automation."
---

# Agent Behavior: bitflow-limit-order

## Decision Order

1. **Doctor first** — On first use or any error, run `doctor` to verify wallet, API, and storage.
2. **Check before set** — Before creating an order, verify the pair exists and the wallet has sufficient balance.
3. **Heartbeat = run** — Every 5-minute heartbeat cycle should include `run --confirm` to check and execute pending orders.
4. **One at a time** — Process orders sequentially. Never execute multiple swaps in a single `run` cycle.
5. **Respect expiry** — Expire orders that have passed their deadline before checking prices.

## Guardrails

### Spend Limits (Hardcoded — NOT configurable)
- **Max per order:** 2000 STX or 0.005 sBTC
- **Max active orders:** 10
- **Max slippage:** 5% (enforced even if user requests higher)

### Refusal Conditions
The agent MUST refuse to execute if:
- Wallet balance is insufficient for the order amount + estimated fees
- Slippage exceeds the order's configured threshold
- The pool is inactive or not found
- Nonce is out of sequence (check before broadcast)
- Order has expired

### Error Handling
- **Never silently retry** failed swaps — mark the order as `error` with the failure reason
- **Never skip balance checks** — verify on every `run` cycle, not just at `set` time
- **Surface all errors** to the user via JSON output with clear `error` messages

## Autonomous Scheduling

- **Frequency:** Every 5 minutes via agent heartbeat
- **Action:** Run `run --confirm` to check all active orders
- **Idle behavior:** If no orders are active, `run` returns quickly with `checked: 0`

## Risk Management Tiers

| Risk Level | Criteria | Action |
|-----------|----------|--------|
| **Low** | Price >5% from target | Log distance, continue |
| **Medium** | Price within 2-5% of target | Log proximity warning |
| **High** | Price at or past target | Execute swap if all guards pass |

## Integration Notes

- **Price oracle:** Uses HODLMM pool active bin mid-price — this is an on-chain oracle, not an off-chain feed
- **Swap execution:** Uses BitflowSDK for routing, `@stacks/transactions` for broadcast
- **State:** Local JSON file at `~/.aibtc/limit-orders/orders.json` — portable, no database required
- **Wallet:** Reads from AIBTC MCP server keystore or `STACKS_PRIVATE_KEY` env var

## Example Heartbeat Flow

```
1. Load orders from disk
2. Filter: active only, not expired
3. For each order (sequential):
   a. Fetch pool active bin price
   b. Compare to target
   c. If triggered:
      - Verify balance
      - Execute swap via BitflowSDK
      - Record fill (txId, price, timestamp)
      - Mark order "filled"
   d. If not triggered: log distance
4. Expire any past-deadline orders
5. Output summary JSON
```
