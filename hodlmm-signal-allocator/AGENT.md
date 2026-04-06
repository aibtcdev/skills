---
name: hodlmm-signal-allocator-agent
skill: hodlmm-signal-allocator
description: "Signal-gated HODLMM allocator agent. Uses aibtc.news intelligence and Quantum Readiness Index to decide when and how much to allocate to HODLMM positions via Bitflow swap. Never executes without explicit confirmation."
---

## Decision order

Execute steps in sequence. Do not skip or reorder.

1. Run `doctor` — if any check is `"down"`, halt and surface the failing dependency. If `"degraded"`, proceed with warning logged.
2. Run `scan --pool dlmm_1 --wallet <address>` — inspect all gate results before proceeding.
3. Check `gates.signal_ok === true` — if false, output BLOCKED and wait. Do not retry within the same hour.
4. Check `gates.quantum_ok === true` — if false, output BLOCKED. Quantum risk is elevated; re-evaluate when Readiness Index updates.
5. Check `gates.cooldown_ok === true` — if false, output the `next_eligible_at` timestamp.
6. Run `run --pool dlmm_1 --wallet <address> --amount-stx <n> --dry-run` — review simulation output, verify `price_impact_pct ≤ 1.5` and `amount_out_sbtc_estimated` is reasonable.
7. Run `run --pool dlmm_1 --wallet <address> --amount-stx <n> --confirm` — only after dry-run reviewed and approved.

## Guardrails

All of the following are enforced in code, not just documentation:

- **Signal gate**: `signal_score < 60` → `status: "blocked"` with code `LOW_SIGNAL_SCORE`. No override.
- **Quantum gate**: `quantum_risk_factor > 0.15` → `status: "blocked"` with code `QUANTUM_RISK_HIGH`. Readiness Index must be ≥ 25 before long-duration HODLMM allocation proceeds.
- **Spend cap**: `--amount-stx > 500` → `status: "blocked"` with code `EXCEEDS_CAP`. Hard limit, not configurable.
- **Reserve gate**: `wallet_stx - amount_stx < 10` → `status: "blocked"` with code `INSUFFICIENT_RESERVE`. Always maintain 10 STX for gas.
- **Price impact gate**: Bitflow quote `price_impact_pct > 1.5` → `status: "blocked"` with code `PRICE_IMPACT_HIGH`.
- **Confirm gate**: Without `--confirm`, `run` always returns `status: "blocked"` with code `CONFIRM_REQUIRED` plus full simulation.
- **Cooldown**: Less than 6 hours since last execution → `status: "blocked"` with code `COOLDOWN_ACTIVE` and `next_eligible_at` timestamp.
- **Amount scaling**: If `signal_score` is 60–79 (moderate confidence), the actual swap amount is halved. If ≥ 80, full amount is used.

## Signal → action mapping

| Condition | Recommendation | Action eligible |
|---|---|---|
| `signal_score ≥ 80`, `quantum_risk_factor ≤ 0.10` | `ALLOCATE` — full amount | Yes, with `--confirm` |
| `signal_score 60–79`, `quantum_risk_factor ≤ 0.10` | `ALLOCATE` — half amount | Yes, amount scaled to 50% |
| `signal_score ≥ 60`, `quantum_risk_factor 0.10–0.15` | `HOLD` — marginal conditions | No — run again after next signal |
| `signal_score < 60` | `WAIT_FOR_SIGNAL` | No — insufficient intelligence |
| `quantum_risk_factor > 0.15` | `QUANTUM_RISK_HIGH` | No — pause long-duration allocation |
| `price_impact_pct > 1.5%` | `WAIT_FOR_LIQUIDITY` | No — spread too wide |
| cooldown active | `COOLDOWN_ACTIVE` | No — wait until `next_eligible_at` |

## On error

- Log full error payload (code + message + next) to stderr
- Do not retry silently — surface to agent with which gate failed
- For `BITFLOW_API_DOWN`: wait 5 minutes, re-run `doctor` before any retry
- For `BROADCAST_FAILED`: check Hiro mempool for pending txs before retry — do not double-spend
- For `WALLET_DECRYPT_FAILED`: halt, do not retry with different passwords

## On success

Output includes `txId`, `explorerUrl`, `next_eligible_at`, and `signal_basis` (array of signal IDs that informed the decision). Log this to persistent state file. Pass `explorerUrl` to downstream reporting skill.

## Integration chain

```
aibtc.news (signal feed)
    ↓ signal_score
hodlmm-signal-allocator scan
    ↓ gates pass
hodlmm-signal-allocator run --dry-run
    ↓ review
hodlmm-signal-allocator run --confirm
    ↓ txId
hodlmm-bin-guardian (monitor resulting position)
    ↓ out-of-range signal
hodlmm-pulse (fee velocity tracking)
```
