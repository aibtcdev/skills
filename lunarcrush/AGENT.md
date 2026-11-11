---
name: lunarcrush-agent
skill: lunarcrush
description: Pay-per-call LunarCrush social and market intelligence via x402 on Stacks — oracle, score, health, and meta subcommands with automatic STX payment handling.
---

# LunarCrush Skill — Agent Operations

This document covers autonomous-mode rules for invoking the `lunarcrush` skill: prerequisites, decision logic, safety checks, and error handling.

## Prerequisites

- An unlocked Stacks wallet (managed via the `wallet` skill or via `MNEMONIC` env var).
- For `mainnet` calls (default): the wallet must hold STX. Each `score` call costs ~$0.005 USD worth of STX (~22,000 microSTX at $0.22 STX). Verify balance is at least 100,000 microSTX before calling to leave headroom.
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
3. If a paid call comes back with no usable data (`galaxy_score: null`, a `warning`, or an `UNKNOWN` oracle verdict), the output carries a `degraded` object: `paid: true`, the `reason`, and a `claim` (`txid`, `symbol`, `endpoint`, `network`, `paid_at`). The payment was still consumed. Treat it as no signal and skip downstream signal generation. Do not retry the symbol: the gap is usually per symbol, and the skill refuses to pay for the same endpoint + symbol again for an hour.
4. To get a re-serve, send the `claim` (txid + symbol) to the provider, who has said they honour these by hand (issue #393). Never pay again as a substitute for a claim.

## Cost guardrails

- Default cost per `score`: ~$0.005 USD = ~22,000 microSTX at STX $0.22. **Confirm the live price via `meta` before bulk operations.**
- A naive loop calling `score` on 100 symbols = $0.50 = ~2.27 STX at current rates. Acceptable for one-off analysis; bad as a polling cron. For polling, use a LunarCrush API subscription instead and use this skill for spot-checks.
- If the agent is running a budget-bounded autonomous flow, declare a maximum total spend in microSTX and decrement after each call. Halt if exceeded.
- **Empty-answer breaker.** After 3 consecutive paid calls for different symbols return no usable data (within 10 minutes of each other), the skill refuses every paid call for 10 minutes: the upstream is likely degraded, and a scan over many symbols would otherwise pay for nothing. Refusals happen before any request, so nothing is paid. Run `health` to see the breaker and per-symbol cooldowns. `--force` bypasses both; use it only when an operator asks, or for a single probe after the cooldown is mostly over.

## Error handling

| Error condition | Recommended response |
|---|---|
| Wallet balance too low to cover payment | Halt the flow. Slack-DM operator or call `wallet status`. Do not attempt the call. |
| `402` returned but client retries exceeded | Likely a facilitator outage. Wait 5 min, retry once. If still failing, fall back to `meta` and verify the endpoint is up. |
| Output has `degraded` (`paid: true`) | Paid, but LunarCrush had no data. Treat as no signal, skip downstream signal generation, and send `degraded.claim` to the provider for a re-serve. Do not retry the symbol. |
| `code: "LUNARCRUSH_GUARD"`, `kind: "symbol-cooldown"` | Refused before paying: this endpoint + symbol returned no data within the last hour. Nothing was paid. Skip the symbol until `retry_after_seconds`. |
| `code: "LUNARCRUSH_GUARD"`, `kind: "breaker-open"` | Refused before paying: several symbols in a row returned no data. Nothing was paid. Pause the scan for `retry_after_seconds`. |
| `400 invalid_symbol` | Did not consume payment. Symbol must be lowercase a-z + 0-9 only, max 16 chars. Check input. |
| `5xx` from worker | Worker outage. Retry once after 30s. If persists, alert operator. |

## Safety checks

- **No private key handling.** This skill never logs, prints, or transmits the wallet seed phrase. All signing happens via `getAccount()` returning a properly-scoped account object.
- **HTTPS only.** The x402 service interceptor rejects non-HTTPS endpoints (in case anyone passes `--network` with a custom URL).
- **Output is stdout JSON only.** No external commands invoked. The only file written is the guard state, `~/.aibtc/lunarcrush-guard.json` (symbols, reasons and txids of empty answers; override with `LUNARCRUSH_GUARD_STATE_FILE`). It is advisory: an unreadable file starts fresh.
- **Idempotent free endpoints.** `health` and `meta` are free and safe to call repeatedly. `score` and `oracle` are paid and not idempotent (each call consumes a payment).

## When NOT to use this skill

- If you need >17,000 calls/month, switch to a LunarCrush Individual subscription ($90/mo). Cheaper at that volume.
- If you need historical/time-series data (not just current snapshot), this skill doesn't expose that — use the LunarCrush API directly.
- If you need data for symbols outside the LunarCrush universe (obscure altcoins, off-chain assets), the upstream may return null fields.

## Reference

- Endpoint catalog (live): https://lunarcrush-x402-poc-prod.lunarcrush.workers.dev/
- LunarCrush platform: https://lunarcrush.com
- x402 protocol: https://x402.org
- Recipient wallet (mainnet): `SP3TH5S631RYN7Z485TY0KPFVX24R7RW7P25HVZ73`
