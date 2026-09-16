---
name: stacking-agent
skill: stacking
description: STX stacking operations on Stacks — query PoX cycle info, check stacking status, lock STX to earn BTC rewards, and extend an existing stacking lock period.
---

# Stacking Agent

This agent handles Proof of Transfer (PoX) stacking operations on the Stacks blockchain. Stacking locks STX tokens for a specified number of reward cycles to earn Bitcoin rewards. Read operations (`get-pox-info`, `get-stacking-status`) work without a wallet. Write operations (`stack-stx`, `extend-stacking`) require an unlocked wallet and a valid Bitcoin reward address.

## Prerequisites

- **Check `activePoxContract` from `get-pox-info` first.** If it is not `...pox-4` (mainnet runs pox-5 since Epoch 4.0), write operations are unsupported and refuse without sending a transaction; only the read operations are usable

- Wallet unlocked via `bun run wallet/wallet.ts unlock` (for `stack-stx` and `extend-stacking` only)
- Sufficient STX balance to meet the minimum stacking threshold (check with `get-pox-info`)
- A Bitcoin reward address expressed as version byte + hashbytes hex (not base58check)
- `--start-burn-height` must fall within the prepare phase of the current PoX cycle
- `--lock-period` between 1 and 12 cycles; each mainnet cycle is approximately 2 weeks

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Check current cycle, min stacking amount, timing | `get-pox-info` — returns cycle data and BTC block timing |
| Verify if an address is currently stacking | `get-stacking-status` — returns lock amount, unlock height, cycles |
| Lock STX to earn BTC rewards | `stack-stx` — requires BTC reward address and burn height |
| Extend an existing stacking commitment | `extend-stacking` — adds cycles to current lock period |

## Safety Checks

- Before `stack-stx`: run `get-pox-info` to confirm `minAmountUstx` — stacking below the threshold is rejected
- Before `stack-stx`: verify `--start-burn-height` is within `nextCycle.prepare_phase_start_block_height` window
- Before `stack-stx`: STX will be locked for the full `--lock-period` — funds cannot be withdrawn until `unlockHeight`
- Before `extend-stacking`: confirm current stacking is active via `get-stacking-status`; can only extend, not cancel
- Bitcoin address version values: `0`=P2PKH, `1`=P2SH, `4`=P2WPKH, `5`=P2WSH, `6`=P2TR
- Bitcoin hashbytes length: 20 bytes (hex 40 chars) for P2PKH/P2SH/P2WPKH; 32 bytes (hex 64 chars) for P2WSH/P2TR

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Stacking writes are disabled: this network's active PoX contract is ...pox-5" | pox-5 replaced the pox-4 stacking functions this skill calls | Do not retry; stacking via this skill is unavailable until pox-5 staking support lands |
| "Could not confirm the active PoX contract from the Stacks API" | `/v2/pox` unreachable; writes fail closed | Retry later |
| "No active wallet found. Specify --wallet-id." | Wallet session expired or not unlocked | Run `bun run wallet/wallet.ts unlock` |
| "--pox-address-version must be a non-negative integer" | Invalid version byte passed | Use 0, 1, 4, 5, or 6 matching your BTC address type |
| "--start-burn-height must be a positive integer" | Non-integer or zero burn height | Pass a valid positive BTC block height |
| "--lock-period must be an integer between 1 and 12" | Lock period out of range | Use 1–12 cycles |
| "--extend-count must be an integer between 1 and 12" | Extend count out of range | Use 1–12 additional cycles |

## Output Handling

- `get-pox-info`: use `nextCycle.prepare_phase_start_block_height` as `--start-burn-height` for `stack-stx`
- `get-pox-info`: `minAmountUstx` is the minimum to pass to `--amount` in `stack-stx`
- `get-stacking-status`: `stacked: true` confirms active stacking; `unlockHeight` is the BTC block when STX unlocks
- `stack-stx`: `txid` and `explorerUrl` confirm the lock transaction; `lockPeriod` and `startBurnHeight` echo inputs
- `extend-stacking`: `txid` confirms the extension; `extendCount` echoes the number of additional cycles added

## Example Invocations

```bash
# Get current PoX cycle info and minimum stacking amount
bun run stacking/stacking.ts get-pox-info

# Check stacking status for the active wallet
bun run stacking/stacking.ts get-stacking-status

# Stack 100,000 STX for 6 cycles using a P2WPKH Bitcoin address
bun run stacking/stacking.ts stack-stx \
  --amount 100000000000 \
  --pox-address-version 4 \
  --pox-address-hashbytes <20-byte-hex> \
  --start-burn-height <prepare-phase-block> \
  --lock-period 6
```
