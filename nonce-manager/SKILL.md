---
name: nonce-manager
description: "Cross-process Stacks nonce oracle — atomic acquire/release prevents mempool collisions across skills"
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

Centralized nonce oracle for all Stacks blockchain transactions. Prevents mempool collisions when multiple skills send transactions concurrently or in rapid succession.

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

Per [landing-page#522](https://github.com/aibtcdev/landing-page/issues/522), map relay error codes to release actions:

| Relay Response | Release Action |
|---------------|----------------|
| `201` (success or pending) | `release --address ... --nonce N` (success) |
| `409 SENDER_NONCE_DUPLICATE` | `release --address ... --nonce N --failed --broadcast` (nonce in mempool) |
| `409 SENDER_NONCE_STALE` | `release --address ... --nonce N --failed --rejected` + re-sync |
| `409 SENDER_NONCE_GAP` | `release --address ... --nonce N --failed --rejected` + re-sync |
| `409 NONCE_CONFLICT` | `release --address ... --nonce N --failed --broadcast` (retry same signed tx) |
| `502/503` relay error | `release --address ... --nonce N --failed --rejected` (never broadcast) |
