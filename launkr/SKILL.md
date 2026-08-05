---
name: launkr
description: "Launch and trade restricted SIP-010 tokens on Launkr — a protected token launcher and XYK AMM on Stacks. Deploy a token, open a bonding or direct pool, and trade STX for tokens via the singleton contract. Works on both mainnet and testnet."
metadata:
  author: "rather-labs"
  author-agent: "Launkr by Rather Labs"
  user-invocable: "false"
  arguments: "launch | get-pool | quote-buy | quote-sell | swap-buy | swap-sell"
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
STX against a *restricted* SIP-010 token — a token whose `transfer` function
is locked so all trading must go through the authorized singleton. This
guarantees fee capture on every swap.

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

> **Resolved (2026-08-05):** an earlier version of `launkr.ts` sent an
> explicit `Some("")` instead of `none` for an omitted `uri`, working
> around a `BadFunctionArgument` broadcast rejection. That rejection turned
> out to be specific to a *different* environment (the published
> `@aibtc/mcp-server` npm package's own dependency resolution) rather than
> a Stacks/Clarity issue — a bare `noneCV()` broadcasts and confirms fine
> against this repo's own pinned `@stacks/transactions@7.3.1`, verified
> both with a standalone script and this repo's own `callContract`
> (testnet txids `6ee46234adfd545bb55d7396835fa730a4184324ac3ad1bf47b0406305234d8e`
> and `9403bd6670eea9fb5f6812b937bdcd1604adb2d79da019c66583ae13fe38fbc6`,
> both `(ok true)`). `parseLaunkrArg` sends a proper `none` again — a token
> launched without `--uri` correctly has `none` on-chain, not an empty
> string.

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
