---
name: bitflow-hodlmm-withdraw
description: "Withdraws Bitflow HODLMM liquidity across one or more bins with proof-ready guardrails."
metadata:
  author: "macbotmini-eng"
  author-agent: "Hex Stallion"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "bitflow-hodlmm-withdraw/bitflow-hodlmm-withdraw.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, infrastructure, l2"
---

# Bitflow HODLMM Withdraw

## What it does

`bitflow-hodlmm-withdraw` withdraws full or partial liquidity from Bitflow HODLMM bins on Stacks mainnet. It is a primitive write skill: one action, one HODLMM withdrawal transaction, and proof-ready JSON output.

It does not claim HODLMM earnings separately. HODLMM LP value is represented by per-bin liquidity, so exiting value means withdrawing from one or more bins.

## Why agents need it

Agents need a reliable exit primitive before they can build full economic loops such as HODLMM-to-Zest routing. Without this primitive, a router can identify that capital should move, but it cannot safely execute the HODLMM withdrawal leg.

## Safety notes

- This is a write skill and can move funds.
- Mainnet only.
- `run` refuses to broadcast unless `--confirm=EXIT` is supplied.
- The skill rechecks pool metadata, active bin, user bins, estimated outputs, gas balance, and pending mempool state immediately before transaction construction.
- Withdrawals use minimum token output amounts for slippage protection.
- By default, the skill selects all eligible user bins and withdraws 100% of the selected scope.
- Agents can narrow scope with `--bin-id <id>` or `--bin-ids <ids>`, or make full-scope intent explicit with `--all-bins`.
- Transactions use `PostConditionMode.Deny` with explicit postconditions for aggregate max DLP spend, one selected per-bin `pool-token-id` send per bin, and aggregate minimum token outputs where Stacks postconditions can express them.
- Signing follows the AIBTC wallet model: prefer an already-unlocked active wallet session, then a restored cross-process AIBTC session, then `CLIENT_MNEMONIC`, `STACKS_PRIVATE_KEY`, or `AIBTC_WALLET_PASSWORD` fallback.
- Wallet secrets are never printed.

## Commands

### doctor

Checks API reachability, contract existence, wallet position availability, gas balance, pending transaction depth, and postcondition model.

```bash
bun run bitflow-hodlmm-withdraw/bitflow-hodlmm-withdraw.ts doctor --wallet <stacks-address> --pool-id <pool-id>
```

### status

Read-only position and withdrawal preview. It returns an agent-readable bin index in `withdrawableBins`, the current `selectedBins`, aggregate `totals`, and `selection.availableModes`.

Default selection is full position scope: all eligible user bins with `--withdraw-bps 10000`.

```bash
bun run bitflow-hodlmm-withdraw/bitflow-hodlmm-withdraw.ts status --wallet <stacks-address> --pool-id <pool-id>
```

Optional scope controls:

```bash
bun run bitflow-hodlmm-withdraw/bitflow-hodlmm-withdraw.ts status --wallet <stacks-address> --pool-id <pool-id> --bin-id <bin-id>
bun run bitflow-hodlmm-withdraw/bitflow-hodlmm-withdraw.ts status --wallet <stacks-address> --pool-id <pool-id> --bin-ids <bin-id>,<bin-id>
bun run bitflow-hodlmm-withdraw/bitflow-hodlmm-withdraw.ts status --wallet <stacks-address> --pool-id <pool-id> --all-bins --withdraw-bps <bps>
```

### run

Rechecks all live state, builds the HODLMM withdrawal transaction, broadcasts only after explicit confirmation, and returns proof JSON.

```bash
bun run bitflow-hodlmm-withdraw/bitflow-hodlmm-withdraw.ts run --wallet <stacks-address> --pool-id <pool-id> --confirm=EXIT
```

With no bin selector, `run` withdraws all eligible bins. To withdraw a strategy-selected subset, pass `--bin-id` or `--bin-ids` from the latest `status` output.

For autonomous loops, unlock the AIBTC wallet once before the loop using the wallet skill or MCP `wallet_unlock`; this skill will use the active/restored session without needing the password on every call. Inline secret fallbacks are for proof or recovery runs only. Never pass wallet secrets in command text that may be copied into logs.

## Output contract

All outputs are JSON to stdout.

**Success:**

```json
{ "status": "success", "action": "...", "data": {}, "error": null }
```

**Blocked:**

```json
{ "status": "blocked", "action": "...", "data": {}, "error": { "code": "...", "message": "...", "next": "..." } }
```

**Error:**

```json
{ "error": "descriptive message" }
```

## Known constraints

- The skill is wallet-agnostic and pool-agnostic. Any concrete proof wallet or pool is a local proof fixture, not a hardcoded product target.
- The skill is not an earnings-only harvester.
- DLP positions are HODLMM pool-token shares by bin. The skill constrains aggregate DLP spend, verifies the pool exposes `pool-token-id`, and adds one `pool-token-id` NFT postcondition for each selected withdrawal bin.
- `--amount` is only valid with exactly one selected bin. Use `--withdraw-bps` for multi-bin withdrawals.
- A confirmed proof run requires an unlocked/restorable signer for the caller wallet and enough STX for gas.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition (Day 22).
Original author: @macbotmini-eng
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/551
