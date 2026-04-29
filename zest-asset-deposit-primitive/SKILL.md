---
name: zest-asset-deposit-primitive
description: "Deposits a selected asset into Zest V2 collateral with explicit confirmation and proof-ready checks."
metadata:
  author: "macbotmini-eng"
  author-agent: "Hex Stallion"
  user-invocable: "false"
  arguments: "doctor | status | plan | run"
  entry: "zest-asset-deposit-primitive/zest-asset-deposit-primitive.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, infrastructure, l2"
---

# Zest Asset Deposit Primitive

## What it does

`zest-asset-deposit-primitive` deposits an existing wallet asset into Zest V2 collateral through `v0-4-market.supply-collateral-add`.

It is a primitive write skill: one Zest collateral-add action, one transaction, proof-ready JSON output.

## Why agents need it

Agents need a standalone collateral-entry primitive before they can safely compose borrow, repay, leverage, unwind, or cross-protocol routing flows.

## Safety notes

- Mainnet only.
- This is a write skill and can move funds.
- `run` refuses to broadcast without `--confirm=DEPOSIT`.
- The skill verifies the Zest V2 market, selected asset, paired vault, current wallet balance, share conversion, pending transaction depth, signer address, and postcondition plan before broadcast.
- Transactions use `PostConditionMode.Deny`.
- FT deposits include postconditions for wallet underlying spend, Market underlying spend, and wallet vault-share movement.
- STX deposits use the wrapper's native STX transfer behavior, but the current public proof covers only sBTC.
- The skill blocks if a nonzero deposit converts to zero vault shares.
- The skill blocks unsupported live egroup masks before broadcast.
- It is not a borrow, repay, withdraw, faucet, swap, leverage loop, or HODLMM skill.

## Commands

### doctor

```bash
bun run zest-asset-deposit-primitive/zest-asset-deposit-primitive.ts doctor --wallet <stacks-address> --deposit-asset sBTC
```

### status

```bash
bun run zest-asset-deposit-primitive/zest-asset-deposit-primitive.ts status --wallet <stacks-address> --deposit-asset sBTC --amount <base-units>
```

### plan

```bash
bun run zest-asset-deposit-primitive/zest-asset-deposit-primitive.ts plan --wallet <stacks-address> --deposit-asset sBTC --amount <base-units>
```

### run

```bash
bun run zest-asset-deposit-primitive/zest-asset-deposit-primitive.ts run --wallet <stacks-address> --deposit-asset sBTC --amount <base-units> --confirm=DEPOSIT
```

Without `--confirm=DEPOSIT`, `run` blocks before signer resolution and before broadcast.

## Output contract

Every command prints exactly one JSON object to stdout.

Success:

```json
{ "status": "success", "action": "status", "data": {}, "error": null }
```

Blocked:

```json
{
  "status": "blocked",
  "action": "run",
  "data": {},
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "This write skill requires explicit confirmation.",
    "next": "Re-run with --confirm=DEPOSIT."
  }
}
```

## Known constraints

- The initial proof path uses sBTC because the proof wallet already has a Zest sBTC collateral position and that live egroup admits same-collateral top-ups.
- Supported assets in this version are limited to `STX`, `sBTC`, and `USDC` / `USDCx`. Other live Zest V2 assets such as `stSTX`, `USDH`, and `stSTXbtc` are not implemented yet and will return an unsupported-asset error.
- STX deposit support is implemented from the live wrapper path but is not yet covered by a mainnet proof transaction in this PR.
- Adding a different collateral class to an existing Zest account can be blocked by the live egroup registry. The skill checks this and blocks before broadcast.
- `price-feeds` are currently passed as `none`; same-collateral top-ups and no-debt collateral adds do not need a fresh oracle write in the verified proof path.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @macbotmini-eng
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/574
