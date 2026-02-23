---
name: stackspot
description: "STX stacking lottery pots on stackspot.app — pool STX into a pot that gets stacked via PoX, VRF picks a random winner who gets ~90% of sBTC rewards, everyone gets STX back. Zero-risk lottery. Write operations require an unlocked wallet with STX."
user-invocable: false
arguments: get-pot-state | join-pot | start-pot | claim-rewards | cancel-pot | list-pots
requires: [wallet]
tags: [l2, stacking, lottery, write, mainnet-only, requires-funds]
---

# Stackspot — STX Stacking Lottery Pots

[stackspot.app](https://stackspot.app) — Pool STX into a "pot" that gets stacked via PoX. One random winner gets the sBTC stacking rewards. Everyone gets their STX back.

## How It Works

1. **A pot is deployed** as a Clarity contract implementing `stackspot-trait`
2. **Users join** by depositing STX (minimum amount per pot, e.g., 21 STX for STXLFG)
3. **Someone starts the pot** → STX gets delegated to a stacking pool via `pox4-multi-pool-v1`
4. **STX is locked for 1 PoX cycle** (~2 weeks) and earns sBTC stacking rewards
5. **After the cycle**, someone claims the pot:
   - **VRF selects a random winner** from participants
   - **Everyone gets their STX back** (principal returned)
   - **Winner gets ~90% of sBTC rewards**, rest split among platform (1%), pot owner (5%), starter (2%), claimer (2%)

## Contract Architecture

### Platform contracts (SP7FSE31MWSJJFTQBEQ1TT6TF3G4J6GDKE81SWD9)

| Contract | Role |
|----------|------|
| `stackspots` | Registry, NFT minting, dispatch orchestrator |
| `stackspot-trait` | Interface all pots must implement |
| `stackspot-distribute` | Handles STX refunds and sBTC reward distribution |
| `stackspot-vrf` | VRF-based random number generation for winner selection |
| `stackspot-admin` | Deployment access control |
| `stackspot-registry` | Event logging |
| `stackspot-winners` | Winner event logging |
| `stackspot-audited-contracts` | Contract whitelist |

### Individual Pot Contracts

All pots share identical code (461 lines). Only 3 constants differ per pot:

| Pot | Contract | Max | Min STX | Status |
|-----|----------|-----|---------|--------|
| Genesis | `SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.Genesis` | 2 | 20 | ✅ Completed |
| BuildOnBitcoin | `SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.BuildOnBitcoin` | 10 | 100 | 🟡 Started |
| STXLFG | `SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG` | 100 | 21 | 🔵 Filling |

## Key Functions

### Joining a Pot

```bash
# Via MCP (amount in uSTX: 21 STX = 21000000)
mcporter call aibtc.call_contract \
  contractAddress=SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85 \
  contractName=STXLFG \
  functionName=join-pot \
  functionArgs='[21000000]'
```

- Amount in uSTX (21 STX = 21,000,000 uSTX)
- Must be ≥ pot's `min-amount`
- Cannot join if locked, cancelled, or max participants reached
- Cannot join twice

### Starting a Pot (anyone can — earns 2% reward)

```clarity
(contract-call? 'SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG
  start-stackspot-jackpot
  'SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG)
```

- Requires pot to be fully funded (all slots filled)
- Delegates STX to stacking pool and locks the pot
- Starter gets 2% of eventual sBTC rewards

### Claiming Rewards (anyone can — earns 2% reward)

```clarity
(contract-call? 'SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG
  claim-pot-reward
  'SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG)
```

- Requires: burn block height > `reward-release` (cycle end + 432 blocks)
- VRF selects random winner
- Returns all STX to participants
- Distributes sBTC: winner ~90%, pot owner 5%, starter 2%, claimer 2%, platform 1%

### Cancelling (if pot doesn't fill)

```clarity
(contract-call? 'SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG
  cancel-pot
  'SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG)
```

- Only if not locked (not yet started)
- Must wait > 1 full PoX cycle after first user joined
- Returns all STX to participants

## Read-Only Queries

| Function | Args | Returns |
|----------|------|---------|
| `get-pot-value` | none | Total STX deposited (uSTX) |
| `get-last-participant` | none | Participant count (uint) |
| `is-locked` | none | Whether stacking has started (bool) |
| `get-configs` | none | `{cycles, min-amount, max-participants}` |
| `get-pool-config` | none | `{join-end, prepare-start, cycle-end, reward-release}` |
| `get-pot-participant-values` | `(who principal)` | User's deposit info |
| `get-pot-details` | none | Full state including winner, starter, claimer |

```bash
# Example: check pot value
curl -s -X POST "https://api.hiro.so/v2/contracts/call-read/SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85/STXLFG/get-pot-value" \
  -H "Content-Type: application/json" \
  -d '{"sender":"SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85","arguments":[]}'
```

## Reward Economics

For a full STXLFG pot (100 × 21 STX = 2,100 STX stacked for 1 cycle):

- Stacking yield: ~5-8% APY → ~2-3% per 2-week cycle
- Estimated sBTC reward depends on BTC/STX price and yield
- Winner EV = 90% × total_yield × (1/participants)
- **Zero principal risk** — STX always returned regardless of outcome
- Opportunity cost: STX locked for ~2 weeks

## Timing Windows

Each pot has burn block height windows:

- **join-end**: Last block to join before prepare phase
- **prepare-start**: Stacking prepare phase begins
- **cycle-end**: PoX cycle ends, STX unlocks
- **reward-release**: Earliest block to claim (cycle-end + 432 blocks)

Query via `get-pool-config` read-only function.

## Lifecycle Example (Genesis pot — completed)

1. Deploy (block 5,933,253)
2. 2× join-pot — 2 participants × 20 STX = 40 STX
3. start-stackspot-jackpot — STX delegated to stacking pool
4. transfer-many — sBTC rewards deposited into contract
5. claim-pot-reward — VRF winner selected, rewards distributed

## Notes

- All 3 known pots share identical 461-line contract code (verified via SHA256)
- BuildOnBitcoin started with only 5/10 participants — full fill not always required
- Stacking is delegated via `pox4-multi-pool-v1` to the sBTC stacking pool
- Platform fee on pot creation: 0.1 STX
- VRF source: `stackspot-vrf` contract for verifiable randomness
- Source: [github.com/Zeus-Adin/stackspot-contract](https://github.com/Zeus-Adin/stackspot-contract/blob/main/mainnet)
