---
name: relay-diagnostic-agent
skill: relay-diagnostic
description: Sponsor relay health checks and nonce recovery — diagnose stuck sponsored transactions, check nonce gaps, and attempt RBF or gap-fill recovery.
---

# Relay Diagnostic Agent

This agent diagnoses stuck sponsored transactions on the Stacks network. Sponsored transactions route through the AIBTC relay, which maintains a nonce queue for the sponsor address. If that queue develops gaps or desynchronises from the mempool, new transactions stall. This skill surfaces the relay's nonce state and provides automated recovery paths.

## Prerequisites

- **check-health**: No wallet required. The relay endpoint is public.
- **recover**: Wallet must be unlocked (`bun run wallet/wallet.ts unlock`). The wallet supplies the sponsor API key used to authenticate recovery requests.

## Decision Logic

| Symptom | Action |
|---------|--------|
| Sponsored transaction stuck in mempool | Run `check-health` to inspect nonce state and identify stuck txids |
| `hasGaps: true` in nonce status | Run `recover --action fill-gaps` to submit placeholder transactions |
| `stuckTransactions` list is non-empty | Run `recover --action rbf` to rebroadcast with higher fee |
| Both gaps and stuck transactions | Run `recover --action both` (default) |
| `healthy: true`, no issues | No action needed — relay is operating normally |

## Safety Checks

1. **Always run `check-health` first.** Recovery without diagnosis may bump transactions unnecessarily and waste fees.
2. **Do not run `recover` on a healthy relay.** If `healthy: true` and `issues` is empty, skip recovery.
3. **RBF increases fees.** Bumping many transactions simultaneously can increase sponsor costs. Prefer specifying `--txids` for targeted recovery when only a few transactions are stuck.
4. **Gap-fill submits placeholder transactions.** These consume nonces to unblock the queue. Only run if `missingNonces` is non-empty.
5. **If `supported: false` is returned**, the relay does not yet support automated recovery. Share the `stuckTransactions` txids and `missingNonces` from `check-health` with the AIBTC team for manual recovery.

## Error Handling

| Error / Response | Cause | Fix |
|-----------------|-------|-----|
| `"Relay health check failed: HTTP 502"` | Relay is down | Wait and retry; contact AIBTC team if persistent |
| `"No sponsor API key available"` | Wallet not unlocked or `SPONSOR_API_KEY` not set | Run `bun run wallet/wallet.ts unlock`, or set `SPONSOR_API_KEY` env var |
| `supported: false` on recovery | Relay does not implement the recovery endpoint | Share txids and nonces with AIBTC team manually |
| `"Unknown sponsor address for network"` | Running on a network with no known sponsor (e.g. devnet) | Only mainnet and testnet are supported |
| `handleError: exit 1` | Unexpected fetch error | Check network connectivity and relay URL |

## Example Invocations

```bash
# Check relay health (no wallet needed)
bun run relay-diagnostic/relay-diagnostic.ts check-health

# Attempt full recovery (RBF + gap-fill)
bun run relay-diagnostic/relay-diagnostic.ts recover

# RBF specific stuck transactions only
bun run relay-diagnostic/relay-diagnostic.ts recover \
  --action rbf \
  --txids 0xabc123,0xdef456

# Fill specific missing nonces only
bun run relay-diagnostic/relay-diagnostic.ts recover \
  --action fill-gaps \
  --nonces 4201,4202
```

## Output Handling

- `check-health`: use `formatted` field for human-readable summary; use `nonceStatus.missingNonces` and `stuckTransactions` for targeted recovery arguments.
- `recover`: inspect `summary` for overall outcome; if `supported: false` on any sub-result, escalate to AIBTC team with the txids and nonces from a prior `check-health` run.
- After recovery, re-run `check-health` to confirm `hasGaps: false` and `stuckTransactions` is empty.
