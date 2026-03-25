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

- **Significant move:** > 1,000,000 DOG (1M) in a single transaction
- **Major holder change:** Any top-25 holder whose balance changes > 5% between checks
- **Accumulation signal:** Address receives > 500K DOG within 24 hours across multiple UTXOs

## Data Interpretation Guidelines

- **MVRV < 1.0:** DOG trades below realized value — historically undervalued zone. Flag as "accumulation territory."
- **MVRV > 3.0:** DOG trades well above realized value — overheated. Flag as "distribution risk."
- **LTH % > 75%:** Strong long-term conviction. Supply is locked. Bullish structural signal.
- **LTH % < 50%:** Weak conviction. Supply is mobile. Higher sell pressure risk.
- **Retention rate (airdrop):** Currently ~37%. Declining retention = increasing sell pressure from original recipients.
- **Gini > 0.8:** High concentration — top holders control significant supply. LP risk factor.

## Cooldowns

- Do not call the same endpoint more than once per 3 minutes (respect 20 req/hr public limit).
- For autonomous loop integration, one `pulse` per cycle (5 min) is the recommended cadence.
- `whales` and `diamond` are heavier queries — limit to once per 15 minutes in autonomous mode.
