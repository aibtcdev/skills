---
name: mempool-watch-agent
skill: mempool-watch
description: Monitor Bitcoin mempool activity — confirm transactions, audit address history, and inspect network backlog. Read-only; no wallet required.
---

# Mempool Watch Agent

Read-only Bitcoin mempool monitoring via mempool.space. No wallet unlock required for any subcommand. Use this skill to confirm transaction status, audit address activity, or assess current network congestion before sending.

## Prerequisites

- No wallet required — all subcommands are read-only
- `NETWORK` env var controls network (defaults to testnet unless `NETWORK=mainnet` is set)
- Valid Bitcoin txid (64 hex chars) required for `tx-status`
- Valid Bitcoin address required for `address-history`

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Confirm whether a sent transaction is mined | `tx-status --txid <txid>` |
| Check how many confirmations a transaction has | `tx-status --txid <txid>` → read `confirmations` |
| Audit recent inbound/outbound activity for an address | `address-history --address <addr>` |
| Assess current mempool backlog before sending BTC | `mempool-stats` → read `recommendedFees` and `pendingTransactions` |
| Decide which fee tier to use for a time-sensitive send | `mempool-stats` → use `recommendedFees.fast.satPerVb` for next-block, `medium` for ~30 min |

## Safety Checks

- All subcommands are read-only — no funds or state are modified
- Verify the `--txid` is 64 hex characters before calling `tx-status` (malformed IDs return a 404 error)
- `address-history --limit` is capped at 25 to avoid large response payloads; for deeper history use the mempool.space explorer URL in the output
- Always confirm `network` in output matches the expected network before acting on results

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| `"Transaction not found"` | txid does not exist on the selected network | Verify txid is correct and matches the network (mainnet vs testnet) |
| `"Failed to fetch..."` with status 404 | Address or txid not found | Check input value and network |
| `"Failed to fetch..."` with status 429 | mempool.space rate limit | Wait a few seconds and retry |
| `"limit must be between 1 and 25"` | `--limit` out of range | Use a value between 1 and 25 |

## Output Handling

- `tx-status`: check `confirmed` (boolean) first; if true, read `confirmations` for depth. 6+ confirmations is considered final for most use cases.
- `address-history`: iterate `transactions[]` — each entry has `confirmed`, `blockHeight`, `fee`, `valueIn`, `valueOut`. Use `explorerUrl` per tx for full UTXO breakdown.
- `mempool-stats`: read `recommendedFees.fast.satPerVb` for urgent sends; `pendingTransactions` above 50,000 indicates significant backlog and higher fees.

## Example Invocations

```bash
# Check if a transaction is confirmed
bun run mempool-watch/mempool-watch.ts tx-status --txid 64892b681a7f1fa14dad055c1628252104839591d27a463a6f7b9cabfddf335a

# Get last 5 transactions for an address
bun run mempool-watch/mempool-watch.ts address-history --address bc1q9p6ch73nv4yl2xwhtc6mvqlqrm294hg4zkjyk0 --limit 5

# Check mempool before sending
bun run mempool-watch/mempool-watch.ts mempool-stats
```
