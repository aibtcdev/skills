---
name: bitflow-hodlmm-zest-yield-loop
description: "Composes accepted HODLMM primitives with Zest position reads into a checkpointed HODLMM-Zest yield router."
metadata:
  author: "macbotmini-eng"
  author-agent: "Hex Stallion"
  user-invocable: "false"
  arguments: "doctor | status | plan | run | resume | cancel"
  entry: "bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts"
  requires: "wallet, signing, settings, bitflow-hodlmm-withdraw, bitflow-hodlmm-deposit, hodlmm-move-liquidity, zest-yield-manager"
  tags: "defi, write, mainnet-only, requires-funds, infrastructure, l2"
---

# Bitflow HODLMM-Zest Yield Loop

## What it does

`bitflow-hodlmm-zest-yield-loop` is a composed controller for the #471 yield-routing path. It coordinates caller-owned sBTC capital between Bitflow HODLMM and Zest by planning route legs, calling accepted primitive skill CLIs, and saving checkpoint state after each confirmed leg.

This is not a primitive deposit, primitive withdrawal, leverage loop, borrow skill, or generic multi-protocol executor. HODLMM write mechanics stay inside `bitflow-hodlmm-withdraw`, `bitflow-hodlmm-deposit`, and `hodlmm-move-liquidity`.

## Why agents need it

Agents need a sequencing layer above atomic primitives. A route from HODLMM to Zest or from Zest back to HODLMM may require multiple writes, fresh reads, confirmation between legs, and resume/cancel behavior when a route stops after a partial completion.

## Safety notes

- This is a composed write skill and can move funds.
- Mainnet only.
- `run` and write-capable `resume` require `--confirm=ROUTE`.
- Every delegated write leg must also use its primitive-specific confirmation token and return a txid. The controller persists the txid before checking Hiro so interrupted confirmation can be recovered with `resume --txid`, then marks the leg confirmed only after Hiro verifies `tx_status=success`.
- It refuses a new route when unresolved checkpoint state exists.
- It shells out to primitive CLIs and only trusts a single JSON object from each primitive.
- It does not import source from other skill directories.
- It composes the accepted HODLMM selected-bin primitives from #551 and #556, as required by the #559 PRD.
- It only treats existing registry surfaces as dependencies when they are named by the PRD and listed in the AIBTC skills directory.
- First-time HODLMM position creation in an existing sBTC pool is valid. A wallet with no prior pool bins must not be rejected when the pool metadata check passes.
- Zest write legs block unless the installed Zest surface reads positions through `v0-1-data.get-user-position`, converts `suppliedShares` to asset units for economic checks, and produces a confirmed transaction result that the controller can verify.
- It does not borrow, create leverage, repay, or unwind debt.

## Commands

### doctor

Checks dependency presence, wallet gas/mempool state, saved checkpoint state, and primitive readiness.

```bash
bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts doctor --wallet <stacks-address> --pool-id <pool-id>
```

### status

Reads current route posture without broadcasting.

```bash
bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts status --wallet <stacks-address> --source idle --target hodlmm --pool-id <pool-id> --amount-sats <amount>
```

### plan

Builds an ordered route plan by calling primitive read-only previews where available.

```bash
bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts plan --wallet <stacks-address> --source idle --target hodlmm --pool-id <pool-id> --amount-sats <amount>
```

`plan` includes `economicCheck`, `freshness`, and `state` fields. When comparable HODLMM/Zest route data is unavailable, the controller reports the missing read instead of silently choosing a weaker route.

### run

Executes the selected route only after explicit route confirmation. Every delegated write leg must return a txid, and Hiro must verify that txid as `tx_status=success` before the controller marks the leg confirmed or starts another leg.

```bash
bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts run --wallet <stacks-address> --source idle --target hodlmm --pool-id <pool-id> --amount-sats <amount> --confirm=ROUTE
```

### resume

Continues only from supported saved checkpoints after explicit confirmation. If a delegated primitive broadcast succeeded but the controller stopped before checkpoint advancement, pass the confirmed txid so the controller can verify it on Hiro and complete the saved route without rebroadcasting.

```bash
bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts resume --wallet <stacks-address> --confirm=ROUTE
bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts resume --wallet <stacks-address> --confirm=ROUTE --txid <confirmed-txid>
```

### cancel

Marks unresolved saved state as operator-cancelled.

```bash
bun run bitflow-hodlmm-zest-yield-loop/bitflow-hodlmm-zest-yield-loop.ts cancel --wallet <stacks-address>
```

## Output contract

Every command prints exactly one JSON object to stdout.

```json
{
  "status": "success|blocked|error",
  "action": "doctor|status|plan|run|resume|cancel",
  "data": {},
  "error": null
}
```

## Known constraints

- This controller is the #471 HODLMM-Zest yield router surface, not the #473 leverage stack.
- The differentiation from `stacks-alpha-engine` is the primitive-only composition contract: this skill sequences HODLMM + Zest primitives with checkpoints, while `stacks-alpha-engine` is a broader multi-protocol executor and five-stage safety pipeline.
- The dependency list is constrained to the #559 PRD: #551/#556 for accepted HODLMM entry/exit, `hodlmm-move-liquidity` for HODLMM rebalance, and the existing AIBTC-listed Zest surface for Zest-side reads/writes.
- Cross-venue Zest write routes require the Zest dependency to return canonical position reads and confirmed transaction evidence. If it only returns a handoff, non-broadcast plan, direct `suppliedShares` value without conversion, or non-canonical market-contract read, this controller blocks instead of claiming execution.
- Borrowing is intentionally outside scope. This skill does not call Zest borrow helpers; any future borrow composition would need a separate PRD update and mainnet-proofed helper version.
- Checkpoints live at the standard AIBTC runtime state path for this skill: `~/.aibtc/state/bitflow-hodlmm-zest-yield-loop/<wallet>.json`.
- Resume never blind-retries a write leg. It only advances a saved route from a supplied txid after Hiro confirms `tx_status=success` and the tx sender matches `--wallet`.
- Auto-selection is conservative. When the route is ambiguous or comparable EV/freshness data is unavailable, the controller reports `hold`/blocked route context and requires explicit `--source` and `--target` instead of guessing.
- `--mempool-depth-limit 0` is intentional: no pending sender transactions are allowed before a route write.
- Mainnet proof belongs in the PR body, not in this generic skill description.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @macbotmini-eng
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/582
