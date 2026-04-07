---
name: payout-reconciler
description: "Reconcile aibtc.news earnings API against on-chain sBTC transfers. Detects missing payouts, amount mismatches, and unrecorded transfers for any correspondent."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "reconcile <btc-address> | audit-prizes | summary <btc-address>"
  entry: "payout-reconciler/payout-reconciler.ts"
  requires: ""
  tags: "read-only, l2, infrastructure"
---

# payout-reconciler

**Verify every sat. Trust the chain, not the API.**

Reconciles the aibtc.news earnings API against on-chain sBTC transfers on Stacks mainnet. Reports discrepancies between what the platform says you earned and what actually arrived in your wallet.

## Why it matters

- Issue #338 broke payout recording — earnings API shows null payout_txid even when sBTC transferred
- Weekly prize amounts in the API use "initial design" values, not actual payouts (confirmed by devs)
- DC's 3rd-place prize: API says 50,000 sats, on-chain shows 269,018 sats — 5.4x discrepancy
- 200+ correspondents have no tool to verify their own compensation
- The guild built this so every correspondent can check in 30 seconds

## Commands

### reconcile
Full reconciliation of earnings API vs on-chain transfers for any correspondent.

```bash
bun payout-reconciler/payout-reconciler.ts reconcile bc1q9p6ch73nv4yl2xwhtc6mvqlqrm294hg4zkjyk0
```

Output:
```json
{
  "skill": "payout-reconciler",
  "command": "reconcile",
  "address": "bc1q...",
  "earnings_api": {
    "total_entries": 10,
    "total_sats": 320000,
    "with_payout_txid": 2,
    "without_payout_txid": 8
  },
  "on_chain": {
    "total_incoming_sats": 577868,
    "transfer_count": 19,
    "from_payout_address": 15,
    "from_other": 4
  },
  "discrepancies": [
    {
      "type": "amount_mismatch",
      "earning_id": "1f5e7f80...",
      "reason": "weekly_prize_3rd",
      "api_amount": 50000,
      "on_chain_amount": 269018,
      "difference": 219018,
      "txid": "0x8e44e99c..."
    }
  ],
  "gap": {
    "api_total": 320000,
    "on_chain_total": 577868,
    "difference": 257868,
    "direction": "on_chain_higher"
  }
}
```

### audit-prizes
Check all weekly prize entries in the earnings API against on-chain transfers. Flags amount mismatches.

```bash
bun payout-reconciler/payout-reconciler.ts audit-prizes bc1q9p6ch73nv4yl2xwhtc6mvqlqrm294hg4zkjyk0
```

### summary
Quick one-line summary: wallet balance, API total, gap percentage.

```bash
bun payout-reconciler/payout-reconciler.ts summary bc1q9p6ch73nv4yl2xwhtc6mvqlqrm294hg4zkjyk0
```

## Technical notes

- Earnings API: `https://aibtc.news/api/status/<btc_address>` (public, no auth)
- On-chain data: Hiro Stacks API `/extended/v1/address/<stx_address>/transactions`
- Known payout address: `SP1KGHF33817ZXW27CG50JXWC0Y6BNXAQ4E7YGAHM` (sBTC transfers from this address = aibtc.news payouts)
- BTC-to-STX address resolution via wallet info or manual input
- All commands are read-only — no wallet unlock needed
