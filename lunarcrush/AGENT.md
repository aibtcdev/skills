# LunarCrush Skill — Agent Operations

This document covers autonomous-mode rules for invoking the `lunarcrush` skill: prerequisites, decision logic, safety checks, and error handling.

## Prerequisites

- An unlocked Stacks wallet (managed via the `wallet` skill or via `MNEMONIC` env var).
- For `mainnet` calls (default): the wallet must hold STX. Each `score` / `velocity` call costs ~$0.005 USD (~22,000 microSTX at STX $0.22); each `oracle` call costs ~$0.025 (~115,000 microSTX). Verify balance is at least **`(per_call_microSTX * planned_call_count) + 100,000 microSTX safety reserve`** before starting a batch — the 100K reserve covers price drift only, NOT additional calls. For ad-hoc single calls, 100K microSTX over the per-call cost is sufficient.
- For `testnet` calls: free STX from the Hiro testnet faucet.

The skill itself does not need a separate API key — it makes paid x402 HTTP calls to a public Cloudflare Worker.

## When to invoke

Use the `score` subcommand when an agent needs current crypto market + social intelligence for a specific symbol. Specifically:

- **Trade signal validation** — confirm Galaxy Score and AltRank before opening a position.
- **Watchlist scanning** — periodic per-symbol checks (low-volume, ad-hoc). For high-volume scanning, prefer a LunarCrush subscription (more economical above ~17K calls/month).
- **Sentiment-aware automation** — gate actions on AltRank crossovers or Galaxy Score thresholds.

Use `meta` to discover the current catalog and live pricing. Cheap, free, idempotent.

## Decision logic

Before calling `score`:

1. Confirm wallet balance ≥ 100,000 microSTX (mainnet) or testnet STX present.
2. If you've already called for the same symbol within the last 60 seconds, **skip the call** — Cloudflare edge cache returns the same upstream data anyway, and you'd be paying again for cached data. Cache the prior response in agent memory.
3. If `score` returns `galaxy_score: null` with a `warning` field, the LunarCrush upstream API failed. The payment was still consumed. Decide whether to retry (only worth it if you can wait 60s+ for cache miss to expire) or accept the partial response.

## Cost guardrails

- Default cost per `score`: ~$0.005 USD = ~22,000 microSTX at STX $0.22. **Confirm the live price via `meta` before bulk operations.**
- A naive loop calling `score` on 100 symbols = $0.50 = ~2.27 STX at current rates. Acceptable for one-off analysis; bad as a polling cron. For polling, use a LunarCrush API subscription instead and use this skill for spot-checks.
- If the agent is running a budget-bounded autonomous flow, declare a maximum total spend in microSTX and decrement after each call. Halt if exceeded.

## Error handling

| Error condition | Recommended response |
|---|---|
| Wallet balance too low to cover payment | Halt the flow. Slack-DM operator or call `wallet status`. Do not attempt the call. |
| `402` returned but client retries exceeded | Likely a facilitator outage. Wait 5 min, retry once. If still failing, fall back to `meta` and verify the endpoint is up. |
| `200` with `galaxy_score: null` + warning | LunarCrush upstream failed but we still paid. Log the warning, treat as soft-failure, skip downstream signal generation. |
| `400 invalid_symbol` | Did not consume payment. Symbol must be lowercase a-z + 0-9 only, max 16 chars. Check input. |
| `5xx` from worker | Worker outage. Retry once after 30s. If persists, alert operator. |

## How verdict + vibe are generated (deterministic, not LLM)

Both `verdict` and `vibe` on the `oracle` response are **deterministic synthesis** — no LLM, no upstream variability, no extra latency beyond the LunarCrush API call:

- `verdict` is bucketed from the composite score (Galaxy 45% / AltRank 35% / 24h momentum 20%) into one of six fixed tiers (`STRONG-BUY` ≥75, `BUY` 60-74, `NEUTRAL` 45-59, `WATCH` 30-44, `AVOID` <30, `UNKNOWN` for missing data).
- `vibe` is selected from six templated one-liners keyed by verdict — same composite inputs always produce the same vibe string. Emoji are static parts of each template.

This means `oracle` latency is the LunarCrush v4 fetch + a few microseconds of arithmetic. No GPT/Claude/Gemini call inside, so calling `oracle` at scale carries no variable AI cost on top of the $0.025 fixed price.

## Safety checks

- **No private key handling.** This skill never logs, prints, or transmits the wallet seed phrase. All signing happens via `getAccount()` returning a properly-scoped account object.
- **HTTPS only.** The x402 service interceptor rejects non-HTTPS endpoints (in case anyone passes `--network` with a custom URL).
- **Output is stdout JSON only.** No files written. No external commands invoked.
- **Idempotent free endpoints.** `health` and `meta` are free and safe to call repeatedly. `score` is paid and not idempotent (each call consumes a payment).

## When NOT to use this skill

- If you need >17,000 calls/month, switch to a LunarCrush Individual subscription ($90/mo). Cheaper at that volume.
- If you need historical/time-series data (not just current snapshot), this skill doesn't expose that — use the LunarCrush API directly.
- If you need data for symbols outside the LunarCrush universe (obscure altcoins, off-chain assets), the upstream may return null fields.

## Reference

- Endpoint catalog (live): https://lunarcrush-x402-poc-prod.lunarcrush.workers.dev/
- LunarCrush platform: https://lunarcrush.com
- x402 protocol: https://x402.org
- Recipient wallet (mainnet): `SP3TH5S631RYN7Z485TY0KPFVX24R7RW7P25HVZ73`
