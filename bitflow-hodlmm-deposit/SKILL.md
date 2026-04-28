---
name: bitflow-hodlmm-deposit
description: "HODLMM-Primitive. Deposits selected assets into Bitflow HODLMM bins with proof-ready guardrails."
metadata:
  author: "macbotmini-eng"
  author-agent: "Hex Stallion"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "bitflow-hodlmm-deposit/bitflow-hodlmm-deposit.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, infrastructure, l2"
---

# Bitflow HODLMM Deposit

## What it does

`bitflow-hodlmm-deposit` deposits wallet assets into selected Bitflow HODLMM bins on Stacks mainnet. It is a primitive write skill: one action, one HODLMM add-liquidity transaction, and proof-ready JSON output.

The skill is pool-agnostic across Bitflow HODLMM pools that satisfy the expected liquidity-router, token, `pool-token`, and `pool-token-id` interface.

Selected bins may already have wallet LP position state or may be first-time wallet position targets. The bin itself must exist in the protocol pool; the skill does not create protocol bins. It supports first-time deposits into valid selected bins and only uses existing wallet position state to adjust the postcondition plan.

## Why agents need it

Agents need a reliable HODLMM entry primitive before they can build full economic loops such as Zest-to-HODLMM routing or HODLMM range deployment. Without this primitive, a router can identify that capital should enter HODLMM, but it cannot safely execute the HODLMM deposit leg.

## Safety notes

- This is a write skill and can move funds.
- It deposits wallet token balances into HODLMM liquidity bins on mainnet.
- It requires explicit `--confirm=DEPOSIT` before broadcast.
- It blocks unsupported pool/router/token interfaces before broadcast.
- It validates one-sided and two-sided deposit rules for the selected bins.
- It supports both topping up existing wallet bin positions and initializing wallet position state in valid selected protocol bins.
- It uses active-bin tolerance, minimum DLP protection, liquidity-fee bounds, balance checks, pending-transaction checks, and deny-mode postconditions where expressible.
- It is not a withdrawal, recentering, DCA, keeper order, swap, APY router, or cross-protocol workflow.

## Commands

### doctor

Checks environment, selected pool readiness, router interface, token contracts, token balances, STX gas reserve, and pending transaction depth. Safe to run anytime.

```bash
bun run bitflow-hodlmm-deposit/bitflow-hodlmm-deposit.ts doctor --wallet <stacks-address> --pool-id <pool-id>
```

### status

Builds a read-only deposit preview. It reports selected bins, active-bin offsets, token amounts, minimum DLP, fee bounds, wallet balance requirements, active-bin tolerance, and postcondition plan.

```bash
bun run bitflow-hodlmm-deposit/bitflow-hodlmm-deposit.ts status --wallet <stacks-address> --pool-id <pool-id> --amount-x <amount> --amount-y <amount>
```

Useful selection options:

```bash
bun run bitflow-hodlmm-deposit/bitflow-hodlmm-deposit.ts status --wallet <stacks-address> --pool-id <pool-id> --offsets -1,0,1 --amount-x <amount> --amount-y <amount>
bun run bitflow-hodlmm-deposit/bitflow-hodlmm-deposit.ts status --wallet <stacks-address> --pool-id <pool-id> --range -2:2 --amount-x <amount> --amount-y <amount>
bun run bitflow-hodlmm-deposit/bitflow-hodlmm-deposit.ts status --wallet <stacks-address> --pool-id <pool-id> --plan-json '[{"offset":0,"xAmount":"1000","yAmount":"1000"}]'
```

### run

Rechecks all live state, builds the HODLMM add-liquidity transaction, broadcasts only after explicit confirmation, and returns proof JSON.

```bash
bun run bitflow-hodlmm-deposit/bitflow-hodlmm-deposit.ts run --wallet <stacks-address> --pool-id <pool-id> --amount-x <amount> --amount-y <amount> --confirm=DEPOSIT
```

Without `--confirm=DEPOSIT`, `run` refuses before broadcast.

## Agent selection surface

The skill exposes the same kind of strategy surface as the withdrawal primitive, with deposit-specific amount controls.

| Option | Required | Purpose |
|---|---:|---|
| `--wallet <stacks-address>` | Yes | Wallet that owns the tokens and signs the write. |
| `--pool-id <pool-id>` | Yes | HODLMM pool to inspect and deposit into. |
| `--amount-x <amount>` | Conditional | Token X amount to deposit in base units. |
| `--amount-y <amount>` | Conditional | Token Y amount to deposit in base units. |
| `--bin-id <id>` | No | Deposit into one absolute bin. |
| `--bin-ids <ids>` | No | Deposit into a comma-separated selected set of bins. |
| `--offsets <offsets>` | No | Deposit into active-bin-relative offsets. |
| `--range <start:end>` | No | Deposit across an active-bin-relative range. |
| `--distribution <mode>` | No | `equal` or `explicit`. |
| `--plan-json <json>` | No | Explicit per-bin amounts for advanced agent composition. |
| `--slippage-bps <bps>` | No | Minimum DLP and fee-bound tolerance. |
| `--active-bin-max-deviation <bins>` | No | Abort if active bin drifts too far before broadcast. |
| `--min-gas-reserve-ustx <uSTX>` | No | Minimum STX reserve to preserve after deposit and fee. |
| `--confirm DEPOSIT` | Run only | Explicit write confirmation. |
| `--wait-seconds <seconds>` | No | Inclusion/status wait window. |

Exactly one selector may be used at a time: `--plan-json`, `--bin-id`, `--bin-ids`, `--offsets`, or `--range`. If no selector is provided, the default is the current active bin. At least one nonzero token amount is required through `--amount-x`, `--amount-y`, or `--plan-json`.

## Output contract

All outputs are JSON to stdout.

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

Fatal error:

```json
{ "error": "descriptive message" }
```

## Known constraints

- Mainnet only.
- The selected pool must be a live Bitflow HODLMM pool with the shared `dlmm-liquidity-router-v-1-1` interface.
- The proof path targets `add-relative-liquidity-same-multi`.
- The default plan deposits into the current active bin if no bin selector is provided.
- The default active-bin deviation is `0`, meaning broadcast uses an exact active-bin match unless `--active-bin-max-deviation` is increased.
- Below-active bins accept only token Y; above-active bins accept only token X; active-bin deposits may be one-sided or two-sided.
- The skill prefers active/restored AIBTC wallet sessions before fallback signer inputs. A locked wallet returns JSON guidance rather than prompting interactively.
- Nonce serialization across multiple write legs belongs in a composed skill or workflow guide, not inside this primitive.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @macbotmini-eng
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/556
