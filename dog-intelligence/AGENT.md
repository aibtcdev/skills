---
name: dog-intelligence-agent
skill: dog-intelligence
description: "Autonomous operation rules for DOG rune on-chain intelligence — read-only analytics with forensic profiling, multi-chain whale tracking, multi-exchange market data, and conviction metrics."
---

# dog-intelligence — Autonomous Operation Rules

## Decision Flow

1. **Always run `doctor` before any action.** If doctor returns `status: "blocked"` or any check fails, stop and report the issue. Do not proceed to `run`.
2. **Never expose API keys in logs or output.** If `DOGDATA_API_KEY` is set, mask it in all output (show `dog_live_***` not the full key).
3. **All outputs are strict JSON.** No plaintext, no markdown, no mixed formats. Every response follows the standard envelope: `{ status, action, data, error }`.
4. **If rate limited (HTTP 429)**, return `status: "blocked"` with the `Retry-After` value from headers. Never retry silently or loop.
5. **Data is read-only.** No action in this skill requires user confirmation, wallet access, or chain writes. No funds are moved, no transactions are signed.
6. **Always include `source` and `timestamp` in returned data.** Every response must attribute DOG DATA as the source and include the data freshness timestamp.

## Safety Protocols

- **No chain writes.** This skill reads public blockchain data only.
- **No wallet interaction.** Does not access, unlock, or reference any wallet.
- **No sensitive data.** Does not process private keys, mnemonics, passwords, or PII.
- **Mainnet safe.** All endpoints are read-only GET requests against dogdata.xyz.
- **Fail open.** If any endpoint is unreachable, return `status: "error"` with details — never hang or retry indefinitely.
- **Timeout enforcement.** Every HTTP request has a 10-second timeout. AbortController is used to prevent hanging.

## Spending Limits

None. This skill has zero cost — all data comes from a free public API. No sBTC, STX, or BTC is spent at any point.

## Refusal Conditions

- Refuse to run any action if `doctor` has not been run in the current session.
- Refuse to run if the API returns 5xx errors (service down) — report and wait.
- Refuse to expose raw API keys in any output or log.
- Refuse to make POST/PUT/DELETE requests — this skill is GET-only.

## Whale Alert Thresholds

- **Default threshold:** > 1,000,000 DOG (1M) per transaction — applied by the `/whale-alerts` endpoint
- **HIGH severity:** Large individual whale move flagged by DOG DATA's classification engine
- **CRITICAL severity:** Exceptional move — likely top-10 holder or exchange-scale transfer
- **Major holder change:** Any top-25 holder whose balance changes > 5% between checks
- **Multi-chain context:** Whale alerts cover Bitcoin L1, Stacks, and Solana — always check `chain` field

## Data Interpretation Guidelines

- **MVRV < 1.0:** DOG trades below realized value — historically undervalued zone. Flag as "accumulation territory."
- **MVRV > 3.0:** DOG trades well above realized value — overheated. Flag as "distribution risk."
- **LTH % > 75%:** Strong long-term conviction. Supply is locked. Bullish structural signal.
- **LTH % < 50%:** Weak conviction. Supply is mobile. Higher sell pressure risk.
- **Retention rate (airdrop):** Declining retention = increasing sell pressure from original recipients.
- **Gini > 0.8:** High concentration — top holders control significant supply. LP risk factor.
- **Price spread across exchanges > 1%:** Arbitrage opportunity exists. May indicate low liquidity on some venues.
- **Multichain supply on Stacks/Solana:** This is bridged supply — does NOT reduce Bitcoin L1 supply. Track separately.
- **Bitcoin mempool > 50K txs:** Network congested — DOG L1 transactions may be delayed. Flag to user.
- **Fee > 50 sat/vB:** High fee environment. Large DOG transfers become expensive. Advise batching.

## Action Selection Guide

| Situation | Recommended Action |
|-----------|-------------------|
| Quick market check | `pulse` |
| Large move detected / whale alert | `whales` |
| Narrative / conviction analysis | `diamond` |
| Historical distribution context | `airdrop` |
| Supply-side sentiment | `lth-sth` |
| LP / arbitrage / exchange comparison | `markets` |
| Cross-chain bridge analysis | `multichain` |
| Fee planning / transaction timing | `bitcoin` |

## Cooldowns

- Do not call the same endpoint more than once per 3 minutes (respect 20 req/hr public limit).
- For autonomous loop integration, one `pulse` per cycle (5 min) is the recommended cadence.
- `whales`, `diamond`, and `markets` are heavier queries — limit to once per 15 minutes in autonomous mode.
- `bitcoin` and `multichain` update every 5 minutes on the server side — calling more often returns cached data.
