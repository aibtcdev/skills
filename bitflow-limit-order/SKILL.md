---
name: bitflow-limit-order
description: "Agent-powered limit orders on Bitflow — set price targets, auto-execute swaps when conditions are met."
metadata:
  author: "ClankOS"
  author-agent: "Grim Seraph"
  user-invocable: "false"
  arguments: "doctor | set --pair <P> --side <S> --price <N> --amount <N> [--slippage <PCT>] [--expires <DURATION>] | list [--status <S>] [--events] [--order-id <N>] | cancel <ID> | run [--confirm] [--watch <INTERVAL>] [--confirm-ticks <N>] [--wallet-password <PW>] | install-packs"
  entry: "bitflow-limit-order/bitflow-limit-order.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# bitflow-limit-order

Agent-powered limit orders on Bitflow. Bitflow has no native limit-order support — the agent IS the order engine.

## What it does

Sets price targets on Bitflow HODLMM pools, polls active bin mid-prices on each heartbeat, and executes swaps autonomously when conditions are met. The agent maintains a local order book (`~/.aibtc/limit-orders/orders.json`), checks prices every 5 minutes via `run`, and fills orders that hit their target.

**Core flow:**
1. `set` — User creates a limit order with pair, side, price, amount, slippage, and expiry
2. `run` — Called every heartbeat: loads active orders, fetches pool prices, executes triggered swaps via BitflowSDK, expires stale orders
3. `list` / `cancel` — Manage the order book

```
User/Agent ──set──▶ Order File ──run──▶ Price Check ──trigger──▶ BitflowSDK Swap
                    (~/.aibtc/          (HODLMM active bin)      (on-chain tx)
                     limit-orders)
```

## Why agents need it

- **Zero limit order support exists on Bitflow** — no native UI, no Keeper contracts, no competing skills
- Every trader's #1 feature request on any DEX — high-leverage primitive
- Enables autonomous trading strategies: set-and-forget price targets
- HODLMM active bin provides an on-chain price oracle — no external feeds needed
- Write skill (executes actual swaps) — required for daily prize eligibility

## Commands

### `doctor`

Verify wallet, Bitflow API access, price feed, and order storage health.

```bash
bun run bitflow-limit-order/bitflow-limit-order.ts doctor
```

### `set`

Create a new limit order.

```bash
bun run bitflow-limit-order/bitflow-limit-order.ts set \
  --pair STX-sBTC \
  --side buy \
  --price 29000 \
  --amount 0.001 \
  --slippage 1 \
  --expires 24h
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--pair` | Yes | — | Trading pair (e.g., `STX-sBTC`) |
| `--side` | Yes | — | `buy` or `sell` |
| `--price` | Yes | — | Target price (HODLMM bin price units) |
| `--amount` | Yes | — | Amount of input token |
| `--slippage` | No | 1% | Max slippage percent (cap: 5%) |
| `--expires` | No | 24h | Expiry duration (e.g., `1h`, `24h`, `7d`) |

### `list`

Show all orders with their current status, or read the JSONL event-log audit trail.

```bash
bun run bitflow-limit-order/bitflow-limit-order.ts list
bun run bitflow-limit-order/bitflow-limit-order.ts list --status active
bun run bitflow-limit-order/bitflow-limit-order.ts list --events
bun run bitflow-limit-order/bitflow-limit-order.ts list --events --order-id 3
```

| Flag | Description |
|------|-------------|
| `--status <s>` | Filter orders by status |
| `--events` | Read `~/.aibtc/limit-orders/events.jsonl` instead of orders |
| `--order-id <n>` | With `--events`, restrict to one order |

### `cancel <ID>`

Cancel a pending order by ID.

```bash
bun run bitflow-limit-order/bitflow-limit-order.ts cancel 3
```

### `run`

Check all active orders against live pool prices. Execute any that trigger. Defaults to one-shot (single cycle, exits) — pass `--watch <interval>` to run as an in-process heartbeat loop.

```bash
# One-shot (called by external scheduler)
bun run bitflow-limit-order/bitflow-limit-order.ts run --confirm --wallet-password <PW>

# In-process loop, every 30s, with 2-tick anti-wick filter
bun run bitflow-limit-order/bitflow-limit-order.ts run --confirm --watch 30s --confirm-ticks 2
```

| Flag | Description |
|------|-------------|
| `--confirm` | Execute swaps on-chain. Without it, dry-run only. |
| `--watch <interval>` | Run in-process heartbeat loop (`5s`, `30s`, `1m`, `5m`, max `1h`). Without it, runs once and exits. |
| `--confirm-ticks <n>` | Anti-wick guard: require N consecutive triggering cycles before firing. Default `2`. Watch mode only. |
| `--wallet-password <pw>` | Keystore password (or set `AIBTC_WALLET_PASSWORD`, or use `STACKS_PRIVATE_KEY`). |

**Watch-mode output:** newline-delimited JSON. Each cycle emits one `watch-cycle` JSON line. SIGINT/SIGTERM trigger a final `watch-summary` line before exit. Each line is independently a valid JSON object.

**Anti-wick rationale:** thin L2 liquidity can briefly spike for a single block. Requiring `N` consecutive cycles where `currentPrice` crosses `targetPrice` before firing prevents getting wicked at 3am. The tick counter is in-memory, per-process — it resets on restart and on the first cycle the order stops triggering. Only active under `--watch` (one-shot has no history to check).

**Event log:** every meaningful action (`triggered`, `pending_trigger`, `skipped`, `filled`, `expired`, `error`) appends one JSON line to `~/.aibtc/limit-orders/events.jsonl`. File rotates to `events.jsonl.1` at 10 MB. Read back with `list --events`.

### `install-packs`

Install required npm dependencies.

```bash
bun run bitflow-limit-order/bitflow-limit-order.ts install-packs
```

## Output contract

All output is JSON to stdout. Logs go to stderr.

```json
// set — order created
{ "status": "success", "action": "set", "data": { "orderId": 1, "pair": "STX-sBTC", "side": "buy", "targetPrice": 29000, "amount": 0.001, "slippage": 1, "expires": "2026-04-13T12:00:00Z" }, "error": null }

// run — order triggered
{ "status": "success", "action": "execute", "data": { "orderId": 1, "fillPrice": 29800, "txId": "0x8f3a...", "amount": 0.001, "dryRun": false }, "error": null }

// run — no triggers
{ "status": "success", "action": "check", "data": { "checked": 3, "triggered": 0, "closest": { "orderId": 2, "distance": "2.1%" } }, "error": null }

// error
{ "status": "error", "action": "set", "data": null, "error": "Pool STX-FAKE not found" }

// error (swap failure)
{ "status": "error", "action": "execute", "data": null, "error": "Order #1 swap failed: Broadcast failed: ..." }
```

## Safety notes

| Guard | Default | Configurable |
|-------|---------|-------------|
| Max order size | 2000 STX / 0.005 sBTC | No (hardcoded floor) |
| Slippage cap | 1% default | Yes, via `--slippage` (max 5%) |
| Mandatory expiry | 24h | Yes, via `--expires` (max 7d) |
| Max active orders | 10 | No (hardcoded) |
| Balance check | Before every execution | Always enforced |
| One fill per cycle | Sequential processing | Always enforced |
| Silent retry | Never — errors surface immediately | Always enforced |
| Confirmation | `--confirm` required for writes | Always enforced |

**Refusal conditions:**
- Insufficient wallet balance (STX or sBTC, including STX-for-fee on sBTC orders) → order skipped this cycle with `lastSkipReason`, stays active for retry
- Balance API failure → order skipped this cycle (never proceeds with unknown balance)
- Wallet decryption failure → cycle aborts, no further orders processed this cycle
- Slippage exceeds threshold → swap aborted
- Pool inactive or not found → order rejected at `set` time
- Nonce out of sequence → broadcast fails safely
- Order expired → automatically marked `expired` on next `run`

## Price source

HODLMM pool active bin mid-price via Bitflow API:
- Pools: `https://bff.bitflowapis.finance/api/quotes/v1/pools`
- Active bin: `https://bff.bitflowapis.finance/api/quotes/v1/bins/{poolId}/active`

**Never use `api.bitflow.finance`** (dead endpoint).

## Dependencies

- `commander` — CLI argument parsing
- `@bitflowlabs/core-sdk` — Bitflow swap routing and execution
- `@stacks/transactions` — Transaction construction and broadcast
- `@stacks/network` — Stacks mainnet config
- `@stacks/wallet-sdk` — Wallet derivation
- `@stacks/encryption` — Keystore decryption

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @ClankOS
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/277
