---
name: zest-yield-manager
description: Autonomous sBTC yield management on Zest Protocol — supply, withdraw, claim rewards, and monitor positions with safety controls.
metadata:
  user-invocable: "false"
  arguments: "doctor | run | install-packs"
  entry: "zest-yield-manager/zest-yield-manager.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
  author: "secret-mars"
  author-agent: "Secret Mars"
---

# Zest Yield Manager

## What it does

Manages sBTC lending positions on Zest Protocol (Stacks L2). Supplies idle sBTC to earn yield from borrowers, monitors position health, claims wSTX incentive rewards, and withdraws when needed. All operations go through Zest's audited pool-borrow contracts with Pyth oracle price feeds.

## Why agents need it

Any agent holding sBTC has idle capital losing value to opportunity cost. This skill automates the supply/withdraw/claim cycle so agents earn yield without manual intervention. It handles the Pyth oracle fee, post-conditions, and borrow-helper versioning that trip up manual callers.

## On-chain proof

Tested on Stacks mainnet with real sBTC (agent address `SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE`):

| Operation | Txid | Block | Result |
|-----------|------|-------|--------|
| Supply 1000 sats | [`8f9eed21...`](https://explorer.hiro.so/txid/8f9eed213f1cd9198e4c3e45190ac1799926b87e70a61088c4e47253c73292ac?chain=mainnet) | 7,352,592 | `(ok true)` |
| Withdraw 1000 sats | [`a61c7b59...`](https://explorer.hiro.so/txid/a61c7b59dfa543b60566832c6a4fa1d046d935e21957fd20c96329644ddb1012?chain=mainnet) | 7,352,600 | `(ok true)` |

Full round-trip verified: supply and withdraw both succeed on mainnet.

## Safety notes

- **Writes to chain.** Supply and withdraw submit Stacks transactions (cost ~50k uSTX gas + ~2 uSTX Pyth fee).
- **Moves funds.** sBTC leaves the wallet when supplied; returns on withdraw. Funds are in Zest's audited lending pool, not a custodial address.
- **Mainnet only.** Zest Protocol is deployed on Stacks mainnet.
- **Supply-only.** v1 does not implement borrowing. Borrowing is not available — there is no `--allow-borrow` flag. Future versions may add borrow support with explicit opt-in and liquidation safeguards.
- **Spend limit enforced.** Default max supply per call: 500,000 sats (`DEFAULT_MAX_SUPPLY_SATS`). Override with `--max-supply-sats`. Amounts above the limit return a `blocked` status — the skill refuses to proceed.
- **Pre-flight checks.** Before any write operation, the skill validates: (1) STX gas balance >= 100,000 uSTX, (2) sBTC balance >= requested amount, (3) amount within spend limit. If any check fails, the skill returns `blocked` with a specific error code and suggested fix.
- **No transaction simulation.** Broadcasting relies on pre-flight checks plus Zest contract-level validation. Transaction simulation (stxer dry-run) is not yet implemented.
- **Withdrawal always allowed.** No confirmation gate on withdrawing your own funds (but position size is validated).

## Commands

### doctor
Checks wallet STX balance (for gas), sBTC balance, Zest contract availability, current position, and pending rewards. Safe to run anytime — read-only.
```bash
bun run zest-yield-manager/zest-yield-manager.ts doctor
```

### run
Core execution. Accepts sub-commands:

**Check position (default, read-only):**
```bash
bun run zest-yield-manager/zest-yield-manager.ts run --action=status
```

**Supply sBTC to earn yield:**
```bash
bun run zest-yield-manager/zest-yield-manager.ts run --action=supply --amount=50000
```

**Withdraw sBTC from pool:**
```bash
bun run zest-yield-manager/zest-yield-manager.ts run --action=withdraw --amount=50000
```

**Claim wSTX incentive rewards:**
```bash
bun run zest-yield-manager/zest-yield-manager.ts run --action=claim
```

### install-packs
Checks and reports on required dependencies: `@stacks/transactions`, `@stacks/network`.
```bash
bun run zest-yield-manager/zest-yield-manager.ts install-packs --pack all
```

## Output contract

All outputs are JSON to stdout. The `status` field determines how the agent should route:

**Status check (`--action=status`):**
```json
{
  "status": "success",
  "action": "Idle sBTC detected — consider supplying with --action=supply",
  "data": {
    "position": {
      "supplied_sats": 0,
      "borrowed_sats": 0,
      "rewards_pending_ustx": 0,
      "asset": "sBTC"
    },
    "balances": {
      "sbtc_sats": 295574,
      "stx_ustx": 33405629
    }
  },
  "error": null
}
```

**Supply/withdraw/claim (`--action=supply|withdraw|claim`):**
```json
{
  "status": "success",
  "action": "Execute supply transaction via MCP zest_supply tool",
  "data": {
    "operation": "supply",
    "asset": "sBTC",
    "amount_sats": 1000,
    "mcp_command": {
      "tool": "zest_supply",
      "params": { "asset": "sBTC", "amount": "1000" }
    },
    "pre_checks_passed": {
      "gas_sufficient": true,
      "balance_sufficient": true,
      "within_spend_limit": true
    }
  },
  "error": null
}
```

**Blocked (safety check failed):**
```json
{
  "status": "blocked",
  "action": "Reduce amount or set --max-supply-sats=600000 to override",
  "data": {},
  "error": {
    "code": "exceeds_limit",
    "message": "Requested 600000 sats exceeds max supply limit of 500000 sats",
    "next": "Reduce amount or set --max-supply-sats=600000 to override"
  }
}
```

**Key fields:**
- `rewards_pending_ustx` (number) — wSTX incentive rewards in microSTX. Check `> 0` to decide whether to claim.
- `mcp_command` — the exact MCP tool call and parameters for the agent framework to execute.
- `pre_checks_passed` — which safety gates passed before generating the transaction payload.

## Known constraints

- Requires STX for gas (~50,000 uSTX per transaction). Doctor command checks this.
- Pyth oracle must be reachable (Zest uses it for price feeds). Rare outages possible.
- Zest uses borrow-helper-v2-1-7 on mainnet. Older versions will fail.
- Withdrawal may fail if pool utilization is 100% (all supplied funds are borrowed). Retry later.
- wSTX reward claims return 0 if no rewards have accrued since last claim.
- v1 is supply-only. Borrowing is not implemented and there is no flag to enable it.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition Day 1.
Original author: @secret-mars
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/11
