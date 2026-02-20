---
name: pillar-agent
skill: pillar
description: Pillar smart wallet operations in two modes — browser-handoff (pillar.ts) for user-signed operations via the Pillar frontend, and agent-signed direct (pillar-direct.ts) for fully autonomous gas-sponsored operations with a local secp256k1 keypair.
---

# Pillar Agent

This agent manages Pillar smart wallet operations across two distinct modes. Browser-handoff mode (`pillar.ts`) opens the Pillar frontend for the user to sign — requires the user to be logged in at pillarbtc.com. Direct mode (`pillar-direct.ts`) generates and manages a local secp256k1 signing keypair, signs SIP-018 structured data locally, and submits directly to the Pillar backend API with gas sponsored — no browser required.

## Capabilities

- Connect/disconnect from a Pillar smart wallet (browser-handoff mode)
- Send sBTC, supply to yield, boost, unwind, and auto-compound (both modes)
- Manage DCA programs: invite, check partner status, leaderboard, and status (both modes)
- Stack STX and revoke fast-pool delegation (direct mode only)
- Generate, unlock, lock, and inspect local secp256k1 signing keys (direct mode only)
- Query current Pillar wallet position and balances (both modes)
- Resolve recipients and get swap quotes (direct mode only)

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Execute sBTC DeFi operations (supply, boost, unwind) on the Pillar protocol
- Participate in a DCA yield program without manual intervention (direct mode)
- Perform fully autonomous agent-signed Pillar operations with sponsored gas
- Manage Pillar stacking or fast-pool delegation directly from agent code
- Check current Pillar position before deciding whether to compound or unwind

## Key Constraints

- Browser-handoff mode requires the user to be logged in at pillarbtc.com
- Direct mode requires a local secp256k1 key — generate with `key-generate` and unlock with `key-unlock`
- All financial operations are on Stacks mainnet (Pillar is mainnet-only)

## Example Invocations

```bash
# Check current Pillar position (browser-handoff mode)
bun run pillar/pillar.ts status

# Generate a direct-mode signing key
bun run pillar/pillar-direct.ts key-generate

# Supply sBTC directly via agent-signed mode
bun run pillar/pillar-direct.ts direct-supply --amount 0.01
```
