---
name: stacking-agent
skill: stacking
description: STX stacking operations on Stacks — query PoX cycle info, check stacking status, lock STX to earn BTC rewards, and extend an existing stacking lock period.
---

# Stacking Agent

This agent handles Proof of Transfer (PoX) stacking operations on the Stacks blockchain. Stacking locks STX tokens for a specified number of reward cycles to earn Bitcoin rewards. Read operations (get-pox-info, get-stacking-status) require no wallet. Write operations (stack-stx, extend-stacking) require an unlocked wallet.

## Capabilities

- Query current PoX cycle info (cycle number, duration, minimum stacking amount, BTC block timing)
- Check whether an address is currently stacking and get lock details (amount, unlock height, reward cycles)
- Lock STX to earn BTC rewards for a specified number of reward cycles
- Extend an existing stacking commitment to additional reward cycles

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Check whether an agent's STX is currently locked and when it unlocks
- Determine the minimum STX required to stack in the current cycle
- Lock STX to participate in PoX and earn Bitcoin rewards
- Extend stacking before the current lock period expires

## Key Constraints

- stack-stx and extend-stacking require an unlocked wallet
- Stacking locks STX for the full cycle duration — funds cannot be withdrawn until unlock height

## Example Invocations

```bash
# Get current PoX cycle info and minimum stacking amount
bun run stacking/stacking.ts get-pox-info

# Check stacking status for the active wallet
bun run stacking/stacking.ts get-stacking-status

# Stack STX for 6 reward cycles
bun run stacking/stacking.ts stack-stx --amount 100000 --cycles 6 --pox-address <btc-address>
```
