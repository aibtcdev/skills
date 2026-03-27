# Nonce Manager — Agent Briefing

## Purpose

You are managing Stacks transaction nonces to prevent mempool collisions. Every Stacks transaction requires a sequential nonce. When multiple skills send transactions concurrently, they can grab the same nonce from the Hiro API and collide.

## Prerequisites

- No wallet unlock needed — nonce management is address-based, not key-based
- `~/.aibtc/` directory must exist (created automatically on first use)

## Core Rules

1. **Always acquire before sending any Stacks transaction.** Never fetch nonce directly from Hiro API.
2. **Always release after the transaction outcome is known.** This keeps state accurate.
3. **Distinguish rejected from broadcast failures.** This is the most critical decision:
   - **Rejected**: tx never reached the mempool (signing error, relay pre-broadcast 409). The nonce was NOT consumed. Release with `--failed --rejected` to roll it back.
   - **Broadcast**: tx reached the mempool but may fail on-chain. The nonce IS consumed. Release with `--failed` (or `--failed --broadcast`). Do NOT roll back.
4. **When in doubt, assume broadcast.** Rolling back a consumed nonce causes a gap. Keeping a rejected nonce causes a skip. Gaps are harder to fix than skips (skips auto-resolve when the nonce is eventually used; gaps require manual fill transactions).

## Error Recovery

### Nonce gaps (missing nonces)

If `sync` reports `detectedMissing`, those nonces were consumed but never confirmed. Options:
- Wait — they may still be in mempool
- Fill gaps with minimal self-transfers (1 uSTX to self) at the missing nonce values

### Stale state

If transactions keep failing with `SENDER_NONCE_STALE`, force a sync:
```
bun run nonce-manager/nonce-manager.ts sync --address SP...
```

### Lock contention

The file lock has a 30-second stale timeout. If you see "Failed to acquire nonce lock", the lock file at `~/.aibtc/nonce-state.lock/` is stuck. It will auto-clear after 30 seconds, or you can manually remove the directory.

## Safety Checks

- Never modify `~/.aibtc/nonce-state.json` directly — always use the CLI or library API
- Never call `sync` between `acquire` and `release` — it resets state and may cause the acquired nonce to be reissued
- Never acquire multiple nonces without releasing them in order — this creates gaps if any intermediate transaction fails

## Integration Pattern

```typescript
import { acquireNonce, releaseNonce } from "../src/lib/services/nonce-tracker.js";

const SENDER = "SP...";

// 1. Acquire
const { nonce } = await acquireNonce(SENDER);

try {
  // 2. Build and send transaction with this nonce
  const result = await sendTransaction({ nonce: BigInt(nonce), ... });

  // 3. Release as success (with txid for pending log)
  await releaseNonce(SENDER, nonce, true, undefined, result.txid);
} catch (error) {
  // 4. Determine if nonce was consumed
  // Pre-broadcast errors (signing, relay 409 SENDER_NONCE_STALE/GAP): rejected
  // Post-broadcast errors (on-chain failure, timeout): broadcast
  const wasRejected = error.message?.includes("SENDER_NONCE_STALE")
    || error.message?.includes("SENDER_NONCE_GAP")
    || error.message?.includes("signing");
  await releaseNonce(SENDER, nonce, false, wasRejected ? "rejected" : "broadcast");
}
```
