---
name: windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh-agent
skill: windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh
description: "Coordinates a wind-only four-leg yield rotation (sBTC supply on Zest -> USDCx borrow on Zest -> swap to USDh on Bitflow Quote Engine -> inline stake on Hermetica returning sUSDh). Operates in HITL (default, never broadcasts on its own) or autonomous mode (one auto-action per 24h). Emits UNWIND_RECOMMENDED signals for the partner unwinder skill but never broadcasts unwind."
---

# Agent Behavior — Wind-Leg ZestLend → HermeticaStake Yield Rotator

## Skill scope

Wind-only. Four legs:
1. Supply sBTC on Zest (composes `zest-asset-deposit-primitive`)
2. Borrow USDCx on Zest (composes `zest-borrow-asset-primitive`)
3. Swap USDCx → USDh via Bitflow Quote Engine (composes `bitflow-swap-aggregator`, viability-gated by `--max-price-impact-bps`)
4. Stake USDh inline against `staking-v1-1.stake` (verified bytecode at block 3,567,258; the wallet receives sUSDh as the on-chain result; signed via the canonical AIBTC wallet pipeline — wallet-manager session if available, `process.env.CLIENT_MNEMONIC` fallback)

Reverse path is the **partner unwinder skill's** job. This skill emits `UNWIND_RECOMMENDED` signals but does not broadcast unwind. Route the user to the unwinder skill when they need to close a position.

## Operating modes

| Mode | Trigger | Broadcasts? | Use when |
|---|---|---|---|
| **HITL** (default) | Manual `run` / `monitor --mode=hitl` | Only on explicit `--confirm=ROTATE` | The strategy score recommends and a human confirms |
| **Autonomous** | `monitor --mode=autonomous --confirm=AUTONOMOUS` | Wind broadcasts only; unwind is signal-only | Long-running watcher acts on entries without a human present, capped at 1 action/24h |

## Decision order

1. **`doctor` first.** If any installed primitive is missing or any primitive's `doctor` returns non-success, stop. Don't propose `run` until green.
2. **`score` before any write.** Surface composite, sub-scores, warnings, blockers, dropped components, sizing fields, wallet-reserve, post-borrow-APR projection, and `--max-price-impact-bps` evaluation.
   - If `composite < --min-score`: refuse `run` with `STRATEGY_SCORE_TOO_LOW`. Identify the dragging component.
   - If `score.recommendation === "UNWIND"`: surface the signal; route the user to the unwinder skill. **Do not broadcast unwind here.**
   - If `walletReserve.warning === "RESERVE_BELOW_THRESHOLD"`: surface loudly; **do not refuse** — soft warn only.
   - If `selfImpactSizing.zestUsdcxUtilizedShareAfterPct` or `hermeticaSusdhUtilizedShareAfterPct` exceeds `poolShareCapPct`: surface the breach and the `selfImpactBoundedSbtcSats` boundary.
   - If `swapImpactBps > --max-price-impact-bps`: refuse with `SWAP_NOT_VIABLE`. The DLMM pool can't absorb the operator's projected size at acceptable impact.
3. **`status` before any write.** If a checkpoint exists, resolve it first — `resume` or `cancel`. Never start a new rotation on top of an unresolved checkpoint.
4. **Cap LTV.** Refuse `--target-ltv > 0.50`. Warn above `0.40`.
5. **Confirm intent.** Use exactly `--confirm=ROTATE` (forward writes), `--confirm=AUTONOMOUS` (autonomous monitor start). No defaults.
6. **Execute via primitives + inline stake.** Zest legs and the swap leg shell out to documented primitive CLIs. The stake leg broadcasts inline via `@stacks/transactions` against verified Clarity bytecode; the wallet receives sUSDh.
7. **Checkpoint after every confirmed leg.** If a leg fails, stop and surface the saved state.
8. **Autonomous mode rate limit.** Before broadcasting, check the autonomous-action log. If an auto-action fired within the last 24h, refuse with `AUTONOMOUS_RATE_LIMITED`. Always log intent **before** broadcast.

## Strategy-score guardrails (autonomous mode hard refusals)

Do not let an autonomous monitor act on a score that:
- Has `prices.dispersionPct > --max-price-dispersion-pct` — sources disagree on BTC price.
- Has more than two components in `droppedComponents` — composite is too thin.
- Has fewer than 24h of sUSDh exchange-rate history — APY estimate is noisy.
- Has any blocker in `data.blockers`.
- Reports `funding.instantaneousAlarm === true` — momentum rolling over.
- Has `swapImpactBps > --max-price-impact-bps` — pool can't absorb the size.

All surfaced as warnings in `score` output; the autonomous path treats them as hard refusals.

## Phrasing

- `selfImpactBoundedSbtcSats` is a **calculation result** from operator-supplied caps, not a recommendation. Surface it as a constraint boundary; never use the words "recommended" or "suggested" in agent-generated explanations.
- `walletReserve.warning` is risk disclosure, not advice.
- `score.recommendation` is `ENTER | HOLD | UNWIND | NO_OPINION` — gate signals, not advice.
- For `UNWIND` recommendations: "the strategy score has dropped below your `--exit-score-below` threshold. The companion unwinder skill is the actor for this; this skill cannot close positions."

## Guardrails

- Never proceed past a `blocked` or `error` payload without explicit user confirmation (HITL) or a hard refusal (autonomous).
- Never expose `--wallet`'s mnemonic, private key, or signer secret in args or logs. The signer is loaded via the canonical AIBTC pipeline (wallet-manager session if `wallet unlock` was run, otherwise `process.env.CLIENT_MNEMONIC`); never log either value, never include them in JSON output.
- Always surface error payloads with a concrete `next` step.
- Default to read-only behavior when intent is ambiguous (`score` or `plan` over `run`).
- Treat the 7-day Hermetica cooldown as a hard operational fact when describing the position.
- Treat the USDh AMM price (from Bitflow Quote Engine) as the real exit price — do not quote 1.00 in proposals.
- Treat Hermetica direct-mint as out of scope (KYC-gated). Always route through Bitflow.
- The skill does not broadcast unwind. If the user asks to unwind, route to the partner unwinder skill.

## On error

- Log the full error payload (`code` + `message` + `next`).
- Do not retry silently. In particular:
  - `MISSING_PRIMITIVE_DEPENDENCIES` — surface the list; recommend installing.
  - `UNRESOLVED_CYCLE_STATE` — propose `resume` or `cancel`; never start fresh.
  - `PRIMITIVE_BLOCKED` — surface the inner primitive payload; do not retry until resolved.
  - `CONFIRMATION_REQUIRED` — re-prompt for the correct token.
  - `STRATEGY_SCORE_TOO_LOW` — surface dragging components; offer to wait or override.
  - `STRATEGY_BLOCKERS_PRESENT` — do not retry until next polling interval.
  - `AUTONOMOUS_RATE_LIMITED` — report next-available time; do not clear the log.
  - `SWAP_NOT_VIABLE` — surface the price impact at the projected size and the gate threshold.
  - `SIGNER_UNAVAILABLE` — guide the operator: either run `bun run wallet/wallet.ts unlock --password <pw>` (registry env) or export `CLIENT_MNEMONIC="<24-word mnemonic>"` (bff-skills env).
  - `HERMETICA_STAKING_DISABLED` — protocol kill-switch; do not retry.
  - `INSUFFICIENT_USDH_BALANCE` — re-check the swap output; do not retry stake leg with a wrong amount.
  - `BROADCAST_FAILED` — inspect the broadcast error; do not retry without resolving cause.

## On success

- For `run`: report all four legs — supply tx, borrow tx, swap tx (with observed slippage vs Quote Engine projection), stake tx (the wallet now holds sUSDh) — plus resulting LTV, and pointer to the checkpoint file.
- For `score`: report composite + recommendation + the single weakest sub-score, the carry trend, the wallet reserve, the `selfImpactBoundedSbtcSats` boundary alongside the chosen size, and any `UNWIND_RECOMMENDED` signal that should be routed to the unwinder skill.
- For `monitor` (HITL): per-poll JSON with current recommendation; never broadcast.
- For `monitor` (autonomous): per-poll JSON; if a `run` action was broadcast, include the supply tx hash and remaining-leg checkpoint state. If an `unwind-init` intent was logged, surface the recommendation but note no broadcast occurred.
- For `status`: report just the live position. Do not propose actions unless asked.

## Routing hints

- If the user wants to **close** an existing wind-skill position (sUSDh -> USDh -> USDCx -> repay -> sBTC): route to the partner **unwinder skill** (separate PR). This skill cannot.
- If the user holds USDh already and wants to deploy it (no Zest leg): route to the sibling `hermetica-yield-rotator` skill (LP rotation).
- If the user holds sBTC and wants leveraged sBTC exposure (not USD yield): route to `bitflow-zest-sbtc-leverage-cycle`.
- This skill is the right answer only when the user holds sBTC, wants USD-denominated yield from sUSDh **without** selling, and is willing to hold the position with the 7d-cooldown unwind constraint.
