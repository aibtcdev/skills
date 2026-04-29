---
name: zest-borrow-asset-primitive
description: "Borrows a selected asset from Zest against existing collateral with explicit confirmation and proof-ready safety checks."
metadata:
  author: "macbotmini-eng"
  author-agent: "Hex Stallion"
  user-invocable: "false"
  arguments: "doctor | status | plan | run"
  entry: "zest-borrow-asset-primitive/zest-borrow-asset-primitive.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, infrastructure, l2"
---

# Zest Borrow Asset Primitive

## What it does

`zest-borrow-asset-primitive` borrows a selected Zest V2-supported asset against an existing V2 collateral position on Stacks mainnet. It is a primitive write skill: one operator-selected amount, one Zest V2 borrow transaction, and proof-ready JSON output.

The skill is market-aware but not strategy-specific: callers choose `--collateral-asset`, `--borrow-asset`, and `--amount`, and the skill validates those choices against the live Zest registry before planning or broadcasting. It does not supply collateral, swap borrowed assets, run a leverage loop, repay debt, or unwind a position.

## Why agents need it

Leveraged sBTC workflows need a proven borrow leg before any controller can safely compose borrow, swap, and re-supply steps. This skill isolates the debt-creating action so it can be reviewed, proved, and reused without hiding borrow risk inside a larger strategy.

## Safety notes

- This is a write skill and can create debt.
- It requires existing Zest collateral before borrowing.
- It requires explicit `--confirm=BORROW` before broadcast.
- It verifies the configured Zest V2 market, vault, assets, and egroup contracts before a write.
- It reads selected asset, LP token, oracle, reserve, collateral, debt, gas, and pending transaction state before planning or running.
- It uses `PostConditionMode.Deny` with an asset transfer postcondition for the borrowed asset where expressible.
- For non-STX borrowed assets, the postcondition uses the SIP-010 asset name, not the contract name.
- It calls `v0-4-market.borrow` directly; legacy helper contracts are not the submission target.
- It treats `borrow-helper-v2-1-7` and `borrow-helper-v2-1-5` as legacy/non-target paths for this V2 primitive.
- It blocks when the sender has pending STX transactions.
- It checks the signer address against `--wallet`.
- It resolves the existing AIBTC wallet/runtime first and does not create or import a wallet.
- It does not hardcode proof wallets, amounts, or proof-only signer behavior.

## Commands

### doctor

Checks live Zest contract/interface readiness, wallet gas, pending transaction depth, and selected asset support. If asset flags are omitted, `doctor` uses a baseline supported-asset pair only for dependency readiness; that default pass does not prove readiness for every supported asset pair.

```bash
bun run zest-borrow-asset-primitive/zest-borrow-asset-primitive.ts doctor --wallet <stacks-address>
```

If `doctor` returns `UNSUPPORTED_*` for any dependency, stop. Re-verify the Zest contract identifier against live protocol sources or Hiro before planning a borrow.

### status

Reads current collateral/debt state for the selected collateral and borrow assets.
Requires explicit `--collateral-asset` and `--borrow-asset`; strategy commands do not infer the market from defaults.

```bash
bun run zest-borrow-asset-primitive/zest-borrow-asset-primitive.ts status --wallet <stacks-address> --collateral-asset sBTC --borrow-asset STX
```

### plan

Builds a read-only borrow preview, including contract arguments, postcondition plan, pending depth, current position data, and proof obligations.
Requires explicit `--collateral-asset`, `--borrow-asset`, and `--amount`.

```bash
bun run zest-borrow-asset-primitive/zest-borrow-asset-primitive.ts plan --wallet <stacks-address> --collateral-asset sBTC --borrow-asset STX --amount <base-units>
```

`--amount` is always in base units for the selected borrow asset. `STX` is accepted as an operator-facing alias for Zest `wSTX`, and other supported assets use their live registry token, asset name, LP token, oracle, and decimals.

### run

Rechecks live state, resolves a signer, broadcasts only after explicit confirmation, and returns proof JSON.
Requires explicit `--collateral-asset`, `--borrow-asset`, `--amount`, and `--confirm=BORROW`.

```bash
bun run zest-borrow-asset-primitive/zest-borrow-asset-primitive.ts run --wallet <stacks-address> --collateral-asset sBTC --borrow-asset STX --amount <base-units> --confirm=BORROW
```

Without `--confirm=BORROW`, `run` refuses before signer resolution or transaction construction.

## Output contract

All commands print one JSON object to stdout with this envelope:

```json
{ "status": "success|blocked|error", "action": "doctor|status|plan|run", "data": {}, "error": null }
```

Success:

```json
{ "status": "success", "action": "plan", "data": {}, "error": null }
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
    "next": "Re-run with --confirm=BORROW."
  }
}
```

Error:

```json
{ "status": "error", "action": "run", "data": {}, "error": { "code": "ERROR", "message": "...", "next": "Inspect the error and rerun doctor." } }
```

## Known constraints

- Mainnet only.
- The first proof collateral path is sBTC collateral and the first proof borrow path is STX, but both are selected through runtime CLI inputs.
- `STX` is treated as the Zest wrapped STX asset (`wSTX`) for the borrow contract.
- This skill only borrows; it does not enable collateral, supply collateral, swap, repay, or rebalance.
- The verified V2 borrow target is `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market.borrow`.
- The V2 borrow ABI is positional: `ft`, `amount`, `receiver`, `price-feeds`; `receiver` must be an optional principal such as `(some --wallet)`.
- Zest's exact global health calculation is enforced inside the V2 market borrow path. The skill reads public Zest state and refuses obvious unsafe setups, but PR proof must include successful on-chain execution and post-borrow status showing updated debt before any leverage controller can depend on it.
- `scaledDebt` is index-scaled principal, not the exact repayment amount. Status output includes debt-index fields and estimated current debt when the borrow vault exposes them.
- Some Zest V2 assets intentionally share a base oracle feed and apply a Market callcode transform. Status output includes the live registry oracle tuple so downstream controllers can see the feed id and callcode used by the selected collateral and borrow assets.
- Single-borrow nonce safety is in scope: the skill blocks when the sender already has pending STX transactions. Standalone/cross-skill nonce serialization belongs in the existing nonce runtime primitives and later composed controllers.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @macbotmini-eng
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/572
