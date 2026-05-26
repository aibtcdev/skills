---
name: bitflow-funding-coordinator
description: "Coordinates Bitflow funding swaps into route-ready target tokens for downstream strategy skills."
metadata:
  author: "gregoryford963-sys"
  author-agent: "Amber Otter"
  user-invocable: "false"
  arguments: "doctor | status | plan | run | resume | cancel"
  entry: "bitflow-funding-coordinator/bitflow-funding-coordinator.ts"
  requires: "wallet, signing, settings, bitflow-swap-aggregator, nonce-manager"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# Bitflow Funding Coordinator

## What it does

`bitflow-funding-coordinator` is the funding leg for Bitflow-routed strategies. It turns a caller-selected source token into a caller-selected target token through the accepted `bitflow-swap-aggregator`, records a route checkpoint, confirms the swap on Hiro, and emits a handoff payload for downstream strategy skills.

The required v1 acceptance path is STX to sBTC so wallets that start with idle STX can produce route-ready sBTC for `bitflow-hodlmm-zest-yield-loop`.

## Why agents need it

Downstream strategy routers should not quietly perform funding swaps while they are deciding where to place capital. This skill keeps the funding leg explicit: quote, plan, confirm, swap, verify, and hand off the resulting target token without performing HODLMM, Zest, borrow, repay, or unwind actions.

## Safety notes

- This is a write skill and can move wallet funds.
- Mainnet only.
- `run` refuses without `--confirm=FUND`.
- The delegated swap primitive still requires its own `--confirm=SWAP` internally.
- The skill refuses overlapping local checkpoints unless the operator resumes or cancels the prior route.
- The skill records any returned txid before its own Hiro confirmation loop.
- It does not deposit into HODLMM, supply to Zest, borrow, repay, or choose a yield venue.

## Commands

### doctor

Checks wallet, Bitflow swap aggregator availability, nonce-manager availability signal, Hiro reachability, and any pending funding checkpoint.

```bash
bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts doctor --wallet <stacks-address>
```

### status

Reads the local funding checkpoint and the delegated swap primitive's wallet readiness checks.

```bash
bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts status --wallet <stacks-address>
```

### plan

Produces a quote-backed funding plan through `bitflow-swap-aggregator` without broadcasting.

```bash
bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts plan --wallet <stacks-address> --token-in token-stx --token-out token-sbtc --amount-in 1 --handoff-label bitflow-hodlmm-zest-yield-loop
```

### run

Executes the funding swap after explicit confirmation, checkpoints the route, verifies Hiro success, and emits a route-ready handoff.

```bash
bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts run --wallet <stacks-address> --token-in token-stx --token-out token-sbtc --amount-in 1 --confirm=FUND --handoff-label bitflow-hodlmm-zest-yield-loop
```

### resume

Confirms an already-broadcast funding txid and completes the local checkpoint without rebroadcasting.

```bash
bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts resume --wallet <stacks-address> --txid <txid>
```

### cancel

Marks an unresolved local checkpoint as operator-cancelled.

```bash
bun run bitflow-funding-coordinator/bitflow-funding-coordinator.ts cancel --wallet <stacks-address>
```

## Output contract

All commands emit exactly one JSON object to stdout.

Success:

```json
{
  "status": "success",
  "action": "plan",
  "data": {
    "fundingRoute": "token-stx-to-token-sbtc",
    "mode": "one-shot",
    "routeReady": false,
    "handoff": {
      "label": "bitflow-hodlmm-zest-yield-loop",
      "readyToken": "token-sbtc",
      "readyAmount": null
    }
  },
  "error": null
}
```

Blocked:

```json
{
  "status": "blocked",
  "action": "run",
  "data": {},
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "This write skill requires --confirm=FUND.",
    "next": "Review plan output and rerun with --confirm=FUND."
  }
}
```

## Known constraints

- V1 proves STX to sBTC funding for the #471 / #559 route.
- Token selection is delegated to the live Bitflow swap aggregator token registry.
- DCA-style repeated chunks are represented as `--mode dca-chunk`, but autonomous scheduling is intentionally out of scope for this submission.
- This skill does not replace `bitflow-swap-aggregator`; it adds funding checkpoint, resume/cancel, handoff, and downstream-boundary semantics around that primitive.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @macbotmini-eng
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/585

