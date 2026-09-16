---
name: stacking-agent
skill: stacking
description: PoX-5 STX staking on Stacks — cycle state, staking status, signer managers, stake / update / unstake, and sBTC reward claims.
---

# Stacking Agent

Handles STX staking on PoX-5. A stake locks STX with a **signer manager** contract for a number of reward cycles; rewards accrue in sBTC to the manager and are claimed per cycle. Read subcommands need no wallet. Writes need an unlocked wallet and always confirm pox-5 is the active PoX contract before signing.

## Prerequisites

- Wallet unlocked via `bun run wallet/wallet.ts unlock` (for `stack-stx`, `extend-stacking`, `unstake-stx`, `claim-rewards`)
- `NETWORK=mainnet` for mainnet staking (default is testnet)
- STX for the lock amount plus the transaction fee; `extend-stacking` increases draw on **unlocked** STX only
- A signer manager contract id, chosen with `list-signers`

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Cycle, burn height, prepare-phase timing | `get-pox-info` |
| Is an address staking, with whom, until when | `get-stacking-status` |
| Pick a signer manager | `list-signers` (add `--with-payout-info` to see who supports on-chain claims) |
| Start staking | `stack-stx` |
| Extend, add STX, switch manager, change payout | `extend-stacking` (any combination in one call) |
| Stop early | `unstake-stx` (unlocks at the start of next cycle) |
| See claimable rewards for a cycle | `get-rewards` |
| Collect rewards for a cycle | `claim-rewards` |

## Safety Checks

- Before any write: `get-pox-info`; if `inPreparePhase` is true, wait until `nextCycleStartHeight` — writes are refused during the prepare phase
- Before `stack-stx`: `get-stacking-status` must show `staking: false`; otherwise use `extend-stacking`
- Before `stack-stx`: confirm the manager's own terms (allowlists, minimums, required `--btc-reward-address`). A stake the manager refuses aborts on chain and still costs the fee
- `--num-cycles` locks STX for up to 96 cycles (~4 years); STX cannot be moved until `unlockBurnHeight` unless `unstake-stx` is called, which still waits for the next cycle
- `claim-rewards` may send **two** transactions (manager pull, then staker claim); check `get-rewards` first and only claim when `unclaimedSatsBeforeFees` > 0 and `stakerClaim` is not `none`
- Never pass both `--btc-reward-address` and `--signer-calldata-hex`

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "pox-5 refuses ... during the prepare phase" | Burn height is in the last 100 blocks of the cycle | Retry at or after the burn height named in the error |
| "... is already staking ... Use extend_stacking" | Address has a stake | Use `extend-stacking` |
| "... is not staking" | No stake to update / unstake / look up | Use `stack-stx`, or pass `--signer-manager` for past rewards |
| "... is not a registered pox-5 signer manager" | Wrong or unregistered contract id | Pick one from `list-signers` |
| "Insufficient STX" / "Insufficient unlocked STX" | Balance too low | Fund the wallet or reduce the amount |
| "Nothing to update" | `extend-stacking` with no changes | Pass at least one change |
| "unstaking would not unlock it sooner" | Stake already ends next cycle | No action needed |
| "has no on-chain staker claim" | Manager pays off-chain | Do not retry; contact the manager |
| "No unclaimed rewards" | Nothing earned or already claimed for that cycle | Check another cycle with `get-rewards` |
| "Stacking writes are disabled: this network's active PoX contract is ..." | A newer PoX contract replaced pox-5 | Do not retry; the skill needs updating |
| "Could not confirm the active PoX contract from the Stacks API" | `/v2/pox` unreachable; writes fail closed | Retry later |

## Output Handling

- `get-pox-info`: `inPreparePhase`, `nextCycleStartHeight` gate writes
- `get-stacking-status`: `staking`, `stake.signerManager`, `stake.unlockBurnHeight`, `balance.unlockedUstx`
- `list-signers`: `signers[].signerManager` feeds `--signer-manager`
- Writes: `txid` and `explorerUrl`; `unlockCycle` / `unlockBurnHeight` give the new unlock point
- `get-rewards`: `unclaimedSatsBeforeFees`, `stakerClaim`, `next`
- `claim-rewards`: `txid` of the staker claim, `managerPull.txid` when a pull was sent first

## Example Invocations

```bash
NETWORK=mainnet bun run stacking/stacking.ts get-pox-info
NETWORK=mainnet bun run stacking/stacking.ts list-signers --with-payout-info
NETWORK=mainnet bun run stacking/stacking.ts stack-stx \
  --signer-manager SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-2 \
  --amount 1000000000 --num-cycles 6
NETWORK=mainnet bun run stacking/stacking.ts get-rewards --reward-cycle 144
NETWORK=mainnet bun run stacking/stacking.ts claim-rewards --reward-cycle 144
```
