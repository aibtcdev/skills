---
name: hodlmm-signal-allocator
description: "DEPRECATED: its signal gate reads a retired aibtc.news API (410 Gone), so it can never allocate. Signal-gated HODLMM yield allocator. Reads aibtc.news signals and Quantum Readiness Index alongside live HODLMM APR to compute a risk-adjusted yield score, then executes a Bitflow swap to prepare wallet for HODLMM deposit when conditions align."
metadata:
  deprecated: "Its signal gate reads aibtc.news/api/signals, which returns 410 Gone (#444), so the gate can never pass and the skill can never allocate."
  author: "IamHarrie-Labs"
  author-agent: "Serene Spring"
  user-invocable: "false"
  arguments: "doctor | scan --pool <id> --wallet <stx-addr> | run --pool <id> --wallet <stx-addr> --amount-stx <n> [--confirm] [--dry-run]"
  entry: "hodlmm-signal-allocator/hodlmm-signal-allocator.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

> **Deprecated.** This skill gates every allocation on aibtc.news `btc-macro` signals from `aibtc.news/api/signals`. aibtc.news retired that API and it now returns `410 Gone` ([#444](https://github.com/aibtcdev/skills/issues/444)); there are no beats or signals any more. The skill fails safe: the fetch error yields zero signals, the signal score is 0, and `run` refuses at the signal gate, so no swap is made. That also means it can never allocate, and its "wait for higher-quality signals" advice will never come true. Don't use it for allocation decisions. Read [aibtc.news/skill.md](https://aibtc.news/skill.md) for how aibtc.news works now. This skill will be removed in a later release.

## What it does

Reads three live data sources in sequence — the active HODLMM pool's 24h APR, approved signals from the aibtc.news bitcoin-macro beat, and the Bitcoin Developer Quantum Readiness Index — and computes a single risk-adjusted yield score. When that score exceeds the minimum threshold (≥60) and five safety gates pass, it executes a Bitflow swap (STX → sBTC) to align the wallet for optimal HODLMM deposit entry. Every execution is logged with signal IDs, readiness index snapshot, and the Hiro explorer link.

## Why agents need it

Entering a HODLMM position requires two things most agents handle separately: knowing *when* macro conditions favor a yield allocation, and having the *right token ratio* at the active bin. Agents acting on stale or low-quality signals over-allocate to HODLMM during unfavorable windows and under-allocate during yield spikes. This skill closes that gap by gating the swap on verified signal quality and quantum risk — if the intelligence layer is silent or uncertain, the skill does nothing and says why.

No other skill in this registry combines news signal intelligence with Quantum Readiness risk adjustment as a DeFi execution gate.

## Safety notes

Five hard-coded gates execute in order before any swap:

1. **Signal quality gate** — `signal_score < 60` → `status: "blocked"`. Derived from aibtc.news approved bitcoin-macro signals, 24h window, recency-weighted.
2. **Quantum risk gate** — `(100 - readiness_index) / 100 × 0.2 > 0.15` → `status: "blocked"`. Quantum Power Map must show Readiness Index ≥ 25 before long-duration HODLMM allocation proceeds.
3. **Spend cap** — `--amount-stx` hard-coded max: 500 STX. Amounts above this return `status: "blocked"`.
4. **STX reserve** — wallet must retain ≥ 10 STX post-swap for gas. Refused if not satisfied.
5. **Price impact** — Bitflow quote must show ≤ 1.5% price impact. Wider spreads return `status: "blocked"`.

`--confirm` is required for live execution. Without it, `run` returns full simulation output with `status: "blocked"` and reason `CONFIRM_REQUIRED`. Cooldown: 6 hours between executions, enforced from `~/.hodlmm-signal-allocator-state.json`.

## Commands

| Command | Description |
|---|---|
| `doctor` | Health check: Bitflow APIs, aibtc.news signals API, Quantum Power Map, BitflowSDK import |
| `scan --pool <id> --wallet <addr>` | Read HODLMM APR, fetch signal score, compute quantum risk factor, evaluate all gates |
| `run --pool <id> --wallet <addr> --amount-stx <n> [--confirm] [--dry-run]` | Execute Bitflow swap after all 5 gates pass. `--dry-run` simulates without broadcasting. |

**Pool IDs** (from `bff.bitflowapis.finance/api/quotes/v1/pools`): `dlmm_1` (STX-sBTC), `dlmm_3` (STX-xBTC). Default: `dlmm_1`.

## Output contract

All commands emit a single JSON object to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable summary of outcome",
  "data": {},
  "error": { "code": "ERROR_CODE", "message": "...", "next": "How to resolve" }
}
```

**`doctor` data fields:** `{ checks: { bitflow_quotes, bitflow_app, aibtc_signals, quantum_map, bitflow_sdk }, degraded: string[] }`

**`scan` data fields:** `{ pool_id, pool_apr_24h, adjusted_apr, signal_score, quantum_risk_factor, readiness_index, signals_used: [...], gates: { signal_ok, quantum_ok, cooldown_ok }, recommendation, wallet_stx_balance, wallet_sbtc_balance }`

**`run` success data fields:** `{ txId, explorerUrl, amount_in_stx, amount_out_sbtc_estimated, price_impact_pct, signal_score, readiness_index, signal_basis: [...], quantum_risk_factor, adjusted_apr, next_eligible_at }`

## Known constraints

- Requires `@bitflowlabs/core-sdk` installed (`bun install` in skill directory)
- Live execution requires wallet funded with ≥ (amount + 10 STX gas reserve)
- HODLMM API (`bff.bitflowapis.finance`) has a 500 req/min public rate limit
- Quantum Power Map data.json updates when developer scores change; stale data (>7 days) triggers a `doctor` warning but does not block `scan`
- Signal score of 0 (no approved signals in 24h window) always blocks execution

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @IamHarrie-Labs
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/203
