---
name: escrow-htlc
agent-role: escrow coordinator
---

# AGENT.md — escrow-htlc Autonomous Operation

## When to Use This Skill

Use `escrow-htlc` when an agent needs to:
- Lock sBTC for a counterparty pending delivery of off-chain work
- Accept incoming sBTC locked in escrow (claim with preimage)
- Recover sBTC after a deal falls through (refund after expiry)
- Verify escrow state before proceeding with a trade

## Decision Logic

### Locking escrow

Before calling `lock`:
1. Confirm sBTC balance is sufficient: `sbtc get-balance`
2. Generate lock params: `escrow-htlc generate-lock-params` — store preimage securely
3. Agree timelock with counterparty: minimum 144 blocks (~24h) for most deals
4. Never reveal the preimage until counterparty has fulfilled their obligation

### Claiming escrow

Before calling `claim`:
1. Verify escrow state: `escrow-htlc get-escrow --escrow-id <id>`
2. Confirm `claimed: false` and `refunded: false`
3. Confirm `block-height <= timelock` (don't attempt a claim that will expire mid-block)
4. Confirm sha256(preimage) matches `hashlock` locally before broadcasting

### Refunding escrow

Before calling `refund`:
1. Verify escrow state: `escrow-htlc get-escrow --escrow-id <id>`
2. Confirm `block-height > timelock`
3. Only the original sender can refund — verify wallet is correct

## Safety Rules

- **Never share the preimage before counterparty obligation is fulfilled** — doing so releases funds immediately
- **Always verify escrow state before any write operation** — check `get-escrow` first
- **Use post-conditions on lock** — the CLI enforces exact sBTC amount via post-condition
- **Do not attempt claim or refund if both `claimed` and `refunded` are false but timelock is unclear** — wait for the next block and re-check
- **ESCROW_CONTRACT_ADDRESS must be set** — do not operate against undeployed contract

## Error Handling

| Error | Action |
|-------|--------|
| ERR-ALREADY-CLAIMED (u102) | Stop. Funds already paid out. Verify on explorer. |
| ERR-ALREADY-REFUNDED (u103) | Stop. Funds returned to sender. |
| ERR-WRONG-PREIMAGE (u104) | Verify preimage hex is correct 32 bytes. |
| ERR-TIMELOCK-ACTIVE (u105) | Refund too early. Wait until block > timelock. |
| ERR-TIMELOCK-EXPIRED (u106) | Claim window closed. Only refund is available. |
| ERR-NOT-RECIPIENT (u108) | Wrong wallet. Switch to recipient wallet. |
| ERR-NOT-SENDER (u109) | Wrong wallet. Switch to sender wallet. |
