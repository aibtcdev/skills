---
name: dca
description: "Dollar Cost Averaging (DCA) for Stacks DeFi — automate recurring buys or sells of any Bitflow token pair via direct swaps. The agent executes each order on schedule with mandatory confirmation, slippage guardrails, balance checks, full tx logging, and Telegram-friendly status summaries. HODLMM pairs supported automatically via SDK route resolver with optional explicit HODLMM-only mode."
metadata:
  author: "k9dreamermacmini-coder"
  author-agent: "Graphite Elan"
  user-invocable: "false"
  arguments: "doctor | install-packs | setup | plan | run | status | cancel | list"
  entry: "dca/dca.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# DCA — Dollar Cost Averaging for Stacks DeFi

Automate recurring token purchases (or sales) on Stacks mainnet via **direct Bitflow swaps**.
The agent executes each order on schedule — no third-party contracts required.

## How It Works

1. `setup` creates a local plan file with the full schedule
2. `run` is called by the agent on each schedule tick (via cron or heartbeat)
3. Each `run` checks if an order is due, fetches a live quote, and returns `blocked` until `--confirm`
4. On confirm: executes the swap on-chain, logs the tx hash, advances the schedule
5. `status` shows progress: avg entry price, total spent/received, remaining orders

## Quick Start

```bash
# 1. Install dependencies
bun run dca/dca.ts install-packs --pack all

# 2. Health check
bun run dca/dca.ts doctor

# 3. Create a plan: DCA 50 STX into sBTC over 5 daily orders
bun run dca/dca.ts setup \
  --token-in STX --token-out sBTC \
  --total 50 --orders 5 --frequency daily --slippage 3

# 4. Preview the schedule
bun run dca/dca.ts plan --plan <planId>

# 5. Execute next order (--confirm required)
# Preferred: use env var (doesn't appear in ps aux or shell history)
export AIBTC_WALLET_PASSWORD="your-password"
bun run dca/dca.ts run --plan <planId>
# Review the quote, then:
bun run dca/dca.ts run --plan <planId> --confirm

# 6. Monitor progress
bun run dca/dca.ts status --plan <planId>

# 7. Cancel remaining orders
bun run dca/dca.ts cancel --plan <planId>
```

## Commands

### `doctor`
System health check — verifies Bitflow API, wallet file, and Stacks mainnet connectivity.

### `install-packs --pack all`
One-time setup: installs required packages. Run once during initial setup — not during normal execution.

**Installs:** `@bitflowlabs/core-sdk`, `@stacks/transactions`, `@stacks/network`, `@stacks/wallet-sdk`, `@stacks/encryption`, `commander`, `tslib`

> **Note:** `install-packs` runs `bun add` and modifies `package.json`. This is a one-time setup step — do not call it during regular agent operation or in shared environments where multiple processes may be active.

### Dependencies

If not using `install-packs`, add these to your project manually:

```bash
bun add @bitflowlabs/core-sdk @stacks/transactions @stacks/network @stacks/wallet-sdk @stacks/encryption commander tslib
```

### `setup`

| Flag | Required | Description |
|------|----------|-------------|
| `--token-in` | ✅ | Input token symbol (e.g. `STX`) |
| `--token-out` | ✅ | Output token symbol (e.g. `sBTC`, `WELSH`, `ALEX`) |
| `--total` | ✅ | Total amount in human units (e.g. `50` = 50 STX) |
| `--orders` | ✅ | Number of orders (2..100) |
| `--frequency` | ✅ | `hourly` · `daily` · `weekly` · `biweekly` |
| `--slippage` | ❌ | Slippage % (default `3`, hard max `10`) |
| `--start-delay-hours` | ❌ | Hours before first order (default `0`) |

Validates the token pair against live Bitflow routes before saving.

### `plan --plan <id>`
Preview the full DCA schedule with per-order timing and current quote estimates.

### `run --plan <id> [--confirm] [--wallet-password <pw>]`
Execute the next pending order. Cron-friendly — returns `blocked` if called before the next order is due.

- **Without `--confirm`**: Returns live quote preview. Safe to inspect.
- **With `--confirm`**: Executes the swap on-chain, logs tx hash, advances schedule.

> **Security:** Prefer `AIBTC_WALLET_PASSWORD` env var over `--wallet-password` flag. CLI flags appear in `ps aux` output and shell history — a real risk in long-lived agent processes. Use `--wallet-password` only as a fallback.
>
> ```bash
> # Preferred (env var — not visible in ps aux)
> export AIBTC_WALLET_PASSWORD="your-password"
> bun run dca/dca.ts run --plan <planId> --confirm
>
> # Fallback only (flag — visible in process list)
> bun run dca/dca.ts run --plan <planId> --confirm --wallet-password "your-password"
> ```

### `status --plan <id>` / `status --all`
Progress: orders complete, total spent, total received, avg entry price, next order ETA.

### `cancel --plan <id>`
Cancel a plan. Stops all future `run` calls for this plan.

### `list`
List all local DCA plan files with status.

## Token Amounts

Pass `--total` in **human-readable units** (not microunits):

| Token | Example | Meaning |
|-------|---------|---------|
| STX | `--total 50` | 50 STX |
| sBTC | `--total 0.001` | 0.001 sBTC |
| ALEX | `--total 100` | 100 ALEX |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AIBTC_WALLET_PASSWORD` | Wallet password (alternative to `--wallet-password`) |
| `STACKS_PRIVATE_KEY` | Direct private key for testing (bypasses wallet file) |
| `AIBTC_DRY_RUN=1` | Simulate all writes — no transactions broadcast |

## Output Format

All commands emit strict JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": {
    "telegram": "📊 Emoji-rich Telegram-friendly summary",
    "...": "command-specific fields"
  },
  "error": null
}
```

## Safety Guardrails (enforced in code)

| Guardrail | Limit | Enforcement |
|-----------|-------|-------------|
| Max slippage | 10% | Hard error `SLIPPAGE_LIMIT` |
| Max orders | 100 | Hard error `ORDERS_LIMIT` |
| Min order size | > 0 | Hard error `ORDER_TOO_SMALL` |
| Spend confirmation | Always | `blocked` without `--confirm` |
| Frequency enforcement | Per-plan | `blocked` if called too early |
| Balance check | STX pre-execution | Error `INSUFFICIENT_BALANCE` |
| Cancelled/completed plans | Blocked | Error `PLAN_CANCELLED` / `PLAN_COMPLETE` |
| Private key exposure | Never | Zero-exposure in all output |
| Dry run mode | `AIBTC_DRY_RUN=1` | Simulates without broadcasting |

## Scheduling

The `run` command is designed to be called by cron or heartbeat:

```bash
# Cron: execute DCA daily at 9am
0 9 * * * AIBTC_WALLET_PASSWORD=xxx bun run /path/to/dca/dca.ts run --plan <id> --confirm
```

Frequency is enforced by the skill — early calls return `blocked` with time remaining. Safe to call frequently.

## State Files

Plans stored at `~/.aibtc/dca/<plan-id>.json`. Contains full plan config, every tx hash, per-order execution log, and running avg cost.

## Wallet Support

Three wallet sources (checked in order):
1. `STACKS_PRIVATE_KEY` env var (direct, for testing)
2. AIBTC MCP wallet (`~/.aibtc/wallets.json` + keystore — AES-256-GCM + scrypt)
3. Legacy `~/.aibtc/wallet.json` (older format)

## Known Constraints

- Mainnet only
- Requires funded wallet (STX for gas + swap input token)
- Bitflow API must be reachable (500 req/min rate limit)
- Not all token pairs have routes — `setup` validates before saving

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @k9dreamermacmini-coder
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/31
