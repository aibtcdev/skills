---
name: stackspot-agent
skill: stackspot
description: Stackspot stacking lottery pots on Stacks mainnet — join STX pots that stack via PoX, claim sBTC rewards if selected as VRF winner, and manage pot lifecycle.
---

# Stackspot Agent

This agent handles stacking lottery pot operations on stackspot.app. Participants pool STX into pots that are stacked via Proof of Transfer (PoX) for one cycle. A VRF mechanism selects one winner who receives the stacking yield in sBTC; all participants receive their original STX back. All operations are mainnet-only. Write operations require an unlocked wallet.

## Capabilities

- List all known pot contracts with their current STX value and lock status
- Query full on-chain state for a pot: value, participant count, lock status, and configuration
- Join a pot by contributing STX (minimum amount enforced per pot)
- Start stacking for a full pot via the platform contract
- Claim sBTC rewards from a completed pot (for VRF winners)
- Cancel a pot before stacking begins to recover contributed STX

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Check available stackspot pots and their current fill status
- Join a stacking lottery pot with a specified STX amount
- Start a pot that has reached its maximum participant count
- Claim sBTC stacking rewards after a pot cycle completes
- Cancel a pot or check whether STX is recoverable before a cycle starts

## Key Constraints

- Mainnet-only — all operations will error on testnet
- Write operations (join-pot, start-pot, claim-rewards, cancel-pot) require an unlocked wallet
- STX contributed to a pot is locked for one full PoX cycle (~2 weeks); verify PoX cycle phase before joining
- start-pot must be called during the prepare phase of a PoX cycle — use `bun run stacking/stacking.ts get-pox-info` to check timing
- cancel-pot only works before stacking starts (pot must not be locked)
- Only the VRF-selected winner receives sBTC rewards; all participants recover their STX regardless

## Example Invocations

```bash
# List all known pots with current value and lock status
bun run stackspot/stackspot.ts list-pots

# Get full on-chain state for a pot (accepts bare name or full identifier)
bun run stackspot/stackspot.ts get-pot-state --contract-name SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG

# Join a pot with 21 STX (21,000,000 micro-STX)
bun run stackspot/stackspot.ts join-pot --contract-name SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG --amount 21000000

# Start a full pot (must be in PoX prepare phase)
bun run stackspot/stackspot.ts start-pot --contract-name SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG

# Claim sBTC rewards after pot cycle completes
bun run stackspot/stackspot.ts claim-rewards --contract-name SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG
```
