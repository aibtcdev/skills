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
   free from a faucet, mainnet STX is real money. Every `launkr.ts` command
   accepts an explicit `--network mainnet|testnet` flag; pass it explicitly
   rather than relying on the `NETWORK` env var default.
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
3. **Never pass a bare `none`/`null` for the optional `uri` argument.** This
   is not a style preference — a real `noneCV()` reliably gets the
   transaction rejected on broadcast with `BadFunctionArgument` (verified
   on both testnet and mainnet). Use the `Some("")` workaround instead —
   `launkr.ts` does this for you automatically if you don't supply `--uri`.
   Understand the tradeoff before relying on this: the token's on-chain
   `uri` field ends up permanently set to an empty string, not `none` — see
   `SKILL.md` for the full explanation. If your use case genuinely needs
   `none` preserved on-chain, this skill isn't ready for that yet.
4. For **direct mode**, confirm you actually hold ≥ `stxSeed` uSTX before
   attempting the call — it pulls real STX from your balance at creation
   time, guarded by an exact STX post-condition. Insufficient balance fails
   loudly (post-condition or balance check), it does not silently partial-fill.
5. Pick `virtualStx`/`graduationThreshold` (bonding) deliberately, not just
   at the floor minimums, unless the goal is specifically a cheap test
   token — floor values create a very "top-heavy" curve (large price impact
   per STX traded).
6. **Trust but verify the Launkr API's response.** `launkr.ts` cross-checks
   `name`, `symbol`, `supply`, and `fee-receiver` in the returned
   pool-creation args against what you requested, and aborts before
   deploying if anything doesn't match — this exists because the hash gate
   protects the token's *bytes*, not the pool-creation *arguments*. Don't
   remove or bypass this check.

## Trading (quote / swap)

1. Always call `quote-buy`/`quote-sell` immediately before a swap and derive
   `min-tokens-out`/`min-stx-out` from that quote with a slippage tolerance
   (1–2% is reasonable for a low-liquidity bonding pool; widen it if the
   pool is thin or volatile). Never hardcode a slippage guard without a
   fresh quote — pool state changes with every trade.
2. Treat a `none` result from `quote-buy`/`quote-sell` as "do not proceed" —
   it means the pool doesn't exist or your input amount is zero, not "any
   amount is fine."
3. For sells, scope a real fungible-token post-condition (asset name is
   always `strategy-token` — see `SKILL.md`) rather than broadcasting with
   `PostConditionMode.Allow`. `launkr.ts`'s `swap-sell` already does this;
   don't switch it back to `Allow` — an unexpected contract bug or a future
   template change could otherwise move more than you intended, with
   nothing to catch it.
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
- Don't assume documentation and code agree without checking — if you're
  editing either `SKILL.md`/`AGENT.md` or `launkr.ts`, update both together
  and re-verify end-to-end before pushing. This exact gap (docs describing
  `none` while the code sends `Some("")`) is what blocked this skill's
  first merge attempt.
