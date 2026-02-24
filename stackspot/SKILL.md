---
name: stackspot
description: Stacking lottery pots on stackspot.app — pool STX into pots that get stacked via PoX, VRF picks a random winner for sBTC rewards, and all participants get their STX back. Mainnet-only.
user-invocable: false
arguments: list-pots | get-pot-state | join-pot | start-pot | claim-rewards | cancel-pot
entry: stackspot/stackspot.ts
requires: [wallet]
tags: [l2, write, mainnet-only, requires-funds]
---

# Stackspot Skill

Provides stacking lottery pot operations on [stackspot.app](https://stackspot.app):

- **Pot Discovery** — List all known pot contracts with their current value and lock status.
- **Pot State** — Query full on-chain state for a pot: value, participant count, lock status, config, pool config, and details.
- **Join Pot** — Contribute STX to a pot before it fills and starts stacking.
- **Start Pot** — Trigger a full pot to begin stacking through the platform contract.
- **Claim Rewards** — Claim sBTC rewards if your address was selected as the VRF winner.
- **Cancel Pot** — Cancel a pot before it starts and recover contributed STX.

**How it works:** Participants join pots by contributing STX. When a pot reaches its maximum participant count, the platform contract triggers stacking via Proof of Transfer (PoX) for one full cycle. At unlock, a VRF-selected winner receives the stacking yield in sBTC. All participants (winner included) receive their original STX back.

All stackspot operations are **mainnet-only**. Write operations (join-pot, start-pot, claim-rewards, cancel-pot) require an unlocked wallet (use `bun run wallet/wallet.ts unlock` first).

## Usage

```
bun run stackspot/stackspot.ts <subcommand> [options]
```

## Subcommands

### list-pots

List all known stackspot pot contracts with their current on-chain value and lock status.

```
bun run stackspot/stackspot.ts list-pots
```

Output:
```json
{
  "network": "mainnet",
  "potCount": 3,
  "pots": [
    {
      "name": "Genesis",
      "contract": "SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.Genesis",
      "maxParticipants": 2,
      "minAmountStx": 20,
      "currentValueUstx": "40000000",
      "isLocked": false
    }
  ]
}
```

### get-pot-state

Get the full on-chain state for a specific pot. Queries all read-only functions: value, participant count, lock status, configuration, pool config, and details.

```
bun run stackspot/stackspot.ts get-pot-state --contract-name <name>
```

Options:
- `--contract-name` (required) — Pot contract name (e.g., `Genesis`, `BuildOnBitcoin`, `STXLFG`)

Output:
```json
{
  "network": "mainnet",
  "contractName": "STXLFG",
  "contractId": "SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG",
  "state": {
    "potValueUstx": "2100000000",
    "isLocked": false,
    "configs": { "value": "..." },
    "poolConfig": { "value": "..." },
    "details": { "value": "..." }
  }
}
```

### join-pot

Contribute STX to a pot. The amount must be at least the pot's minimum. STX is locked in the contract until the pot completes its stacking cycle and all participants can withdraw. Requires an unlocked wallet.

```
bun run stackspot/stackspot.ts join-pot --contract-name <name> --amount <microStx>
```

Options:
- `--contract-name` (required) — Pot contract name (e.g., `STXLFG`)
- `--amount` (required) — Amount to contribute in micro-STX (1 STX = 1,000,000 micro-STX)

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet",
  "pot": {
    "contractName": "STXLFG",
    "amountUstx": "21000000"
  }
}
```

### start-pot

Trigger a full pot to begin stacking. Calls the platform contract which starts the PoX stacking cycle for the pot. The pot must have reached its maximum participant count. Requires an unlocked wallet.

```
bun run stackspot/stackspot.ts start-pot --contract-name <name>
```

Options:
- `--contract-name` (required) — Pot contract name to start stacking

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet",
  "pot": {
    "contractName": "STXLFG"
  }
}
```

### claim-rewards

Claim sBTC rewards if the active wallet was selected as the VRF winner for a completed pot. The pot must have finished its stacking cycle. Non-winners receive no sBTC but do get their STX back via the same mechanism. Requires an unlocked wallet.

```
bun run stackspot/stackspot.ts claim-rewards --contract-name <name>
```

Options:
- `--contract-name` (required) — Pot contract name to claim rewards from

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet",
  "pot": {
    "contractName": "STXLFG"
  }
}
```

### cancel-pot

Cancel a pot before it starts stacking. Allows participants to recover their contributed STX. The pot must not yet be locked (stacking must not have started). Requires an unlocked wallet.

```
bun run stackspot/stackspot.ts cancel-pot --contract-name <name>
```

Options:
- `--contract-name` (required) — Pot contract name to cancel

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet",
  "pot": {
    "contractName": "Genesis"
  }
}
```

## Notes

- All stackspot operations are **mainnet-only**. Calls on testnet will return an error.
- Write operations require an unlocked wallet (use `bun run wallet/wallet.ts unlock` first).
- **STX lock-up:** When you join a pot, your STX is locked for one full PoX stacking cycle (~2 weeks). Do not join a pot with STX you need access to in the short term.
- **VRF winner selection:** One participant is chosen randomly at unlock. The winner receives all stacking yield in sBTC. All participants (including the winner) receive their original STX back.
- **Timing windows:** Pots can only be started during the prepare phase of a PoX cycle. If start-pot fails, check the current PoX cycle phase using `bun run stacking/stacking.ts get-pox-info`.
- **Contract architecture:** Individual pot contracts are deployed by `SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85`. The platform contract `SP7FSE31MWSJJFTQBEQ1TT6TF3G4J6GDKE81SWD9.stackspots` orchestrates starting pots and distributing rewards.
- **Known pots:** Genesis (max 2 participants, min 20 STX), BuildOnBitcoin (max 10, min 100 STX), STXLFG (max 100, min 21 STX).
