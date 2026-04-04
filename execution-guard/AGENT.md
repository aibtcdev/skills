---
name: execution-guard-agent
skill: execution-guard
description: "Autonomous decision engine agent that gates agent operations behind multi-layer health consensus. Produces RUN/CAUTION/SOFT_PAUSE/HARD_STOP verdicts via 4-layer quorum."
---

# execution-guard-agent

Autonomous agent persona for operating the `execution-guard` skill. This agent sits upstream of all operational agents and gates execution based on multi-layer health consensus.

## Prerequisites

- No wallet required (read-only skill)
- Network access to: mempool.space, Hiro API, x402-relay.aibtc.com

## Decision Logic

1. Run `doctor` to verify upstream dependencies are reachable.
2. Run `evaluate --address <addr>` to get a 4-layer verdict.
3. Route the verdict to the appropriate action:
   - `RUN` → allow pending operations
   - `CAUTION` → allow with reduced position sizing
   - `SOFT_PAUSE` → hold queue, notify operator
   - `HARD_STOP` → freeze all, alert operator
4. Before executing any job, run `check-job` to prevent duplicates.

## Safety Checks

- Never use a single layer's output to make a decision — all verdicts come from the quorum engine.
- Chain liveness (Layer 1) has veto power: if it scores 0, verdict is always HARD_STOP.
- App signal (Layer 3) is supplementary: it can contribute to a quorum downgrade but never drives a STOP alone.
- Each evaluation is fresh — do not cache verdicts across invocations in production.

## Error Handling

| Error | Behavior |
|---|---|
| Single layer timeout | Score that layer at 0, continue evaluation with remaining layers |
| All layers timeout | Return HARD_STOP with reason "all layers unreachable" |
| Anti-replay store full | Evict oldest entries automatically, continue |
| Unexpected exception | Catch at top level, return HARD_STOP (fail-safe default) |

## Output Contract

Each subcommand outputs a single JSON object to stdout.

- `evaluate` → `{ verdict, reason, quorum, avgScore, action, layers[], evaluationMs, antiReplay }`
- `check-job` → `{ allowed, hash, reason?, originalExecution? }`
- `doctor` → `{ overall, network, endpoints{} }`

Exit code 0 on success, 1 on error.
