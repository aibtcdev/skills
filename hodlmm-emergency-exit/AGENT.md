---
name: hodlmm-emergency-exit-agent
skill: hodlmm-emergency-exit
description: "Risk-gated HODLMM LP withdrawal. Scores exit urgency from 5 risk triggers, emits withdrawal MCP commands behind triple-gate safety (urgency + value + confirmation)."
---

# Agent Behavior -- HODLMM Emergency Exit

## When to use

- When `hodlmm-risk` reports a `crisis` regime, run `assess` to check if positions should be exited.
- When `hodlmm-fee-harvester` shows grade D/F for a pool the agent has positions in.
- Periodically run `scan` to check all positions for deteriorating conditions.
- During sharp market moves, run `assess` on active positions to detect bin drift.

## Decision order

1. Run `doctor` to confirm APIs are reachable and review safety thresholds.
2. Run `scan --address <addr>` to find positions with elevated risk.
3. For each flagged position, run `assess --address <addr> --pool-id <id>` for detailed breakdown.
4. If urgency is `critical` or `warning`, run `exit --address <addr> --pool-id <id> --confirm` to generate the withdrawal command.
5. Execute the emitted MCP command via the `bitflow` skill.

## Refusal conditions

1. Never emit a withdrawal command without the `--confirm` flag. No accidental exits.
2. Never exit a position worth less than $0.50. Gas would exceed the position value.
3. Never exit when urgency is `safe` or `monitor` unless `--force` is explicitly provided.
4. Never withdraw more than 10 bin positions in a single exit. Larger positions require multiple calls.
5. Never set non-zero `minXAmount`/`minYAmount` during emergency exits. Slippage tolerance must be permissive to ensure the exit succeeds.
6. Never cache risk assessments across calls. Pool state changes with every block.
7. Never execute the withdrawal directly. This skill emits the MCP command; the `bitflow` skill handles execution.
8. Never expose wallet passwords, private keys, or secrets in output.

## Triple-gate safety model

The `exit` command enforces three independent safety gates. ALL must pass:

```
Gate 1: Urgency   -> assessment.urgency must be "warning" or "critical" (or --force)
Gate 2: Value      -> position.valueUsd must be >= $0.50
Gate 3: Confirm    -> --confirm flag must be present
```

If any gate fails, the command returns `status: "blocked"` with a specific error code and the gate that blocked it.

## Composability

Emergency exit workflow:

```
hodlmm-risk assess-pool        -> is the pool in crisis?
hodlmm-emergency-exit assess   -> how urgent is the exit?
hodlmm-emergency-exit exit     -> generate withdrawal command (if urgent)
bitflow withdraw-liquidity-simple -> execute the withdrawal
```

Periodic monitoring workflow:

```
hodlmm-emergency-exit scan     -> check all positions for risk
hodlmm-fee-harvester portfolio -> cross-reference with fee performance
hodlmm-emergency-exit exit     -> exit positions that are both risky AND not earning
```

## Output contract

All commands return structured JSON with `status: "success" | "error" | "blocked"`:

```json
{
  "status": "success | error | blocked",
  "action": "human-readable description of what happened or what to do next",
  "data": { "...": "command-specific fields" },
  "error": { "code": "error_code", "message": "description", "next": "suggested action" } | null
}
```

**Key status meanings:**
- `success`: Assessment complete or withdrawal command emitted
- `blocked`: Safety gate prevented the exit (code tells which gate)
- `error`: API failure or invalid input

**Key data fields:**
- `urgency`: critical / warning / monitor / safe
- `score`: 0-100 risk score
- `triggers[]`: human-readable list of active risk triggers
- `mcp_command`: the withdrawal command to pass to the bitflow skill (only present when all gates pass)
- `gates_passed`: which safety gates were satisfied

## On error

- All errors return `status: "error"` with `code`, `message`, and `next` action.
- API failures are surfaced immediately, not swallowed.
- Failed pool scans log warnings to stderr; successful pools still return results.

## On success

- Lead with the `action` field for quick agent decision-making.
- If `urgency` is `critical`, the agent should act immediately.
- If `urgency` is `warning`, the agent should consider acting.
- The `mcp_command` object is ready to be passed directly to the bitflow skill for execution.
