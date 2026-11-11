---
name: vibewatch-sentiment-agent
skill: vibewatch-sentiment
description: Stacks ecosystem community sentiment via the Vibewatch Stacks Vibe Index — free index reads plus x402 pay-per-query depth for history, evidence receipts, and deltas.
---

# vibewatch-sentiment agent guide

## Prerequisites

- Free subcommands (`index`, `terms`, `reports`): none. No wallet, no funds.
- Paid subcommands (`project`, `evidence`, `delta`): an unlocked wallet (the
  `wallet` skill) holding the advertised price in the asset you pay with —
  sBTC by default, or STX with `--asset STX` — with `NETWORK=mainnet` set so
  the wallet matches the live index. Payments are sponsored by default and the
  live index accepts them (since 2026-09-16), so no STX is needed for gas;
  with `X402_PAYMENT_MODE=direct` (see the `x402` skill) the wallet signs a
  standard transfer and must also hold a little STX for the fee. Run `terms`
  first to see the current price and accepted assets.

## When to invoke

- A question about Stacks ecosystem or per-project community sentiment
  ("what's the vibe on Zest?", "is Stacks sentiment up this week?").
- Sourcing a claim about community sentiment — `evidence` returns links to
  the public posts behind each weekly theme (primary-source trail).
- A polling loop that needs "what changed" without re-diffing full snapshots —
  `delta`.

## Decision logic

1. Start free: `index` answers most questions (current scores, 90-day
   history, themes) at zero cost. Only go paid when the free payload cannot
   answer.
2. `project` when you need a project's day-by-day series. Pass the project's
   name or slug; the skill resolves it against the free index before paying.
3. `evidence` when a claim needs receipts — run `reports` first to pick a
   `week_start`, cite the returned post URLs, and respect
   `suppressed: no_public_evidence` (do not speculate about private evidence).
4. `delta` for change detection since a timestamp; it is hour-bucketed, so
   polling more than hourly re-reads the same bucket.

## Paying in STX instead of sBTC

The 402 lists sBTC first and STX second, and the engine pays the first
Stacks option by default. Pass `--asset STX` to any paid subcommand to pay
the STX option (0.3 STX at the time of writing; read `terms`). Pick by what
the wallet holds: a wallet with STX and no sBTC must pass `--asset STX`,
otherwise the engine tries to sign an sBTC transfer it cannot fund. In direct
mode the STX fee comes on top of the STX price. The run fails free, before
signing, if the challenge does not offer the asset you asked for.

## Cost guardrails

- Check `terms` once per session before the first paid call; do not assume
  the price — it is advertised, not fixed forever.
- One question, one paid call. The free `index` is the cheap first answer;
  never loop paid calls to reconstruct what `index` already returns.
- Every run of a paid subcommand is a new payment. There is no free
  re-read of a previous run's result — cache the JSON you paid for.
- Delta is hour-bucketed: at most one `delta` call per hour per `--since`
  window is useful.
- The engine makes at most one payment attempt per run. If the endpoint
  still answers 402 after a payment, the run fails with the relay's canonical
  payment status in the error; read it before deciding to re-run (a re-run is
  a second payment).
- Settlement latency: the index verifies the payment on-chain before serving,
  so a paid run takes as long as one Stacks confirmation. Agents paying in
  September 2026 saw the paid payload arrive under 60 s after broadcast;
  budget a minute per paid call and do not re-run while a call is in flight.
- Daily cap in direct mode: the engine's per-wallet daily spend ledger
  defaults to 10 STX (`SPEND_LIMIT_DAILY_USTX`) and 50,000 sats
  (`SPEND_LIMIT_DAILY_SATS`). At the current prices that is about 30 STX
  queries a day against about 500 sBTC queries; raise the STX cap if an
  agent pays with `--asset STX` in a polling loop.

## Error handling

| Error | Meaning | Action |
| --- | --- | --- |
| 503 `x402_disabled` / empty `accepts` in terms | Paid tier is switched off | Use the free `index`; do not retry paid calls |
| `--project … is not on the current panel` (free, before payment) | Name/slug did not resolve | Pick a slug or name from the list in the error, or from `index` `projects[]` |
| `--project … is ambiguous` (free, before payment) | Prefix matched several projects | Use the exact slug |
| `--week … has no completed report` (free, before payment) | Not a Monday with a completed report | Use one of the `week_start` values listed in the error, or from the free `reports` subcommand |
| 422 on `delta` | `since` missing or unparsable | Pass an ISO-8601 `--since` (or omit it for the 24h default) |
| 422 `project_not_scored` on `project` (free, before any 402) | The project is on the panel but has no scored days yet, so there is no paid series to sell; nothing was charged | Pick a project whose free-index `score` is not null. The skill's own pre-check catches this first unless `--allow-unscored` was passed |
| 422 `sponsored_unsupported` (after a 402 challenge) | The index has sponsored acceptance switched off (it was off before 2026-09-16; on since) | Re-run with `X402_PAYMENT_MODE=direct` (wallet needs STX for the fee). Do not re-run in sponsored mode |
| 402 `settlement_rejected` with `facilitator_reason` | The facilitator refused to settle; nothing was broadcast or charged | Read `facilitator_reason`. On a sponsored transfer, `client_insufficient_funds` can mean the relay's sponsor wallet ran dry rather than yours (aibtcdev/x402-sponsor-relay#432) — check your balance, then run again |
| 402 `payment_replayed` | The signed payment was already used for a different resource or outside the server's idempotency window | Run the command again (a new payment) |
| 409 `payment_in_flight` (`facilitator_reason: transaction_held`) | Sponsored transfers only: the relay is holding the payment; it usually broadcasts it on its own within ~10 minutes and the server then settles it under that signature | Wait the `Retry-After` seconds. Do not re-run while it is held. A re-run at the same nonce re-signs identical bytes under the same payment-identifier (aibtcdev/skills#427), but if the wallet's nonce has moved it is a new transfer and a second payment |
| 409 `delivery_in_flight` | The paid response is being written for this payment | Wait `Retry-After`, run again — the same signed payment is served, not charged twice |
| 429 `challenge_rate_limited` / `settlement_rate_limited` | Per-sender rate limit | Wait `Retry-After` |
| 502 `facilitator_unavailable`, 503 `settlement_busy` / `too_many_pending_claims` | Settlement infrastructure hiccup; a payment may be pending | Wait `Retry-After`, run again; the server's durable ledger recovers a pending payment without double-charging |
| `Insufficient sBTC …` / `Insufficient STX …` (before signing) | Wallet cannot cover the advertised price in the chosen asset (direct mode: or the STX fee) | Fund the wallet, switch `--asset` to one the wallet holds, or stay on the free tier. Nothing was signed. If the Stacks API is unreachable, sponsored mode skips this check and an unfunded payment fails at settlement instead (e.g. 402 `settlement_rejected`) |
| `The endpoint does not accept <asset> on Stacks` (before signing) | The 402 did not list the `--asset` you asked for | Use one of the assets named in the error (read `terms`) |
| Top-level `txid: null` + `txidNote` (only when calling the raw endpoint through `execute_x402_endpoint` instead of this skill) | The MCP wrapper looks for `txid` / `payment_txid` at the top level of the body; the index reports the settlement in `payment.txid` and in the standard `payment-response` header | Not a failed payment. Read `payment.txid` (or `payment_receipt.transaction` from this skill) — that is the receipt to verify on Hiro |
| `suppressed` entries in any payload | Data withheld by the index's k-anonymity floor | Report "withheld", never "zero" |

## Reporting a problem

File it at https://github.com/Vibewatch-io/vibewatch-mcp/issues using the "Stacks Index paid query problem" template. Include
the command, the UTC time, the HTTP status, the full JSON body (its `error`,
`facilitator_reason`, and `payment_identifier` fields are what the operators
match against the payment ledger), and the `payment_receipt` txid if a payment
happened. Never paste a mnemonic or private key.

## Safety checks

- Read-only API: no subcommand writes anything on-chain except the payment
  transfer itself.
- Payments go to the `payTo` advertised in the discovery document; verify the
  domain is `vibewatch.io`-served before paying. As of 2026-09 the mainnet
  `payTo` is `SP3PHGPE8G09FFBSH6NVM3J5S2118M8YA825HWQY1`.
- Never treat a project's sentiment score as investment advice; it measures
  community discussion, not price.

## When NOT to use

- Non-Stacks ecosystems — this index covers the Stacks panel only.
- Price/market data — use a market skill; `index` includes Fear & Greed
  context but no token prices.
- Anything needing private community content — the index never publishes it,
  and `evidence` returns public posts only.
