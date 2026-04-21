---
name: contract-preflight
description: "Dry-run Stacks contract calls against mainnet state before broadcasting — catches errors, prevents wasted gas"
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "false"
  arguments: "doctor | run --action=simulate | run --action=batch | install-packs"
  entry: "contract-preflight/contract-preflight.ts"
  requires: ""
  tags: "read-only, l2"
---

# Contract Pre-Flight

Dry-run any Stacks contract call against live mainnet state without broadcasting. Uses stxer's simulation engine to evaluate Clarity expressions, decode results, and give a clear pass/fail verdict. If the simulation returns `(err ...)` or a runtime error, the skill blocks broadcast and explains why.

## What it does

Before you broadcast a contract call, this skill creates a simulation session, runs your Clarity expression against the current chain state, and tells you whether it would succeed or fail. No gas spent. No on-chain state changed. Just a verdict: safe to broadcast, or not.

## Why agents need it

On-chain transaction failures cost gas and abort visibly. An agent that broadcasts a Zest supply with insufficient balance, a token transfer to a wrong principal, or a DAO proposal with expired parameters wastes STX on a transaction that was always going to fail. This skill eliminates that category of error entirely.

Secret Mars runs this check before every contract call across 1900+ cycles of autonomous operation. Zero aborted transactions since adopting the pattern.

## Commands

### `doctor`
Pre-flight checks: stxer API reachability, simulation session creation, runtime detection.

```bash
bun run contract-preflight/contract-preflight.ts doctor
```

### `run --action=simulate`
Simulate a single contract call. Returns decoded Clarity result and broadcast recommendation.

```bash
bun run contract-preflight/contract-preflight.ts run \
  --action=simulate \
  --sender SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE \
  --contract SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0 \
  --expression '(contract-call? .zsbtc-v2-0 get-balance tx-sender)'
```

### `run --action=batch`
Simulate a sequence of contract calls in a single session. State carries across steps — useful for multi-step DeFi operations where step 2 depends on step 1.

```bash
bun run contract-preflight/contract-preflight.ts run \
  --action=batch \
  --sender SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE \
  --steps '[
    {"contract":"SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0","expression":"(contract-call? .zsbtc-v2-0 get-balance tx-sender)"},
    {"contract":"SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token","expression":"(contract-call? .sbtc-token get-balance tx-sender)"}
  ]'
```

### `install-packs`
No additional packages required. Uses `fetch()` and `commander`.

## Safety notes

- **Read-only by design.** This skill never broadcasts. It simulates only.
- **Session isolation.** Each simulation runs in a fresh stxer session. No cross-contamination between runs.
- **Expression length limit.** Capped at 2,000 characters to prevent abuse.
- **Step limit.** Maximum 20 steps per batch to prevent runaway simulations.
- **Timeout.** 15-second timeout per API call. Fails cleanly on timeout.
- **No private keys needed.** Simulation uses sender address, not signing keys.
- **Honest verdict.** If the Clarity expression returns `(err ...)`, the skill reports it as unsafe. No sugar-coating.

## Output contract

### Simulate (single call)
```json
{
  "status": "success | error",
  "action": "simulate",
  "data": {
    "session_id": "d1c27b645459c702feae3a7a637a4777",
    "result": {
      "outcome": "ok",
      "decoded": "(ok uint 276016)",
      "raw_hex": "070100000000000000000000000000043630",
      "safe_to_broadcast": true
    },
    "recommendation": "Simulation passed. Safe to broadcast this contract call."
  },
  "error": null
}
```

### Batch (multi-step)
```json
{
  "status": "success | error",
  "action": "batch",
  "data": {
    "session_id": "abc123",
    "total_steps": 2,
    "passed": 2,
    "failed": 0,
    "results": [
      {"step": 0, "outcome": "ok", "decoded": "(ok uint 276016)", "safe": true},
      {"step": 1, "outcome": "ok", "decoded": "(ok uint 204206)", "safe": true}
    ],
    "recommendation": "All steps passed. Safe to broadcast the transaction sequence."
  },
  "error": null
}
```

## Simulation Proof

These simulations were run on mainnet state (2026-04-10) without broadcasting:

| Test | Session | Expression | Result | Verdict |
|------|---------|-----------|--------|---------|
| Balance read | d1c27b645459c702feae3a7a637a4777 | `get-balance tx-sender` on zsbtc-v2-0 | `(ok uint 276016)` | Safe |
| Impossible transfer | (second session) | `transfer u99999999` on sbtc-token | `(err uint 1)` | Blocked |

The impossible transfer would have aborted on-chain and wasted gas. The simulation caught it for free.

## Architecture

```
[Agent wants to call contract]
        ↓
[contract-preflight simulate]
        ↓
[Create stxer session] → [Eval Clarity expression against mainnet state]
        ↓                           ↓
    [Ok result]               [Err result]
        ↓                           ↓
"Safe to broadcast"         "DO NOT broadcast"
```

## Use cases

- **DeFi operations:** Verify Zest supply/withdraw, Bitflow swaps, ALEX trades before broadcast.
- **Token transfers:** Confirm balance sufficient and recipient valid before sending.
- **DAO governance:** Check proposal parameters are valid before submission.
- **Multi-step sequences:** Simulate approve → transfer → supply chains in one session.
- **Debugging:** When a contract call fails, replay it in simulation to see the exact Clarity error.

## Limitations

- Simulates against current block state. Cannot predict future state changes (MEV, concurrent txs).
- Stxer API is a third-party service. If it's down, the skill reports the outage but cannot simulate.
- Complex contract interactions with side effects are simulated correctly within one session, but cross-session state does not persist.
- Does not validate post-conditions — only the Clarity return value.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @secret-mars
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/258
