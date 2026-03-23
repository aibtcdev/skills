---
name: escrow-htlc
description: Trust-minimized HTLC escrow for agent-to-agent sBTC payments on Stacks. Lock sBTC with a hashlock and timelock — recipient claims with the preimage, sender reclaims after expiry. No AMM, no DEX, single asset. Write operations require an unlocked wallet.
user-invocable: true
arguments: lock | claim | refund | get-escrow | generate-lock-params
entry: escrow-htlc/escrow-htlc.ts
requires: [wallet, stx]
tags: [escrow, htlc, sbtc, bitcoin, defi, write]
---

# escrow-htlc

Trust-minimized Hash Time-Locked Contract (HTLC) for agent-to-agent sBTC escrow on Stacks mainnet.

**Design invariants:**
- Zero AMM/DEX dependency — pure HTLC only
- Single settlement asset (sBTC) — no mid-flow conversion
- Full refund on expiry — no fees deducted
- Double-claim and double-refund both fail cleanly
- Contract prints on every state transition (lock / claim / refund)

---

## Prerequisites

- Wallet unlocked on mainnet for write operations (`lock`, `claim`, `refund`)
- Sufficient sBTC balance in wallet for `lock`

---

## Usage

```bash
NETWORK=mainnet bun run escrow-htlc/escrow-htlc.ts <subcommand> [options]
```

---

## Subcommands

### generate-lock-params

Generate a random preimage + sha256 hashlock pair. Share the hashlock with the recipient; keep the preimage secret until you want to release funds.

```bash
bun run escrow-htlc/escrow-htlc.ts generate-lock-params
```

Output:
```json
{
  "preimage": "a3f2...",
  "hashlock": "7c8d...",
  "escrowId": "b1e4...",
  "warning": "Store the preimage securely. Losing it means funds can only be recovered via refund after timelock."
}
```

---

### lock

Lock sBTC into escrow. The recipient can claim by revealing the preimage. The sender can refund after the timelock expires.

```bash
NETWORK=mainnet bun run escrow-htlc/escrow-htlc.ts lock \
  --escrow-id <hex32>       \
  --recipient <STX-address> \
  --amount-sats <n>         \
  --hashlock <hex32>        \
  --timelock-blocks <n>
```

Options:
- `--escrow-id` — 32-byte hex ID (use `generate-lock-params` to generate)
- `--recipient` — Stacks address of the intended recipient
- `--amount-sats` — Amount in satoshis (sBTC: 1 sBTC = 100_000_000 sats)
- `--hashlock` — sha256 of preimage as 64-char hex
- `--timelock-blocks` — Number of blocks until sender can reclaim (relative to current block)

---

### claim

Claim sBTC from escrow by revealing the preimage. Only the designated recipient can call this, and only before the timelock expires.

```bash
NETWORK=mainnet bun run escrow-htlc/escrow-htlc.ts claim \
  --escrow-id <hex32> \
  --preimage  <hex32>
```

---

### refund

Reclaim sBTC from escrow after the timelock has expired. Only the original sender can call this. Full amount returned — no fees.

```bash
NETWORK=mainnet bun run escrow-htlc/escrow-htlc.ts refund \
  --escrow-id <hex32>
```

---

### get-escrow

Read-only lookup of escrow state. No wallet required.

```bash
NETWORK=mainnet bun run escrow-htlc/escrow-htlc.ts get-escrow \
  --escrow-id <hex32>
```

---

## Error Codes

| Code | Meaning |
|------|---------|
| u100 | Escrow ID already exists |
| u101 | Escrow not found |
| u102 | Already claimed |
| u103 | Already refunded |
| u104 | Wrong preimage |
| u105 | Timelock still active (refund too early) |
| u106 | Timelock expired (claim too late) |
| u107 | Zero amount |
| u108 | Caller is not the recipient |
| u109 | Caller is not the sender |
| u110 | Timelock must be in the future |

---

## Example: Full Flow

```bash
# 1. Generate lock params (sender side)
bun run escrow-htlc/escrow-htlc.ts generate-lock-params
# → save preimage privately, share hashlock + escrow-id with recipient

# 2. Lock 10,000 sats for 144 blocks (~24h)
NETWORK=mainnet bun run escrow-htlc/escrow-htlc.ts lock \
  --escrow-id <escrow-id>   \
  --recipient SP2VCQJ...     \
  --amount-sats 10000        \
  --hashlock <hashlock>      \
  --timelock-blocks 144

# 3. Recipient checks status
NETWORK=mainnet bun run escrow-htlc/escrow-htlc.ts get-escrow --escrow-id <escrow-id>

# 4. Sender reveals preimage (off-chain), recipient claims
NETWORK=mainnet bun run escrow-htlc/escrow-htlc.ts claim \
  --escrow-id <escrow-id>  \
  --preimage  <preimage>

# OR — if recipient doesn't claim in time, sender refunds
NETWORK=mainnet bun run escrow-htlc/escrow-htlc.ts refund --escrow-id <escrow-id>
```

---

## Contract

`escrow-htlc/contracts/escrow-htlc.clar`

Deploy to mainnet before use:

```bash
NETWORK=mainnet bun run stx/stx.ts deploy-contract \
  --name escrow-htlc \
  --file escrow-htlc/contracts/escrow-htlc.clar
```
