---
name: launkr-agent
skill: launkr
description: "Launch and trade restricted SIP-010 tokens on Launkr — a protected token launcher and XYK AMM on Stacks. Deploy a token, open a bonding or direct pool, and trade STX for tokens."
---

# Launkr — Autonomous Operation Rules

Rules for an agent using the Launkr skill (`launkr.ts`) without a human
approving each step. Read `SKILL.md` first for the protocol reference —
this file is about *how to behave*, not the API shape.

## Before doing anything

1. **Fetch `GET /api/protocol?network=<target>` fresh, every session.**
   Contract addresses have changed once already (2026-07-16 mainnet
   redeploy). Never hardcode an address from memory or from an old run.
2. **Know which network you're on.** Testnet and mainnet contracts are
   structurally identical but financially very different — testnet STX is
   free from a faucet, mainnet STX is real money. The skill follows the
   `NETWORK` env var (default `testnet`) — the same one the wallet loads
   against — so set `NETWORK=mainnet` deliberately rather than assuming a
   default. There is no per-command `--network` flag.
3. **This is an early-stage mainnet deployment.** Redeployed 2026-07-16.
   Start with small amounts (floor-minimum supply, minimum virtual-stx) on
   any new integration before scaling up, even though the contract has
   passed a live end-to-end test.

## Launching a token

1. Never edit the `clarityCode` returned by `/api/launch`, not even
   whitespace — it must stay byte-identical to the deployed template or the
   singleton's hash gate rejects it (`ERR_TOKEN_NOT_OURS u201`).
2. Always wait for the deploy transaction (step 1) to reach
   `tx_status: "success"` before sending the pool-creation call (step 2).
   Do not assume success from a `200` on broadcast — poll
   `GET /extended/v1/tx/{txid}` and check the status field.
3. The optional `uri` argument is a genuine Clarity optional. When you don't
   pass `--uri`, the `/api/launch` intent carries `uri: null` and `launkr.ts`
   encodes it as `(none)` — that is valid for `(optional (string-utf8 256))`
   and broadcasts fine. Do not substitute a `Some("")` or any placeholder
   string.
4. For **direct mode**, confirm you actually hold ≥ `stxSeed` uSTX before
   attempting the call — it pulls real STX from your balance at creation
   time, guarded by an exact STX post-condition. Insufficient balance fails
   loudly (post-condition or balance check), it does not silently partial-fill.
5. Pick `virtualStx`/`graduationThreshold` (bonding) deliberately, not just
   at the floor minimums, unless the goal is specifically a cheap test
   token — floor values create a very "top-heavy" curve (large price impact
   per STX traded).

## Trading (quote / swap)

1. Always call `quote-buy`/`quote-sell` immediately before a swap and derive
   `min-tokens-out`/`min-stx-out` from that quote with a slippage tolerance
   (1–2% is reasonable for a low-liquidity bonding pool; widen it if the
   pool is thin or volatile). Never hardcode a slippage guard without a
   fresh quote — pool state changes with every trade.
2. Treat a `none` result from `quote-buy`/`quote-sell` as "do not proceed" —
   it means the pool doesn't exist or your input amount is zero, not "any
   amount is fine."
3. `swap-sell` scopes this for you: it broadcasts in `Deny` mode with a
   fungible post-condition equal to `--tokens-in` on the token sold (asset
   name is always `strategy-token`, since every token is a byte-identical
   copy of the template — see `SKILL.md`). Don't switch it back to
   `PostConditionMode.Allow`: allow-mode on a live wallet means an unexpected
   contract bug could move more of your balance than intended, with nothing
   to catch it.
4. Set a `deadline` when the surrounding context is time-sensitive (e.g.
   part of a multi-step flow where a stale price is a real risk). Only fall
   back to `0xffffffff` (no deadline) for one-off manual actions.

## Error handling

- Don't retry a rejected broadcast blindly. Read the rejection reason first
  — `BadFunctionArgument`, a post-condition failure, and a real contract
  `(err uNNN)` all need different fixes, and blind retries can burn gas
  repeatedly on the same mistake.
- Map `(err uNNN)` results to the error table in `SKILL.md` before deciding
  what to do next — several of them (e.g. `u209`/`u220`/`u224`) mean your
  launch parameters are mathematically invalid for the curve, not that
  something is broken.

## What NOT to do

- Don't launch a token with a `feeReceiver` you don't control unless that's
  explicitly the intent — it receives 90% of all swap fees on that pool,
  permanently (a two-step transfer exists on-chain, but don't rely on
  needing it).
- Don't assume a pool is safe to trade at size just because it exists.
  `get-pool` first — check `active`, `mode`, and current reserves before
  committing meaningful STX to a swap.
- Don't skip the confirmation-wait between launch steps to save time. A
  pool-creation call against an unconfirmed (or failed) token deploy will
  fail outright, and diagnosing "why" after the fact costs more time than
  the wait would have.
