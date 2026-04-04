---
name: dca-agent
skill: dca
description: "Executes recurring token swaps on a fixed schedule via Bitflow — agent is the scheduler, each run call executes one order when due."
---

# Agent Behavior — DCA (Dollar Cost Averaging)

The agent IS the scheduler. Each `run` call executes one order via direct Bitflow swap when due. No third-party contracts or Keeper network required.

## Decision order

1. Run `doctor` first. If it fails, surface the blocker. Do not proceed.
2. For new plans: `setup` with all required parameters.
3. `plan --plan <id>` → present schedule to user before any spend.
4. `run --plan <id>` (WITHOUT `--confirm`) → preview the live quote.
5. Present the quote. Wait for explicit user approval.
6. Only after approval: `run --plan <id> --confirm` (use `AIBTC_WALLET_PASSWORD` env var — not `--wallet-password` flag).
7. After each order: `status --plan <id>` and report progress.

## Guardrails

These are **thrown as errors** in `dca.ts` — not suggestions:

### 1. Max Slippage: 10%
```typescript
if (slippageNum > MAX_SLIPPAGE_PCT)
  fail("SLIPPAGE_LIMIT", ...);
```
Any `--slippage` above 10% aborts before any action.

### 2. Max Orders: 100
```typescript
if (ordersNum > MAX_ORDERS)
  fail("ORDERS_LIMIT", ...);
```

### 3. Confirmation Gate
```typescript
if (!confirm) return blocked("Add --confirm to authorize this swap", ...);
```
**Never** add `--confirm` without explicit user approval.

### 4. Cancelled/Completed Plan Block
```typescript
if (plan.status === "cancelled") fail("PLAN_CANCELLED", ...);
if (plan.status === "completed") fail("PLAN_COMPLETE", ...);
```

### 5. Frequency Enforcement
```typescript
if (now < plan.nextOrderAt) return blocked(`Next order due ${timeLeft}`, ...);
```
Prevents double-execution if `run` is called early.

### 6. Private Key Zero-Exposure
Derived `stxPrivateKey` is used only for transaction signing. Never logged, never serialized, never in JSON output or plan files.

### 7. Balance Check
Fetches STX balance before execution. Returns `INSUFFICIENT_BALANCE` error with balance details if short.

### 8. Dry Run Mode
```typescript
if (process.env.AIBTC_DRY_RUN === "1") // simulated TX, no broadcast
```

### 9. TX Hash Logging
Every broadcast appends to `plan.orderLog[]` before returning — full audit trail.

## Plan Lifecycle

```
pending  →  active  →  completed
    ↓           ↓
  (never      cancelled
   run)
```

- `pending`: Plan created, `run` not yet called
- `active`: At least one order executed successfully
- `completed`: All orders filled (`ordersCompleted === ordersTotal`)
- `cancelled`: User called `cancel`

## On error

| Error | Agent Behavior |
|-------|---------------|
| SDK not installed | Direct to `install-packs --pack all` |
| Wallet missing | Direct to `npx @aibtc/mcp-server@latest --install` |
| Invalid token pair | List available tokens, suggest similar |
| Insufficient balance | Show balance vs needed, stop |
| Network error | Surface error with retry suggestion |
| Slippage > 10% | Hard stop — never override |
| Orders > 100 | Hard stop — never override |
| Cancelled plan | Hard stop — direct to `list` |
| TX broadcast failure | Log error to plan file, surface full message |

## Wallet Security

1. Use `AIBTC_WALLET_PASSWORD` env var (preferred — not visible in `ps aux` or shell history). `--wallet-password` flag is a fallback only.
2. Never hardcode, guess, or cache passwords
3. Derived `stxPrivateKey` lives in memory only during the signing call
4. Zero private key content in: JSON output, plan files, error messages, stderr

## Scheduling

The agent calls `run` on each schedule tick. Frequency is enforced by the skill — early calls return `blocked` with time remaining. Safe to call frequently.

```bash
# Heartbeat-compatible: returns blocked (not error) when order not yet due
# Preferred: use env var (not visible in ps aux)
export AIBTC_WALLET_PASSWORD="your-password"
bun run dca/dca.ts run --plan <id> --confirm
```

## Telegram Output

Every command populates `data.telegram` for human-readable display:
- Under 800 chars for status messages
- Emojis: 📈 buy, ✅ done, ⏳ pending, ❌ error, 💰 amounts, 🔄 recurring, 📊 stats
- Progress bar: `▓▓▓░░░░░░░ 30%`
- Numbers: comma-formatted (`1,000 STX`)
- Always shows avg entry price when available

## Example Flow

```
User: "DCA 100 STX into sBTC, 10 orders, daily"

1. doctor()                          → all checks pass
2. setup(STX, sBTC, 100, 10, daily)  → planId: dca-abc123
3. plan(dca-abc123)                  → show 10-order schedule
4. User: "looks good"
5. run(dca-abc123)                   → blocked: 10 STX → ~0.0000343 sBTC
6. User: "confirmed"
7. run(dca-abc123, --confirm)        → ✅ tx hash logged, next in 24h
8. status(dca-abc123)                → 1/10 complete, avg entry shown
```

## Output contract

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action",
  "data": {
    "telegram": "emoji-rich summary",
    "...": "command-specific fields"
  },
  "error": null | { "code": "", "message": "", "next": "" }
}
```

## On success

- Confirm the on-chain result (tx hash)
- Update plan state file with execution log entry
- Report completion with summary: order number, amount swapped, avg entry price, remaining orders
