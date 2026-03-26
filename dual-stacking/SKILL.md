---
name: dual-stacking
description: "Dual Stacking enrollment operations on Stacks — earn BTC-denominated rewards (paid in sBTC) by holding sBTC. Check enrollment status and APR data, enroll with a single contract call (no lockup, minimum 10,000 sats sBTC), opt out, and query earned rewards by cycle. Write operations require an unlocked wallet."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "check-status | enroll | opt-out | get-rewards"
  entry: "dual-stacking/dual-stacking.ts"
  requires: "wallet"
  mcp-tools: "dual_stacking_status, dual_stacking_get_rewards, dual_stacking_enroll, dual_stacking_opt_out"
  tags: "l2, write, requires-funds, defi"
---

# Dual Stacking Skill

Dual Stacking lets agents earn BTC-denominated yield (paid in sBTC) simply by holding sBTC — no lockup period required. Optionally, holding stacked STX alongside sBTC unlocks a multiplier of up to 10x on the APR.

- **check-status** — Read-only. Returns enrollment state, APR range, minimum amount, and cycle overview.
- **get-rewards** — Read-only. Returns earned rewards for a specific cycle.
- **enroll** and **opt-out** — Write operations, require an unlocked wallet.

**Contract:** `SP1HFCRKEJ8BYW4D0E3FAWHFDX8A25PPAA83HWWZ9.dual-stacking-v2_0_4`

**APR:**
- sBTC only: ~0.5% APY in sBTC
- sBTC + stacked STX: up to ~5% APY (10x multiplier)

**Minimum enrollment:** 10,000 sats sBTC (0.0001 sBTC)

## Usage

```
bun run dual-stacking/dual-stacking.ts <subcommand> [options]
```

## Subcommands

### check-status

Check enrollment status, APR data, minimum enrollment amount, and current cycle overview for an address.

```
bun run dual-stacking/dual-stacking.ts check-status [--address <STX_ADDRESS>]
```

Options:
- `--address` (optional) — Stacks address to check (uses active wallet if omitted)

Output:
```json
{
  "address": "SP2...",
  "network": "mainnet",
  "enrolledThisCycle": true,
  "enrolledNextCycle": true,
  "minimumEnrollmentSats": 10000,
  "apr": {
    "minApr": 0.5,
    "maxApr": 5,
    "unit": "%",
    "note": "Multiplier up to 10x with stacked STX via PoX"
  },
  "cycleOverview": {
    "currentCycleId": 100,
    "snapshotIndex": 3,
    "snapshotsPerCycle": 144
  }
}
```

### enroll

Enroll in Dual Stacking. The caller's sBTC balance is used to determine rewards. Optionally, a different address can receive the rewards.

```
bun run dual-stacking/dual-stacking.ts enroll [--reward-address <STX_ADDRESS>]
```

Options:
- `--reward-address` (optional) — Stacks address to receive rewards (defaults to caller's address)

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "enrolledAddress": "SP2...",
  "rewardAddress": "SP2...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet"
}
```

### opt-out

Opt out of Dual Stacking. Takes effect from the next cycle.

```
bun run dual-stacking/dual-stacking.ts opt-out
```

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "address": "SP2...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet"
}
```

### get-rewards

Get earned rewards for a specific cycle and address.

```
bun run dual-stacking/dual-stacking.ts get-rewards --cycle <N> [--address <STX_ADDRESS>] [--rollback <N>]
```

Options:
- `--cycle` (required) — Cycle number to query
- `--address` (optional) — Stacks address to check (uses active wallet if omitted)
- `--rollback` (optional) — Rollback offset (default: 0)

Output:
```json
{
  "address": "SP2...",
  "cycle": 99,
  "rollback": 0,
  "rewardSats": 500,
  "rewardBtc": "0.000005",
  "network": "mainnet"
}
```

## Notes

- Enrollment is per-cycle. If you enroll mid-cycle, rewards start from the next cycle.
- The reward multiplier is determined automatically based on how much STX you have stacked via PoX.
- Use the `stacking` skill to stack STX and boost your Dual Stacking APR up to 5% APY.
- Wallet operations require an unlocked wallet (use `bun run wallet/wallet.ts unlock` first, or set `CLIENT_MNEMONIC` env var).
