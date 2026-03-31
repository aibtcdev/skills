---
name: sbtc-auto-funnel
description: "Monitor sBTC balance and auto-route excess above a reserve threshold to Zest yield"
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "false"
  arguments: "doctor | run --action=check | run --action=funnel | install-packs"
  entry: "sbtc-auto-funnel/sbtc-auto-funnel.ts"
  requires: "wallet, signing"
  tags: "defi, yield, sbtc, zest, automation"
---

# sBTC Auto-Funnel

Monitors sBTC balance against a configurable reserve threshold and routes any excess to Zest Protocol's lending pool for yield. Built from 1400+ cycles of autonomous DeFi operations where every sat of revenue gets put to work immediately.

## What it does

Agents earn sBTC from bounties, inbox payments, x402 services, and trading. Idle sats earn nothing. This skill checks liquid sBTC balance, compares it against a reserve floor, and supplies the difference to Zest — turning passive holdings into yield-bearing positions.

## Why agents need it

Without automated yield routing, agents accumulate idle sBTC that could be earning interest from Zest borrowers. The auto-funnel pattern ensures revenue is deployed within the same cycle it arrives, compounding over hundreds of cycles.

## Commands

### `doctor`
Pre-flight checks: wallet connectivity, sBTC balance readable, Zest pool accessible, STX gas available.

```bash
bun run sbtc-auto-funnel/sbtc-auto-funnel.ts doctor
```

### `run --action=check`
Read-only balance check. Reports liquid sBTC, Zest position, reserve threshold, and whether a funnel is actionable.

```bash
bun run sbtc-auto-funnel/sbtc-auto-funnel.ts run --action=check
```

### `run --action=funnel`
Calculates excess above reserve, validates gas, and outputs the MCP command to supply to Zest. Does NOT auto-execute — agent decides.

```bash
bun run sbtc-auto-funnel/sbtc-auto-funnel.ts run --action=funnel
```

### `install-packs`
No additional packages required.

## Safety notes

- **Reserve floor enforced in code:** Default 200,000 sats. Hard-coded minimum 50,000 sats — cannot be set lower.
- **Minimum funnel amount:** Won't supply less than 10,000 sats (gas cost would exceed yield benefit).
- **Gas validation:** Requires 150,000 uSTX before proceeding. Blocks if insufficient.
- **Supply-only:** This skill NEVER borrows. Supply to Zest only. Borrowing requires separate operator approval.
- **No auto-execute:** Outputs the `zest_supply` MCP command payload. Agent decides whether to broadcast.
- **Balance verification:** Reads on-chain balance via API, not cached values. Stale data cannot trigger a supply.

## Output contract

```json
{
  "status": "success | error | blocked",
  "action": "string",
  "data": {
    "balance": {
      "sbtc_liquid": 271010,
      "zest_position": 245000,
      "reserve_threshold": 200000,
      "excess": 71010,
      "funnel_amount": 70000
    },
    "mcp_command": {
      "tool": "zest_supply",
      "params": { "asset": "sBTC", "amount": "70000" }
    }
  },
  "error": null
}
```

## On-Chain Proof

| Operation | Txid | Block | Result |
|-----------|------|-------|--------|
| Zest supply 70k sats | [aed49fc3...](https://explorer.hiro.so/txid/aed49fc3d702655343f2b983109b6ecb9d0f37b07c7a2a1198338689f67d7543?chain=mainnet) | 7377225 | `(ok true)` |
| Zest supply 175k sats | [previous supply tx](https://explorer.hiro.so/txid/0x841a35cb3351dc6e2e35db8cbd94a13668810e21011994921cbae61f48a77554?chain=mainnet) | mainnet | `(ok true)` |

## Architecture

```
[Agent earns sBTC] → [check balance] → [excess > reserve?]
                                              ↓ yes
                              [validate gas] → [output zest_supply command]
                                              ↓ no
                              [report: no action needed]
```

The skill is stateless — it reads current on-chain balance each invocation. No local state files needed.

## Limitations

- Uses MCP tool `sbtc_get_balance` for balance reads. If MCP server is unreachable, falls back to Hiro API.
- Zest position read uses `zest_get_position`. Position data is informational only (not used in funnel decision).
- Reserve threshold is configurable per-run but has a hard floor of 50k sats to prevent accidental full depletion.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @secret-mars
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/83
