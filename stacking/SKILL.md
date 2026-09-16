---
name: stacking
description: "PoX-5 STX staking on Stacks — query cycle state and staking status, list signer managers, stake / update / unstake STX with a signer manager, and check or claim sBTC rewards. Write operations require an unlocked wallet."
metadata:
  author: "whoabuddy"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "get-pox-info | get-stacking-status | list-signers | stack-stx | extend-stacking | unstake-stx | get-rewards | claim-rewards"
  entry: "stacking/stacking.ts"
  mcp-tools: "get_pox_info, get_stacking_status, list_stacking_signers, stack_stx, extend_stacking, unstake_stx, get_stacking_rewards, claim_stacking_rewards"
  requires: "wallet"
  tags: "l2, write, requires-funds"
---

# Stacking Skill

STX staking on **PoX-5** (active on mainnet since reward cycle 141). PoX-5 is not a rename of pox-4:

- Every stake names a **signer manager**, a contract implementing pox-5's `signer-manager-trait`. There is no pool delegation (`delegate-stx`) and no reward address on the stake itself; the manager decides who may join and reads any payout preferences from optional **signer calldata**.
- Rewards are paid in **sBTC to the signer manager**. A staker is paid when the manager pulls its share from pox-5 (`claim-rewards`) and then pays the staker (`claim-staker-rewards`). Managers implement that second step differently, and some pay off-chain.
- `stake`, `stake-update` and `unstake` are refused during the **prepare phase** (the last 100 blocks of each cycle).
- Locks are not transfers: transactions carry pox-5's own post-conditions (a staking lock amount, or "performs PoX") in Deny mode.

Every write first confirms pox-5 is still the network's active PoX contract and refuses before signing otherwise.

- **get-pox-info**, **get-stacking-status**, **list-signers**, **get-rewards** — read-only, no wallet required (status and rewards default to the active wallet's address).
- **stack-stx**, **extend-stacking**, **unstake-stx**, **claim-rewards** — write operations, require an unlocked wallet.

## Usage

```
bun run stacking/stacking.ts <subcommand> [options]
```

## Subcommands

### get-pox-info

Current PoX-5 state.

```
bun run stacking/stacking.ts get-pox-info
```

Output:
```json
{
  "network": "mainnet",
  "contract": "SP000000000000000000002Q6VF78.pox-5",
  "burnHeight": 967284,
  "rewardCycle": 143,
  "nextCycleStartHeight": 968450,
  "preparePhaseStartHeight": 968350,
  "inPreparePhase": false,
  "firstBurnHeight": 666050,
  "rewardCycleLength": 2100,
  "prepareCycleLength": 100,
  "signerSetMinUstx": "50000000000",
  "totalLiquidSupplyUstx": "1867006091924579"
}
```

`signerSetMinUstx` is the minimum a **signer** needs delegated to join the signer set, not a per-staker minimum.

### get-stacking-status

```
bun run stacking/stacking.ts get-stacking-status [--address <addr>]
```

Output:
```json
{
  "address": "SP1PSZZYFH9H5M81KGBV2XTFQBR3HQ17HJW7Y4ZK2",
  "network": "mainnet",
  "staking": true,
  "stake": {
    "signerManager": "SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-2",
    "amountUstx": "500000000",
    "amount": "500.000000 STX",
    "firstRewardCycle": 144,
    "numCycles": 96,
    "unlockCycle": 240,
    "unlockBurnHeight": 1170050
  },
  "bond": null,
  "balance": {
    "totalUstx": "560494462",
    "lockedUstx": "500000000",
    "unlockedUstx": "60494462",
    "burnchainUnlockHeight": 1170050
  },
  "pox": { "contract": "SP000000000000000000002Q6VF78.pox-5", "burnHeight": 967284, "rewardCycle": 143, "nextCycleStartHeight": 968450, "preparePhaseStartHeight": 968350, "inPreparePhase": false }
}
```

`bond` is set when the address is in a pox-5 protocol bond (`bondIndex`, `amountUstx`, `amountSats`, `isL1Lock`, `signerManager`).

### list-signers

Signer managers in the signer set for a reward cycle (default: the next cycle, which a new stake joins), sorted by delegated STX.

```
bun run stacking/stacking.ts list-signers [--reward-cycle <cycle>] [--with-payout-info]
```

Options:
- `--reward-cycle` (optional) — cycle to list
- `--with-payout-info` (optional) — also read each manager's staker-claim style: `staker-arg` / `caller` (on-chain claim works) or `none` (pays off-chain). One extra request per signer.

Output (truncated):
```json
{
  "network": "mainnet",
  "rewardCycle": 144,
  "count": 26,
  "signers": [
    { "signerManager": "SP1N8F8BBBC60XF6HJBNJHKPRGJ7WZBRGNDJX4YDR.signer-manager", "delegatedUstx": "85815090000000", "delegated": "85815090.000000 STX" }
  ],
  "note": "Managers can restrict who may stake ..."
}
```

Only signers at or above the signer-set minimum appear. Other registered managers can still be staked with by contract id.

### stack-stx

Lock STX with a signer manager. The lock starts next reward cycle.

```
bun run stacking/stacking.ts stack-stx \
  --signer-manager <contractId> \
  --amount <microStx> \
  --num-cycles <1-96> \
  [--btc-reward-address <address> [--max-withdrawal-fee-sats <sats>] | --signer-calldata-hex <hex>]
```

Options:
- `--signer-manager` (required) — signer manager contract id (see `list-signers`)
- `--amount` (required) — micro-STX to lock (1 STX = 1,000,000 micro-STX)
- `--num-cycles` (required) — reward cycles to lock, 1–96 (one cycle ≈ 2 weeks)
- `--btc-reward-address` (optional) — Bitcoin address for rewards, encoded as `{ pox-addr, max-fee }` calldata, the shape reference managers (e.g. Xverse, Fast Pool) use to pay via an sBTC withdrawal. Some managers require it, some ignore it.
- `--max-withdrawal-fee-sats` (optional) — max sBTC withdrawal fee per payout with `--btc-reward-address` (default 3000)
- `--signer-calldata-hex` (optional) — raw calldata (≤500 bytes) for managers with a custom format; not combinable with `--btc-reward-address`

Refused before signing when: in the prepare phase, already staking (use `extend-stacking`), the manager is not a registered pox-5 signer, or the amount exceeds the address's STX balance.

Output:
```json
{
  "success": true,
  "txid": "0x...",
  "explorerUrl": "https://explorer.hiro.so/txid/0x...?chain=mainnet",
  "staker": "SP...",
  "signerManager": "SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-2",
  "amountUstx": "2780000000",
  "amount": "2780.000000 STX",
  "firstRewardCycle": 144,
  "numCycles": 96,
  "unlockCycle": 240,
  "unlockBurnHeight": 1170050,
  "rewardPayout": "sBTC (if the manager supports it)",
  "network": "mainnet"
}
```

### extend-stacking

Update an existing stake (`stake-update`): extend, add STX, switch signer manager, or change payout calldata, in any combination.

```
bun run stacking/stacking.ts extend-stacking \
  [--cycles-to-extend <cycles>] [--amount-increase <microStx>] [--signer-manager <contractId>] \
  [--btc-reward-address <address> [--max-withdrawal-fee-sats <sats>] | --signer-calldata-hex <hex>]
```

Refused when not staking, in the prepare phase, nothing would change, the increase exceeds the **unlocked** balance, the new manager is not registered, or the lock would run more than 96 cycles past the next cycle.

Output: `txid`, `explorerUrl`, `previous` (the stake before), `signerManager`, `newAmountUstx`, `newAmount`, `unlockCycle`, `unlockBurnHeight`.

### unstake-stx

Stop a stake early (`unstake`). STX stays locked through the current cycle and unlocks at the start of the next.

```
bun run stacking/stacking.ts unstake-stx
```

Refused when not staking, in the prepare phase, or when the stake already unlocks next cycle.

Output: `txid`, `explorerUrl`, `previous`, `unlockCycle`, `unlockBurnHeight`.

### get-rewards

sBTC earned from a signer manager for one cycle and not yet claimed.

```
bun run stacking/stacking.ts get-rewards --reward-cycle <cycle> [--address <addr>] [--signer-manager <contractId>]
```

Output:
```json
{
  "address": "SP...",
  "network": "mainnet",
  "rewardCycle": 143,
  "signerManager": "SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-2",
  "unclaimedSatsBeforeFees": "0",
  "managerUnpulledSats": "0",
  "stakerClaim": "staker-arg",
  "next": "Nothing to claim for this cycle."
}
```

### claim-rewards

Claim one cycle's sBTC rewards through the signer manager. If the manager has not pulled that cycle's rewards from pox-5 yet, this first sends the manager's permissionless `claim-rewards` (a second transaction paid by this wallet), then the staker claim.

```
bun run stacking/stacking.ts claim-rewards --reward-cycle <cycle> [--signer-manager <contractId>]
```

Refused when the manager has no on-chain staker claim or nothing is unclaimed. Post-conditions allow sBTC only out of pox-5 (the pull) and the manager (the payout); nothing may leave the caller.

Output: `txid`, `explorerUrl`, `unclaimedSatsBeforeFees`, `managerPull` (`{ txid, explorerUrl }` or `null`), and a `note` when two transactions were sent.

## Notes

- Ported from the aibtc MCP server's pox-5 stacking tools (aibtcdev/aibtc-mcp-server#682); the transaction arguments and post-conditions match mainnet `stake`, `stake-update` and `unstake` transactions.
- Managers can restrict who may stake (allowlists, minimums, required calldata). A stake the manager refuses aborts on chain and still costs the fee, so check the manager's terms first.
- Wallet operations require an unlocked wallet (`bun run wallet/wallet.ts unlock`).
- Pillar's `direct-stack-stx --pool fast-pool` and `direct-revoke-fast-pool` go through pox-4 in the Pillar wallet contract and are refused while pox-4 is not active; use this skill for PoX-5 staking.
