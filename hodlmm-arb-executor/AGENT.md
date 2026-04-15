---
name: hodlmm-arb-executor-agent
skill: hodlmm-arb-executor
description: "Executes the HODLMM Arb execution pipeline. Enforces strict safety caps, checks state, and generates the required sequence of MCP swap/liquidity commands to capture yields."
---

# Agent Behavior — HODLMM Arb Executor

## Decision order

1. Call `doctor` to verify Pyth, Hiro, and Bitflow APIs are reachable and the STX gas balance is sufficient.
2. If `doctor` fails, **abort the execution workflow immediately**. Do not proceed with simulated or live execution.
3. Call `simulate` to perform a dry-run and receive the theoretical MCP commands along with estimated capability/P&L.
4. Review the simulated output. If the spread is profitable and the `wouldExecute` flag is `true`, request user confirmation to proceed.
5. If the user confirms or the agent is explicitly authorized to execute autonomously within pre-defined boundaries, run `execute --confirm` to generate the live MCP commands.
6. Consume the output from the `execute` command and pipe the generated payload objects directly into the specified AIBTC MCP tools.

## Guardrails

- **Enforce the Spend Cap:** The skill has a hardcoded `100_000` sat limit. Never attempt to manually override or construct custom bounds exceeding this limit.
- **Require Confirmation:** Never emit `--confirm` during the initial scan/dry-run unless the environment requires a fully autonomous pipeline.
- **Fail-Safe Processing:** If the result contains an `error` key, halt immediately and relay the descriptive error to the user or logs.
- **Do Not Retry on API Failures:** If DLMM is down or Pyth is unreachable, the operation safely degenerates or skips. Respect this fallback behavior and do not brute-force the script.

## Output contract

All commands return structured JSON to stdout.

**doctor:**
```json
{
  "network": "mainnet",
  "status": "ok | error",
  "checks": [
    { "name": "pyth_hermes", "status": "ok | error", "detail": "..." },
    { "name": "hiro_xyk_pool", "status": "ok | error", "detail": "..." },
    { "name": "bitflow_hodlmm", "status": "ok | error", "detail": "..." },
    { "name": "cooldown", "status": "ok | warn", "detail": "ready | COOLING DOWN — Nm remaining" },
    { "name": "open_position", "status": "ok | warn", "detail": "No open LP position | Open LP: N sats | held Nm" }
  ],
  "maxAutonomousSats": 100000
}
```

**execute:**
```json
{
  "status": "ENTRY_COMMANDS_EMITTED | EXIT_COMMANDS_EMITTED | HOLDING | SKIPPED | CONFIRM_REQUIRED | PREFLIGHT_FAILED",
  "commands": [
    {
      "tool": "bitflow_swap | bitflow_hodlmm_add_liquidity | bitflow_hodlmm_withdraw_liquidity",
      "args": {},
      "description": "human-readable description",
      "postConditions": ["FT debit ... eq ...", "FT credit ... gte ..."]
    }
  ],
  "spread": { "grossSpreadPct": 0, "netSpreadPct": 0, "profitable": false, "confidenceBuffer": 0 },
  "satsCapped": 100000,
  "openPosition": null
}
```

## On error

- `"status": "PREFLIGHT_FAILED"` — Data source unreachable. Check network. Retry after 60s.
- `"status": "CONFIRM_REQUIRED"` — Add `--confirm` flag. Expected behavior, not an error.
- `"status": "SKIPPED", "reason": "COOLDOWN_ACTIVE"` — Wait `cooldownRemainingMinutes` before retrying.
- `"status": "SKIPPED", "reason": "DLMM_UNAVAILABLE"` — Bitflow API down. Monitor with `watch`.
- `"status": "SKIPPED", "reason": "SPREAD_NOT_PROFITABLE"` — Within oracle confidence noise. Normal.
- `"error": "API error 429"` — Rate limited. Wait 60s.

## On success

- After `ENTRY_COMMANDS_EMITTED`: execute the `commands` array via MCP tools in sequence. Monitor with `watch` for exit signal.
- After `EXIT_COMMANDS_EMITTED`: execute exit commands. Position cleared from state. Cycle complete.
- Log `spread.grossSpreadPct`, `spread.netSpreadPct`, and `satsCapped` for each cycle.
