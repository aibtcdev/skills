---
name: jingswap-cycle-agent
skill: jingswap-cycle-agent
description: "JingSwap STX↔sBTC cycle monitor and participation agent. Evaluates whether the current JingSwap cycle offers a favourable oracle-vs-DEX arbitrage window and prepares deposit parameters for execution. Reads live contract state via Hiro API — no API key required."
---

# Agent Behavior — jingswap-cycle-agent

## Purpose
Monitor the active JingSwap cycle and execute STX deposits when the Pyth oracle settlement rate is cheaper than the live DEX rate. The oracle-DEX spread is the sole entry signal.

## Guardrails
- NEVER executes `jingswap_deposit_stx` autonomously — output `DEPOSIT_READY` and wait for parent agent confirmation
- NEVER deposits in buffer or settle phase — cycle must be in deposit phase
- NEVER proceeds if `is_favourable` is false in `analyze` output
- Always run `doctor` first — if any check fails, stop and surface the error
- Always fetch live data — never reuse stale cycle state across runs

## Spend Limits
Zero for read-only commands (`doctor`, `status`, `analyze`). For `participate`, the parent agent controls spend via `--amount-stx`. Default threshold: 1% oracle discount.

## Decision Order
1. Run `doctor` — if `result` is not `ready`, stop and report connectivity failure.
2. Run `analyze [--min-discount <pct>]` — read `action` field:
   - `PARTICIPATE` → run `participate --amount-stx <n>` to get `DEPOSIT_READY` payload, then confirm with parent before executing `jingswap_deposit_stx`
   - `MONITOR` → log spread, set retry interval (recommended: 15–30 min), do nothing
   - `WAIT_FOR_DEPOSIT_PHASE` → wait for next cycle; check again in ~1 hour
   - `NO_SBTC_AVAILABLE` → no opportunity; check again in 30 min
3. Always surface `confidence` with `action`:
   - `high` — act with full sizing
   - `medium` — reduce position size by 50%
   - `low` — skip or minimal size

## Recommended Use
- Run `analyze` on a 15–30 minute schedule during deposit phase
- Oracle discount windows are transient — the spread can open and close within hours
- Combine with `hodlmm-advisor` for a full Bitflow position picture: JingSwap handles acquisition, HODLMM handles LP positioning

## Autonomous Use
Safe to run `doctor`, `status`, and `analyze` autonomously on a schedule. `participate` without `--dry-run` should only fire after parent agent confirmation — the `DEPOSIT_READY` output is the explicit handoff point.

## Error Handling
- Hiro API failure: exit 1 with error JSON — do not attempt deposit with stale data
- Pyth API failure: exit 1 — oracle price is required for spread calculation
- Contract returns unexpected encoding: gracefully returns 0 for that price source, falls back to available source
- `get-xyk-price` returns 0: DLMM price is used as sole DEX reference (expected behaviour — XYK pool may be empty)

## JingSwap mechanics
JingSwap is a cycle-based STX↔sBTC auction on Stacks. Each cycle has three phases:
- **deposit** (open): both sides can deposit STX or sBTC
- **buffer**: deposits close, settlement price locks in
- **settle**: oracle price settles the swap, both sides receive their assets

Settlement uses the Pyth oracle rate (BTC/USD ÷ STX/USD). The arbitrage: if oracle < DEX, STX depositors acquire sBTC cheaper than buying on-market. If oracle > DEX (premium), there is no economic incentive to deposit STX — wait for the spread to invert.
