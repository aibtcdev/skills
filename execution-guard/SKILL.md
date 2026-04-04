---
name: execution-guard
description: "Multi-layer decision engine for Stacks agent operations. 4 independent layers (Chain Liveness, Payment Health, App Signal, Internal Sanity) vote via quorum to produce RUN/CAUTION/SOFT_PAUSE/HARD_STOP verdicts. Includes anti-replay protection."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "evaluate [--address <stx-address>] | check-job --job-id <id> --nonce <n> --timestamp <ts> | doctor"
  entry: "execution-guard/execution-guard.ts"
  mcp-tools: "check_relay_health, get_network_status, get_transaction_status"
  requires: ""
  tags: "l1, l2, read-only, infrastructure"
---

# execution-guard

Multi-layer decision engine for autonomous agent operations on Stacks. Four independent layers vote on system health via quorum — the engine compares signals, it does not trust any single source.

## Problem

Agents that rely on a single API endpoint to decide whether to operate are vulnerable to false signals. If an activity API returns zero but the blockchain is live, the agent should not stop. If the blockchain is down but the API looks healthy, the agent should stop immediately. A single-source decision creates a single point of failure.

## Solution

Four independent layers check different aspects of system health in parallel. A quorum engine aggregates their scores and produces one of four verdicts. Chain liveness holds veto power — if both Bitcoin and Stacks are unreachable, the verdict is always HARD_STOP regardless of other layers.

## Layers

| # | Layer | What it checks | Role |
|---|---|---|---|
| 1 | **Chain Liveness** | Bitcoin block height, Stacks block height, BTC-STX sync drift | Veto power — score 0 forces HARD_STOP |
| 2 | **Payment Health** | x402 relay status, sponsor nonce gaps (queried directly from Hiro), mempool desync | Standard quorum member |
| 3 | **App Signal** | Recent transaction activity for a given address | Supplementary — never drives decisions alone |
| 4 | **Internal Sanity** | Hiro API latency, memory pressure, anti-replay store health | Standard quorum member |

## Verdicts

| Verdict | Condition | Behavior |
|---|---|---|
| `RUN` | 3-4/4 layers score >= 60 | Operate normally |
| `CAUTION` | 2/4 layers healthy | Proceed with reduced exposure, avoid new large positions |
| `SOFT_PAUSE` | 1/4 layers healthy | Halt execution but preserve queue |
| `HARD_STOP` | 0/4 layers healthy OR chain dead | Freeze everything, preserve queue, wait for recovery |

## Anti-replay

Every job gets a deterministic hash from `job_id + nonce + timestamp`. Executed jobs are tracked in a rolling 24-hour window (max 1,000 entries). Duplicate hashes are rejected.

## Subcommands

### `evaluate`

Run full 4-layer evaluation. Optional `--address` enables the App Signal layer with real tx history.

```
bun run execution-guard/execution-guard.ts evaluate
bun run execution-guard/execution-guard.ts evaluate --address SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW
```

**Output**: verdict, reason, quorum, per-layer scores and signals, evaluation time, anti-replay stats.

### `check-job`

Anti-replay check. Returns `allowed: true` if the job is new, `allowed: false` with the original execution timestamp if duplicate.

```
bun run execution-guard/execution-guard.ts check-job --job-id "rebalance-001" --nonce 42 --timestamp 1711843200000
```

### `doctor`

Health check across Bitcoin, Stacks, x402 relay, and sponsor nonce state.

```
bun run execution-guard/execution-guard.ts doctor
```

## Safety

- **Read-only** — zero on-chain transactions. All checks are HTTP GET.
- **No private keys** — never requests, accepts, or stores keys.
- **No wallet required** — uses only public blockchain data.
- **Graceful degradation** — each layer fails independently with a timeout.
- **Deterministic** — same inputs produce same verdict.
