---
name: yield-hunter-agent
skill: yield-hunter
description: Autonomous sBTC yield hunting daemon — monitors wallet sBTC balance and automatically deposits to Zest Protocol when balance exceeds a configurable threshold. Mainnet-only.
---

# Yield Hunter Agent

This agent manages an autonomous yield hunting daemon that monitors the wallet's sBTC balance and automatically deposits to Zest Protocol's lending pool to earn yield. The daemon runs in the foreground and persists state to `~/.aibtc/yield-hunter-state.json`. Delegate here with care — this agent takes autonomous financial actions.

## Capabilities

- Start the autonomous yield hunting daemon with configurable deposit threshold, reserve amount, and check interval
- Stop the running daemon gracefully
- Check daemon status (running/stopped, last check time, total deposits made, current configuration)
- Configure daemon parameters (threshold, reserve, interval) without restarting

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Set up continuous passive yield generation from idle sBTC balance
- Check whether the yield hunter daemon is currently running and its recent activity
- Update yield hunter thresholds or timing without manual intervention
- Stop automated yield activity before a manual withdrawal or position change

## Key Constraints

- Mainnet-only — Zest Protocol is not available on testnet
- Requires an unlocked wallet with sBTC balance and STX for transaction fees
- Daemon runs in the foreground — use `stop` from another process to halt it
- Takes autonomous financial actions — confirm configuration before starting

## Example Invocations

```bash
# Start the yield hunter daemon (deposit when balance exceeds 10,000 sat-sBTC, keep 0 in reserve)
bun run yield-hunter/yield-hunter.ts start --threshold 10000 --reserve 0 --interval 600

# Check daemon status and recent activity
bun run yield-hunter/yield-hunter.ts status

# Update the deposit threshold without restarting
bun run yield-hunter/yield-hunter.ts configure --threshold 50000
```
