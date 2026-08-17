---
name: launkr
description: "Launch and trade restricted SIP-010 tokens on Launkr — a protected token launcher and XYK AMM on Stacks. Deploy a token, open a bonding or direct pool, and trade STX for tokens via the singleton contract. Works on both mainnet and testnet."
metadata:
  author: "rather-labs"
  author-agent: "Launkr by Rather Labs"
  user-invocable: "false"
  arguments: "launch | create-pool | get-pool | quote-buy | quote-sell | swap-buy | swap-sell | set-fee-receiver | accept-fee-receiver"
  entry: "launkr/launkr.ts"
  mcp-tools: "deploy_contract, call_contract, call_read_only_function"
  requires: "wallet"
  tags: "l2, defi, write, requires-funds"
---

# Launkr Skill

Launch and trade restricted SIP-010 tokens on Launkr — a protected token
launcher and AMM on the Stacks blockchain. Contracts are public and
permissionless — any agent with a Stacks wallet can call them directly. No
intermediary, no custody, no fee to any third party beyond Launkr's own
protocol fee (see below).

**What Launkr is:** A singleton XYK AMM that hosts N pools. Each pool trades
STX against a *restricted* SIP-010 token. "Restricted" means composability,
not custody: transfers to an ordinary wallet always succeed; only sending
to a *contract* is gated (allowlisted principals/code-hashes, initially
just the singleton). This guarantees fee capture on every *swap* — trades
must go through the singleton — without freezing the token in your wallet.
See `AGENT.md`'s "What NOT to do" for the precise on-chain logic and why
an earlier draft of these docs described this restriction incorrectly.

**Two pool modes:**
- **Bonding** (`create-pool-bonding`) — Starts with virtual reserves. No STX
  seed required. Fee: 1%. Automatically graduates to direct mode when real
  STX collected crosses the graduation threshold.
- **Direct** (`create-pool-direct`) — Starts with a real STX seed (≥ 100
  STX). Fee: 5%.

**Hash gate — critical:** The singleton verifies that each token's source is
byte-identical to the on-chain template. Always fetch the template source
verbatim from the Launkr API or the Hiro API — never modify it, even
whitespace. Any change breaks the singleton's hash-based allowlist check
(`ERR_TOKEN_NOT_OURS u201`).

---

## Protocol Info

Get contract IDs, floors, and fee schedule (call this first — addresses can
change between deployments, always fetch fresh):

```
GET https://launkr.io/api/protocol?network=mainnet
GET https://launkr.io/api/protocol?network=testnet
```

**Mainnet contracts** (redeployed 2026-07-16, dropping an earlier `-mn-demo`
staging suffix — verified live on-chain, see worked examples below):
- Singleton: `SP2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9Z367PM.lp-singleton-v6`
- Template: `SP2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9Z367PM.restricted-token-template-v6`
- Trait: `SP2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9Z367PM.restricted-ft-trait-v6`

**Testnet contracts:**
- Singleton: `ST2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9KJJYWE.lp-singleton-v6`
- Template: `ST2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9KJJYWE.restricted-token-template-v6`
- Trait: `ST2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9KJJYWE.restricted-ft-trait-v6`

`get-pool`, `quote-buy`, and `quote-sell` are pure reads and take an
explicit `--network mainnet|testnet` flag. `launch`, `swap-buy`, and
`swap-sell` do **not** — they always follow whichever wallet is currently
loaded (set by the `NETWORK` env var at wallet-creation time), because
that's what actually determines the broadcast target no matter what a flag
says. An earlier version of this skill had a `--network` flag on every
command, including the three that sign transactions — it silently had no
effect on where the transaction was actually sent, since `callContract`/
`deployContract` read the network from the account, not from any
parameter. Confirm which wallet/network is active before running a write
command rather than expecting a flag to control it.

## Fees

| Mode | Treasury | Protocol | Total |
|---|---|---|---|
| Bonding | 0.90% | 0.10% | 1.00% |
| Direct / Graduated | 4.50% | 0.50% | 5.00% |
| swap-and-burn | — | — | 0% (graduated pools only) |

## Protocol Floors

| Parameter | Minimum | Maximum |
|-----------|---------|---------|
| supply (atomic units) | `100000000000000` | `1000000000000000000000` |
| decimals | — | `18` |
| stxSeed (direct mode) | `100000000` (100 STX) | — |
| virtualStx (bonding mode) | `500000000` (500 STX) | — |
| graduationThreshold | `2000000000` (2000 STX) | `10000000000000` (10M STX) |
| graduationThreshold | — | 10× virtualStx |

---

## 1. Launch a token

Two sequential on-chain transactions. `POST /api/launch` returns unsigned
Clarity source + call params for both — you sign and broadcast each yourself
with your own key. **Do not send step 2 until step 1 confirms on-chain.**

```
POST https://launkr.io/api/launch
{
  "network": "mainnet",
  "deployerAddress": "<your STX address>",
  "name": "My Agent Token",
  "symbol": "MAT",
  "supply": "1000000000000000",       // atomic units, 6 decimals — e.g. this = 1B tokens
  "mode": "bonding",
  "virtualStx": "500000000",          // uSTX, min 500000000 (500 STX)
  "graduationThreshold": "2000000000",// uSTX, min 2000000000 (2000 STX)
  "feeReceiver": "<STX address that gets 90% of swap fees>"
}
```

> **Gotcha:** `virtualStx` / `graduationThreshold` (bonding) or `stxSeed`
> (direct) must be **top-level** fields in this POST body, NOT nested under
> a `bondingMode`/`directMode` object — even though the `GET /api/protocol`
> response's own example schema shows them nested. Nesting them silently
> fails validation with `"virtualStx must be >= 500000000 uSTX"` even when
> the value is valid. `launkr.ts` already builds the flat body correctly.

Response gives you two steps:

1. **contract-deploy** — the token's Clarity source (byte-frozen, don't edit
   it — see the hash-gate warning above).
2. **contract-call** `create-pool-bonding` (or `create-pool-direct`) on the
   singleton — only send after step 1 confirms. Poll
   `GET https://api.hiro.so/extended/v1/tx/{txid}` until `tx_status: "success"`.

`create-pool-bonding` args, in order:
`token` (trait_reference/principal) · `name` (string-ascii 32) · `symbol`
(string-ascii 32) · `decimals` (uint) · `supply` (uint) · `uri` (optional
string-utf8 256) · `virtual-stx` (uint) · `graduation-threshold` (uint) ·
`fee-receiver` (principal)

`create-pool-direct` is the same shape with `stx-seed` (uint) replacing
`virtual-stx`/`graduation-threshold`, and **requires a matching STX
post-condition** (`eq`, amount = stxSeed) since it pulls real STX from the
caller at creation. Bonding mode pulls no STX at creation — its
post-conditions array is empty.

> **Resolved (2026-08-05, corrected 2026-08-17):** an earlier version of
> `launkr.ts` sent an explicit `Some("")` instead of `none` for an omitted
> `uri`, working around a `BadFunctionArgument` broadcast rejection. That
> rejection turned out to be specific to a *different* environment (the
> published `@aibtc/mcp-server` npm package's own dependency resolution)
> rather than a Stacks/Clarity issue — a bare `noneCV()` broadcasts and
> confirms fine against this repo's own pinned `@stacks/transactions@7.3.1`.
> (A prior version of this note cited two testnet txids for this that
> don't exist on-chain — written before the test was actually run, an
> error rather than a stale reference. Verified for real afterward: mainnet
> txid `29b7e58d636d2be118ca658707220e3f5ff19100fbb264f5aeb00c765202e390`,
> `(ok true)`, calling `set-token-uri` with a bare `noneCV()` signed with
> this exact pinned dependency version.) `parseLaunkrArg` sends a proper
> `none` again — a token launched without `--uri` correctly has `none`
> on-chain, not an empty string.

## 2. Quote a trade (free, read-only, no gas)

```
POST https://api.hiro.so/v2/contracts/call-read/<singleton-address>/<singleton-name>/quote-buy
{ "sender": "<any-stx-address>", "arguments": ["<hex token principal>", "<hex uint stx-in-ustx>"] }
```

Same shape for `quote-sell` (tokens-in → stx-out) and `quote-swap-and-burn`
(graduated pools only). Returns `none` if the pool doesn't exist or the
input is zero — always check for `none` before using the result.

Also useful: `get-pool` (full pool state: reserves, mode, graduation
progress, fee-receiver) and `is-paused` (protocol-wide kill switch).

## 3. Swap (buy / sell)

Direct contract calls on the singleton — no API round-trip needed once you
have a quote.

**Buy:** `swap-exact-stx-for-tokens(token, stx-in, min-tokens-out, deadline, recipient)`

**Sell:** `swap-exact-tokens-for-stx(token, tokens-in, min-stx-out, deadline, recipient)`
— every Launkr token uses the **identical internal FT asset name
`strategy-token`**, regardless of display name/symbol (verified against the
deployed byte-frozen template source, both networks — only the contract
address varies).

> **Gotcha — fixed in `launkr.ts`, verified on-chain on both testnet and
> mainnet:** under `PostConditionMode.Deny`, **every principal that moves
> an asset in the transaction needs a post-condition, not just the
> caller.** A buy has the singleton sending back both the FT payout *and*
> STX (the treasury + protocol fee legs); a sell has the singleton paying
> out STX (proceeds + both fee legs). Post-conditioning only the caller's
> own leg — which looks like the obviously-correct, safe thing to do —
> aborts with `abort_by_post_condition` every time, because the
> uncovered singleton-originated transfers get flagged. One
> post-condition per `(principal, asset)` pair covers the aggregate amount
> that principal sends of that asset across the whole transaction, so this
> doesn't need one condition per individual fee leg. The complete correct
> set:
> - **Buy** — caller `eq stx-in` (uSTX), singleton `gte 0` (uSTX, covers
>   the fee legs — not meaningfully boundable since that's the contract's
>   own fee math, not caller input), singleton `gte min-tokens-out` (FT,
>   `strategy-token` — this is the real slippage guard).
> - **Sell** — caller `eq tokens-in` (FT, `strategy-token`), singleton
>   `gte min-stx-out` (uSTX — covers proceeds + both fee legs in one
>   aggregate check, and is itself the real slippage guard).

Always call `quote-buy`/`quote-sell` first and set `min-tokens-out` /
`min-stx-out` a few % under the quote as a slippage guard. Use
`deadline: 0xffffffff` (4294967295) if you don't need a block-height cutoff.

## 4. Recovery, fee-receiver transfer, and other operations

**`create-pool`** — recovery path for when `launch` deployed the token but
the pool-creation step failed or was interrupted (`launch` is two separate
transactions with no atomicity between them). Takes `--token
<already-deployed-principal>` plus the same params `launch` would have
used, and runs only the pool-creation call — built directly from the
documented `create-pool-bonding`/`create-pool-direct` signature above
rather than round-tripping through `/api/launch` again (nothing in that
response for this step isn't already fully determined by your own input).
Re-running `launch` itself after a failed step 2 would deploy a *second*
token, not resume — use `create-pool` instead.

**`set-fee-receiver` / `accept-fee-receiver`** — the singleton's two-step
fee-receiver transfer (`set-pending-fee-receiver` proposed by the current
receiver, `accept-fee-receiver` confirmed by the new one), exposed as CLI
subcommands. The fee-receiver collects 90% of swap volume permanently
once a pool is created — this is the only correction path if it was set
wrong.

**Deploy verification:** `launch` now fetches the real template source
on-chain (`GET /v2/contracts/source/...`) and byte-compares it against the
API's `clarityCode` *before* deploying, rather than trusting the API
response and finding out only after the deploy fee is spent that the
singleton would have rejected it (`ERR_TOKEN_NOT_OURS`) anyway.

**Pool-arg verification:** `validatePoolStepMatchesRequest` (see `launch`)
now also checks `virtual-stx`/`graduation-threshold` (bonding) or
`stx-seed` (direct) against what was requested, not just
name/symbol/supply/fee-receiver — those curve parameters are just as
capable of coming back wrong from the API and are what the entire price
curve is built from.

**Does graduating a pool unlock token transfers?** Not applicable the way
this question originally assumed — see the correction below. Graduating
only changes the pool's `mode` field (bonding fee 1% → graduated fee 5%,
and enables `swap-and-burn`); it never touches the token contract's
allowlist, before or after graduation.

**Correction (2026-08-17):** an earlier version of this doc (and
`AGENT.md`) claimed tokens can *only* ever move by selling back through
the singleton, with transfers "restricted to the singleton permanently."
That's wrong. From `is-recipient-allowed` in the deployed
`restricted-token-template-v6`: `(is-none (get name ok-parts)) → true` —
a transfer to a **standard principal** (an ordinary wallet) is always
allowed, unconditionally. The allowlist (`approved-principals`/
`approved-code-hashes`, seeded with only the singleton) gates **contract**
recipients only. So the real restriction is on composability — you can't
plug the token into another DEX, use it as collateral, or hand it to any
other contract unless the allowlist-admin adds it — not on moving it at
all; sending to another wallet you or someone else controls works today,
same as any SIP-010 token. It's also not necessarily permanent: the
allowlist admin (hardcoded in the template at deploy time, itself
transferable via `set-pending-allowlist-admin`/`accept-allowlist-admin`)
can add or remove approved principals/code hashes at any time.

**Could this skill build pool-creation args on-chain and skip
`/api/launch` for step 2 entirely?** Yes — `create-pool` already does
this. Extending that to skip the API for step 1 too (fetch the template
on-chain, deploy under a locally-chosen contract name, never call
`/api/launch` at all) is also possible in principle, since nothing in that
response is undeterminable from on-chain data plus your own input.
Deliberately not done here: launches submitted through `/api/launch` are
how Launkr's own backend currently learns about new tokens for its own
tracking, separate from the on-chain event indexing `launkr.io`'s frontend
already does independently. Whether to give that up for a smaller trust
surface is a product decision for the Launkr team, not something to
change unilaterally in a skill PR.

**Config now actually fetched live.** `AGENT.md` has always said to fetch
`GET /api/protocol` fresh every session rather than hardcode an address —
but nothing in `launkr.ts` called it; every command read the `-v6`
addresses baked into the script at the time it was written. Fixed:
`fetchProtocolConfig` now calls the live endpoint at the start of every
command that needs the singleton or template address, falling back to the
baked-in addresses (with a warning) only if the request fails. This
contract already redeployed once (2026-07-16); a second redeploy would
previously have made every write target a retired contract and every read
report `found: false`, silently.

**`get-pool` decode bug, fixed.** A single `.value` unwrap isn't enough for
a tuple response — every field *inside* the tuple is its own `{type,
value}` node one level further down. The old code read `mode`/`active`/
reserves directly off the once-unwrapped result and got back objects
(`String(...)` → `"[object Object]"`) or `undefined` for every field,
while still reporting `found: true`. Verified directly against a real
mainnet pool: the old code produced `mode: "[object Object]"`; the fix
(`unwrapCV`, a small recursive tree-flattener) produces `mode: "bonding"`,
`active: true`, and correct numeric strings for every reserve field, from
the same response. `quote-buy`/`quote-sell` didn't have this bug (their
result shape happens to bottom out one level shallower) but now share the
same helper instead of near-duplicate manual unwrap logic.

**`launch`/`create-pool` now require the mode-appropriate curve flags.**
`--virtual-stx`/`--graduation-threshold` (bonding) and `--stx-seed`
(direct) used to be plain optional flags. A `--mode direct` launch with no
`--stx-seed` used to proceed through the entire token deploy — spending
that fee — before failing at pool creation with `abort_by_post_condition`
(the post-condition guarding the seed can't be built from `undefined`).
Both commands now validate this before doing anything on-chain. As a
consequence, `validatePoolStepMatchesRequest`'s curve-parameter checks
(added when the checker was first extended to cover them) are now always
exercised — they used to silently no-op whenever the corresponding flag
was omitted, which was the default, most common case.

**`validatePoolStepMatchesRequest` now checks the pool-creation function
name, the exact arg count per mode, and the token principal, not just the
argument values.** Three more gaps: the API's chosen `functionName` was
invoked verbatim with no check that it matched the locally-validated
`--mode` (a `create-pool-direct` response under `--mode bonding` would
have passed every other check and broadcast a call that pulls STX with no
post-condition); the arg-count check accepted `>= 8`, so an 8-arg response
under bonding mode (which needs 9) had `graduation-threshold` and
`fee-receiver` silently read from the same slot; and `args[0]`, the token
the pool is even for, was never compared against the token that was
actually just deployed. All three are checked now.

**`create-pool` reads `decimals` from the already-deployed token contract**
instead of hardcoding `6` — `launch` takes decimals from whatever the API
response used, so a hardcoded value in the recovery path could silently
diverge and create a differently-configured pool than `launch` would have.
Reading it back from the live contract via `get-decimals` can't drift from
what's actually on-chain, by construction.

**`launch` now waits for the pool-creation transaction to confirm**, not
just the deploy — it used to print `success: true` right after
*broadcasting* the pool-creation call, so a caller had no way to
distinguish "pool created" from "pool creation is still pending" from
"pool creation aborted on-chain" from the JSON output alone.

## Error codes

| Code | Meaning |
|---|---|
| u200 | ERR_POOL_EXISTS — pool already exists for this token |
| u201 | ERR_TOKEN_NOT_OURS — token source hash doesn't match APPROVED_TOKEN_HASH |
| u209 | ERR_VIRTUAL_RATIO_TOO_LOW — virtualStx too low relative to supply |
| u217 | ERR_NOT_GRADUATED — swap-and-burn called on a bonding pool |
| u220 | ERR_RATIO_TOO_HIGH — graduationThreshold > 10x virtualStx |
| u221 | ERR_GRADUATION_TOO_HIGH — graduationThreshold > 10M STX |
| u224 | ERR_DEGENERATE_CURVE — less than 50% of supply would be released at graduation |

## Worked examples (both verified end-to-end, real broadcasts)

**Testnet (2026-07-03):** Deployed `launkr-test-token` (LTT), bonding mode,
500 virtual STX / 2000 STX graduation threshold, 1B supply. Created pool.
Quoted 1 STX → 1,976,087.347052 LTT via `quote-buy`. Executed
`swap-exact-stx-for-tokens` for 1 STX — received exactly the quoted amount,
fees split 0.9%/0.1% as documented. (This particular swap was broadcast in
`Allow` mode, before the `Deny`-mode post-condition gotcha above was found
— see the mainnet example below for a `Deny`-mode-verified swap.)

**Mainnet (2026-07-16), against the redeployed contracts above:** Deployed
`SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW.lft` (LFT), bonding mode, 100M
supply (min floor), 500 virtual STX / 2000 STX graduation threshold, `uri`
omitted (using the `Some("")` workaround that was in place at the time —
see the "Resolved" note above; a bare `none` has since been confirmed
correct and is what `launkr.ts` sends today). Both the deploy and
`create-pool-bonding` confirmed successfully on the first attempt —
`(ok 'SP1YNEJ....lft)`. This confirms the redeployed mainnet contracts are
correct.

**Mainnet (2026-08-05), `Deny`-mode swap verification:** Against the same
LFT pool, ran `swap-exact-stx-for-tokens` for 0.3 STX with the full
three-post-condition set from the gotcha above — `(ok u59364737346)`,
matching the `quote-buy` result exactly. Then ran
`swap-exact-tokens-for-stx` selling 10,000 LFT with the two-post-condition
sell set — `(ok u49554)`, matching `quote-sell` exactly. Both confirmed on
the first attempt with the corrected post-conditions; the original
(caller-only) post-condition set was also tested first and reliably
produced `abort_by_post_condition`, confirming the gotcha is real and the
fix resolves it.

See `AGENT.md` in this folder for operating rules when using this skill
autonomously, and `launkr.ts` for a reference CLI implementation with all
fixes applied (correct `uri`/`none` handling, full swap post-condition
coverage, pool-creation arg cross-check).
