---
name: nonce-manager
description: "Backup sender nonce tracker for Stacks transactions. Use canonical payment-status polling first; use this for local nonce coordination and recovery."
metadata:
  author: "rising-leviathan"
  author-agent: "Loom"
  user-invocable: "false"
  arguments: "acquire | release | sync | status"
  entry: "nonce-manager/nonce-manager.ts"
  mcp-tools: "nonce_health, nonce_heal, nonce_fill_gap"
  requires: ""
  tags: "infrastructure, l2"
---

# Nonce Manager

Backup sender nonce tracker for Stacks transactions. Use canonical payment-status polling by `paymentId` as the primary x402 state machine; use this tool for local nonce coordination and recovery when a fresh sender nonce is actually needed.

## Problem

Each skill independently fetches nonce from Hiro API. When tasks fire back-to-back (before mempool clears), they grab the same nonce and collide with `SENDER_NONCE_STALE` or `SENDER_NONCE_DUPLICATE` errors.

## Solution

Single file-locked nonce state at `~/.aibtc/nonce-state.json`. Skills call `acquire` to get the next nonce (atomically incremented), and `release` after the transaction confirms or fails. If state is stale (>5 min), auto-resyncs from Hiro.

## Subcommands

### acquire

Get the next nonce for a Stacks address. Atomically increments the stored value. Auto-syncs from Hiro if state is missing or stale (>5 min).

```
bun run nonce-manager/nonce-manager.ts acquire --address SP...
```

Output:
```json
{ "nonce": 42, "address": "SP...", "source": "local" }
```

### release

Mark a nonce as confirmed or failed after transaction outcome is known.

```
bun run nonce-manager/nonce-manager.ts release --address SP... --nonce 42
bun run nonce-manager/nonce-manager.ts release --address SP... --nonce 42 --failed
bun run nonce-manager/nonce-manager.ts release --address SP... --nonce 42 --failed --rejected
```

**Failure kinds** (critical distinction):
- `--rejected` — tx never reached mempool (signing error, relay 409 nonce rejection). Nonce NOT consumed, safe to roll back and reuse.
- `--broadcast` (default when `--failed`) — tx reached mempool. Nonce IS consumed even if the tx fails on-chain. Do NOT roll back.

Only `--failed --rejected` triggers a rollback. Default `--failed` assumes broadcast (safer).

Output:
```json
{ "address": "SP...", "nonce": 42, "action": "confirmed" }
```

### sync

Force re-sync nonce state from Hiro API. Use after manual intervention or mempool clearance.

```
bun run nonce-manager/nonce-manager.ts sync --address SP...
```

Output:
```json
{ "nonce": 42, "address": "SP...", "mempoolPending": 3, "lastExecuted": 41, "detectedMissing": [] }
```

### status

Show current nonce state for one or all tracked addresses.

```
bun run nonce-manager/nonce-manager.ts status
bun run nonce-manager/nonce-manager.ts status --address SP...
```

## Library Import

Skills running in the same process can import directly:

```typescript
import { acquireNonce, releaseNonce, syncNonce } from "../nonce-manager/nonce-store.js";

const { nonce } = await acquireNonce("SP...");
// ... send transaction ...
await releaseNonce("SP...", nonce, true); // true = success
```

## Nonce Strategy

1. **Acquire before send** — always get nonce from manager, never from Hiro directly
2. **Release after confirm/fail** — keeps state accurate for next caller
3. **Auto-sync on stale** — if last sync >5 min ago, re-fetch from Hiro before returning
4. **File lock for atomicity** — mkdir-based lock prevents concurrent reads returning same nonce
5. **Distinguish broadcast vs rejected** — only rejected nonces can be rolled back

## Integration with x402 Error Codes

Use canonical payment status plus `terminalReason` first. When local nonce bookkeeping is still needed, map outcomes to release actions like this:

| Relay Response | Release Action |
|---------------|----------------|
| `confirmed` | `release --address ... --nonce N` (success) |
| `queued` / `broadcasting` / `mempool` | Keep polling the same `paymentId`; do not rebuild; keep nonce tracked as in-flight |
| `failed` + `sender_nonce_duplicate` | `release --address ... --nonce N --failed --rejected` + re-sync and rebuild |
| `409 SENDER_NONCE_STALE` | `release --address ... --nonce N --failed --rejected` + re-sync |
| `409 SENDER_NONCE_GAP` | `release --address ... --nonce N --failed --rejected` + re-sync |
| `failed` + relay/sponsor/internal reason | Do not treat as sender rebuild guidance; bounded retry or stop by tool policy |
| `replaced` / `not_found` | Stop polling the old `paymentId`; start a new payment flow only if the higher-level action still needs to pay |
