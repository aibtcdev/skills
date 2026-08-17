---
name: launkr-agent
skill: launkr
description: Launch and trade restricted SIP-010 tokens on Launkr — a protected token launcher and XYK AMM on Stacks. Deploy a token, open a bonding or direct pool, and trade STX for tokens.
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
   free from a faucet, mainnet STX is real money. `launkr.ts` follows the
   network of whichever wallet is currently loaded (set by the `NETWORK`
   env var *at wallet-creation time*, not per command) — there is
   deliberately no per-command `--network` override for `launch`,
   `swap-buy`, or `swap-sell`, because the actual broadcast target is
   always the loaded wallet's network regardless of any flag, and a flag
   that looked like it controlled that but didn't was a real, confirmed
   bug in an earlier version of this skill. Check which wallet/network is
   active before running a write command, don't assume. (`get-pool`,
   `quote-buy`, `quote-sell` are pure reads with no wallet coupling, so
   they do still take an independent `--network` flag.)
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
3. **Omitting `--uri` correctly results in an on-chain `none`.** An earlier
   version of this skill worked around a `BadFunctionArgument` rejection by
   sending `Some("")` instead — that turned out to be specific to a
   different runtime environment, not a real Stacks/Clarity constraint, and
   was reverted once confirmed. See `SKILL.md` for the verification detail
   if you're touching `parseLaunkrArg` again — re-verify on-chain before
   changing this back, don't reason about it from the code alone (that's
   exactly how this got it wrong the first time).
4. `--virtual-stx`/`--graduation-threshold` (bonding) and `--stx-seed`
   (direct) are required per mode — `launch` and `create-pool` both fail
   fast with a clear message if the wrong ones are missing, rather than
   deploying the token first and only discovering the gap when pool
   creation aborts. (That was a real bug: `--stx-seed` used to be optional,
   so a `--mode direct` run with no seed proceeded through the whole
   deploy before failing.) For **direct mode**, separately confirm you
   actually hold ≥ `stxSeed` uSTX before attempting the call — the required
   flag only means the value was supplied, not that you can afford it.
5. Pick `virtualStx`/`graduationThreshold` (bonding) deliberately, not just
   at the floor minimums, unless the goal is specifically a cheap test
   token — floor values create a very "top-heavy" curve (large price impact
   per STX traded).
6. **Trust but verify the Launkr API's response** — this is the part of
   `launch` most worth re-reading if you're extending it, since it's been
   wrong twice already in ways that only surfaced on-chain. `launkr.ts`
   checks, before spending any gas: the deploy step's `clarityCode`
   byte-matches the real on-chain template; the pool-creation step calls
   the function that matches your `--mode` (`create-pool-bonding` vs
   `create-pool-direct` — a response could otherwise call the wrong one
   while every arg still looked fine); the pool-creation args are exactly
   the length the mode requires (not just "at least" — a short bonding
   response can read `fee-receiver` as `graduation-threshold`); and the
   `token`/`name`/`symbol`/`supply`/`fee-receiver`/curve-parameter values
   in those args match what was requested. Don't remove or narrow any of
   these — each one closes a gap a previous version of this file actually
   had.
7. **`launch` is two transactions with no atomicity between them, but there
   is a recovery path.** If pool creation (step 2) fails or the process is
   interrupted after the token deploys, don't re-run `launch` — it deploys
   a *second* token. Use `create-pool --token <the-already-deployed-principal>`
   with the same params instead; `launch` itself prints this exact
   instruction after a successful deploy.

## Trading (quote / swap)

1. Always call `quote-buy`/`quote-sell` immediately before a swap and derive
   `min-tokens-out`/`min-stx-out` from that quote with a slippage tolerance
   (1–2% is reasonable for a low-liquidity bonding pool; widen it if the
   pool is thin or volatile). Never hardcode a slippage guard without a
   fresh quote — pool state changes with every trade.
2. Treat a `none` result from `quote-buy`/`quote-sell` as "do not proceed" —
   it means the pool doesn't exist or your input amount is zero, not "any
   amount is fine."
3. **Every principal that moves an asset in the swap needs a post-condition
   under `Deny` mode, not just you.** A buy has the singleton sending back
   both the token *and* STX (two fee legs); a sell has the singleton paying
   out STX (proceeds + fees). `launkr.ts` covers all of it — your own leg
   tightly (`eq`), the singleton's fee-paying leg loosely (`gte 0`, since
   that's the contract's own fee math, not something worth asserting an
   exact bound on), and the singleton's payout to you as the real slippage
   guard (`gte` your minimum). One post-condition per (principal, asset)
   covers everything that principal sends of that asset in the whole
   transaction — you don't need a separate condition per individual
   transfer. Don't strip any of these down to "just the caller" again —
   an earlier version did exactly that and aborted every single swap with
   `abort_by_post_condition`, verified on both testnet and mainnet.
4. Set a `deadline` when the surrounding context is time-sensitive (e.g.
   part of a multi-step flow where a stale price is a real risk). Only fall
   back to `0xffffffff` (no deadline) for one-off manual actions.

## Error handling

- Don't retry a rejected broadcast blindly. Read the rejection reason first
  — `BadFunctionArgument`, a post-condition failure, and a real contract
  `(err uNNN)` all need different fixes, and blind retries can burn gas
  repeatedly on the same mistake.
- `abort_by_post_condition` specifically means some asset movement in the
  transaction wasn't covered by a post-condition — check the node's
  `vm_error` for which principal/asset it flagged rather than guessing.
- Map `(err uNNN)` results to the error table in `SKILL.md` before deciding
  what to do next — several of them (e.g. `u209`/`u220`/`u224`) mean your
  launch parameters are mathematically invalid for the curve, not that
  something is broken.

## What NOT to do

- Don't launch a token with a `feeReceiver` you don't control unless that's
  explicitly the intent — it receives 90% of all swap fees on that pool.
  If you do need to fix it after the fact, `set-fee-receiver` (called by
  the *current* receiver) followed by `accept-fee-receiver` (called by the
  new one) is the correction path — it's a real two-step on-chain transfer,
  exposed by this skill, not just a theoretical escape hatch.
- **Correction (biwasxyz review round 2): the line that used to be here was
  wrong, not just imprecise.** It said tokens can never be transferred
  outside the singleton and that selling back is the only way out. From
  `is-recipient-allowed` in the deployed `restricted-token-template-v6`:
  a transfer to an ordinary wallet (a standard principal) is **always**
  allowed — `(is-none (get name ok-parts)) → true`, unconditionally. The
  gate only applies to **contract** recipients (checked against
  `approved-principals`/`approved-code-hashes`, which start out containing
  only the singleton). So the real restriction is on *composability* — you
  can't hand the token to another DEX, use it as collateral, or plug it
  into another protocol unless that contract gets allowlisted — not on
  moving it at all. Selling via `swap-sell` is how you convert it back to
  STX, but sending it to a friend's wallet, another EOA you control, or an
  exchange deposit address (if that's a standard principal, as most are)
  works today, unconditionally. Also not permanent: the allowlist admin
  (hardcoded in the template at deploy time, itself transferable via
  `set-pending-allowlist-admin`/`accept-allowlist-admin`) can add or remove
  approved principals/code hashes at any time. Tell a user deciding whether
  to hold or launch the real shape of the restriction, not the wrong one.
- Don't assume a pool is safe to trade at size just because it exists.
  `get-pool` first — check `active`, `mode`, and current reserves before
  committing meaningful STX to a swap. (This instruction was previously
  unfollowable: `get-pool` had a decode bug that returned every field as
  `undefined` or the literal string `"[object Object]"`, `active` included
  — an agent checking `active` got a falsy value regardless of the pool's
  real state. Fixed by decoding the full Clarity-value tree instead of
  assuming a fixed unwrap depth; verified against a real pool.)
- Don't skip the confirmation-wait between launch steps to save time. A
  pool-creation call against an unconfirmed (or failed) token deploy will
  fail outright, and diagnosing "why" after the fact costs more time than
  the wait would have.
- Don't assume documentation and code agree without checking — if you're
  editing either `SKILL.md`/`AGENT.md` or `launkr.ts`, update both together
  and re-verify end-to-end **on-chain, not just by reading the code** before
  pushing. Three separate real bugs made it past review this way already:
  docs describing `none` while the code sent `Some("")`; `Deny`-mode
  post-conditions that looked correct on paper but had never actually been
  broadcast; and a decode helper (`get-pool`) that looked correct on paper
  and had *also* never actually been run against a real response. All three
  only surfaced once someone checked the chain — reading the code carefully
  was not enough in any of the three cases, and paraphrasing an unverified
  claim in a PR comment (which briefly happened here too, over the
  `noneCV()` root-cause writeup) is its own version of the same mistake.
