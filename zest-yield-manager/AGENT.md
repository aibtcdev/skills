---
name: zest-yield-manager-agent
skill: zest-yield-manager
description: "Autonomous sBTC yield management on Zest Protocol — supply, withdraw, claim rewards, and monitor positions with safety controls."
---

# Agent Behavior — Zest Yield Manager

## Decision order

1. Run `doctor` first. If wallet has < 100k uSTX, surface "insufficient gas" blocker. If sBTC balance is 0 and no position exists, surface "no sBTC to manage" blocker.
2. Run `run --action=status` to check current position.
3. Decide based on position + wallet state:
   - If idle sBTC > reserve threshold and position is small → `supply`
   - If rewards pending → `claim` first, then consider re-supplying the rewards
   - If agent needs liquid sBTC for another operation → `withdraw` the needed amount
   - If position healthy and no action needed → report status and move on
4. Parse JSON output and route on `status` field.

## Guardrails

- **Never supply more than `--max-supply-sats` (default 500,000) in a single call.** Split larger amounts across cycles.
- **v1 is supply-only.** Borrowing is not implemented. Future versions may add borrow support with explicit opt-in and liquidation safeguards.
- **Never proceed past a `blocked` status** without explicit user confirmation.
- **Never expose secrets or private keys** in args or logs.
- **Always check gas balance** before write operations. Minimum 100,000 uSTX recommended.
- **Pre-flight checks validate gas balance, sBTC balance, and spend limits** before generating the transaction payload. Transaction simulation is not yet implemented — broadcasting relies on these pre-checks plus Zest contract-level validation.
- **Respect the reserve.** Agent should keep a liquid sBTC reserve for operational costs (messages, fees). Only supply the excess.

## Capital allocation strategy

Recommended pattern for autonomous agents:
- **Liquid reserve:** ~200k sats sBTC (for operational costs: messages, trades, fees)
- **Yield position:** everything above the reserve → supply to Zest
- **Revenue funnel:** any sBTC earned (bounties, services, trades) → supply to Zest immediately
- **Claim frequency:** every 10-20 cycles (or when rewards > 1000 uSTX)

## Output contract

Return structured JSON every time. No ambiguous success states.

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {},
  "error": { "code": "", "message": "", "next": "" }
}
```

## On error

- If `insufficient_gas`: agent should acquire STX before retrying
- If `pool_utilization_full`: withdrawal temporarily blocked — retry next cycle
- If `oracle_unavailable`: Pyth outage — skip yield operations this cycle
- If `spend_limit_exceeded`: amount exceeds max-supply-sats — reduce amount or override limit
- Do not retry silently. Surface to user with the `action` field guidance.

## On success

- Confirm the on-chain result (tx hash)
- Update position tracking state
- Log the action: "Supplied X sats to Zest" / "Withdrew X sats" / "Claimed Y uSTX rewards"
- If supply succeeded, update agent's yield tracking metrics
