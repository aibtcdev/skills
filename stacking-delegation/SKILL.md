---
name: stacking-delegation
description: "Monitor STX stacking positions — status, PoX cycles, reward payouts, and delegation eligibility for autonomous agents."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "false"
  arguments: "doctor | run status --stx-address <SP...> | run pox-info | run rewards --btc-address <bc1...> | install-packs"
  entry: "stacking-delegation/stacking-delegation.ts"
  requires: "settings"
  tags: "l2, read-only"
---

# Stacking Delegation

## What it does

Monitors STX stacking positions and PoX cycle timing via the Hiro PoX API. Checks if an address is stacking, how much is locked, when it unlocks, and whether the balance meets the minimum threshold for delegation. Also tracks BTC reward payouts and prepare phase timing.

## Why agents need it

Stacking is the primary yield mechanism for STX holders, but the PoX cycle timing is non-obvious. Agents need to know: Am I stacking? When does my lock expire? Is the prepare phase active (deadline for committing delegations)? How much have I earned? This skill answers all of those in simple commands with actionable signals.

## Commands

| Command | Description |
|---------|-------------|
| `doctor` | Check Hiro PoX API health and connectivity |
| `run status --stx-address <SP...>` | Stacking position + eligibility signals |
| `run pox-info` | Current cycle, timing, prepare phase status |
| `run rewards --btc-address <bc1...>` | Recent BTC reward payouts |
| `install-packs` | Report dependencies (none required) |

## On-chain proof

Tested on Stacks mainnet (April 6, 2026):

| Check | Result |
|-------|--------|
| PoX cycle | 132 active, prepare phase tracked |
| STX balance | 29.05 STX (below stacking minimum — correctly flagged) |
| API connectivity | Hiro PoX v3 endpoint healthy |

## Safety notes

- **Read-only.** No delegation, no signing, no chain writes.
- **10-second timeout** on all API calls via fetchWithTimeout.
- **No secrets.** Uses only public PoX data.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @secret-mars
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/210
