---
name: child-inscription-agent
skill: child-inscription
description: "Parent-child Ordinals inscriptions — estimate fees, broadcast commit tx, and reveal child inscription establishing on-chain provenance per the Ordinals provenance spec."
---

# Child Inscription — Agent Guide

## What This Skill Does

Creates a **child inscription** on Bitcoin using the Ordinals provenance spec. A child inscription is linked to a parent by spending the parent UTXO inside the reveal transaction, establishing immutable on-chain provenance.

Use this skill when an operator or user wants to:
- Publish content with verifiable lineage to an existing inscription
- Build inscription collections where the parent acts as the collection root
- Attach metadata, credits, or derivative works to a parent inscription

---

## Prerequisites

1. **Unlocked wallet** — Run `wallet unlock` first. The wallet must hold BTC at its SegWit (P2WPKH) address for commit funding.
2. **Taproot ownership** — Your wallet's Taproot address must own the parent inscription. Confirm with `btc get-inscriptions`.
3. **Sufficient BTC** — Run `estimate` to calculate total cost. Check balance with `btc balance`.

---

## Decision Logic

```
1. Estimate first
   → bun run child-inscription/child-inscription.ts estimate \
       --parent-id <id> --content-type <mime> --content <text>
   → Verify totalCost < available balance
   → If balance insufficient: stop, inform user

2. Commit (inscribe step)
   → bun run child-inscription/child-inscription.ts inscribe \
       --parent-id <id> --content-type <mime> --content <text> [--fee-rate fast|medium|slow|N]
   → Save commitTxid and revealAmount from output
   → State file written: .child-inscription-state.json

3. Wait for commit confirmation
   → Poll: bun run btc/btc.ts ... OR check mempool.space
   → Do NOT proceed to reveal until commitTxid has ≥1 confirmation
   → Typical wait: 10–60 minutes

4. Reveal
   → bun run child-inscription/child-inscription.ts reveal \
       --commit-txid <commitTxid> --vout 0
   → Capture inscriptionId from output
   → Log success
```

---

## Safety Checks

| Check | When | Action if Failed |
|-------|------|-----------------|
| Balance >= totalCost | Before `inscribe` | Stop, report to user |
| Parent owned by your Taproot address | Before `inscribe` | Stop, clarify ownership |
| Commit tx confirmed (≥1 block) | Before `reveal` | Wait, re-check |
| Parent still at your address | Before `reveal` | Abort — do not spend parent |
| State file present | Before `reveal` | Re-run `inscribe` or supply params manually |

---

## Error Handling

| Error | Likely Cause | Resolution |
|-------|-------------|------------|
| `Wallet not unlocked` | Wallet session expired | Run `wallet unlock` |
| `No UTXOs available` | No BTC at SegWit address | Fund the wallet, then retry |
| `Parent inscription owned by <other>` | Wrong wallet or wrong parent ID | Confirm ownership, switch wallet |
| `Parent inscription no longer owned` | Parent transferred between commit and reveal | Stop — parent is gone, commit funds are lost |
| `commit tx not found` | Too early, mempool drop, or wrong txid | Wait longer or check mempool.space |
| Network/broadcast errors | Mempool full or connectivity | Retry with higher fee-rate |

---

## State File

The `inscribe` subcommand writes `.child-inscription-state.json` in the current working directory:

```json
{
  "parentInscriptionId": "abc123...i0",
  "contentType": "text/plain",
  "contentBase64": "SGVsbG8gd29ybGQ=",
  "commitTxid": "deadbeef...",
  "revealAmount": 3394,
  "feeRate": 12,
  "timestamp": "2026-03-16T00:00:00.000Z"
}
```

The `reveal` subcommand reads this file to reconstruct the inscription deterministically. Keep it until the reveal confirms.

---

## Example Flow

```bash
# 0. Unlock wallet
bun run wallet/wallet.ts unlock

# 1. Estimate
bun run child-inscription/child-inscription.ts estimate \
  --parent-id "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1i0" \
  --content-type "text/plain" \
  --content "Hello from child inscription"

# 2. Check balance covers totalCost from estimate output
bun run btc/btc.ts balance

# 3. Inscribe (commit)
bun run child-inscription/child-inscription.ts inscribe \
  --parent-id "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1i0" \
  --content-type "text/plain" \
  --content "Hello from child inscription" \
  --fee-rate medium

# 4. Wait for commit confirmation (check mempool.space or wait ~30 min)

# 5. Reveal
bun run child-inscription/child-inscription.ts reveal \
  --commit-txid "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" \
  --vout 0

# 6. Record inscriptionId from output
```

---

## MCP Tools Used

| MCP Tool | CLI Step |
|----------|----------|
| `estimate_child_inscription_fee` | `estimate` |
| `inscribe_child` | `inscribe` |
| `inscribe_child_reveal` | `reveal` |
