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

Every `launkr.ts` command accepts `--network mainnet|testnet` explicitly
(falls back to the `NETWORK` env var only if the flag is omitted) — always
pass it explicitly rather than relying on the default.

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

> **Gotcha — fixed in `launkr.ts`, real on-chain implication:** passing
> `null`/`noneCV()` for the optional `uri` argument gets the transaction
> **rejected on broadcast** with `BadFunctionArgument`, even though the
> local Clarity encoding looks structurally valid. Root cause not fully
> confirmed (suspected dependency version mismatch in the resolved
> `@stacks/transactions`). Workaround, verified working end-to-end on both
> testnet and mainnet: wrap it as an explicit `Some` instead of `None`,
> e.g. `{"type": "some", "value": {"type": "string-utf8", "value": ""}}`
> when no real URI is given. `launkr.ts`'s `parseLaunkrArg` does this
> automatically — never pass a bare `none`/`null` for this argument.
>
> **This is a real behavioral change, not just broadcast plumbing:** a
> token launched without `--uri` gets its on-chain `uri` field permanently
> set to `Some("")` (an empty string), not `None`. Anything reading token
> metadata (indexers, wallets, `get-token-uri`) will see an empty string
> rather than "no URI set." This is a deliberate, verified tradeoff to get
> a working broadcast — if you need `None` to be preserved, hold off on
> using this skill until the root cause is fixed upstream and re-verified.

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
— scope an `eq` STX post-condition to `stx-in`.

**Sell:** `swap-exact-tokens-for-stx(token, tokens-in, min-stx-out, deadline, recipient)`
— every Launkr token uses the **identical internal FT asset name
`strategy-token`**, regardless of display name/symbol (verified against the
deployed byte-frozen template source, both networks — only the contract
address varies). Use an `eq` fungible-token post-condition scoped to
`tokens-in` with asset name `strategy-token` rather than
`PostConditionMode.Allow`. `launkr.ts` does this correctly.

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
fees split 0.9%/0.1% as documented.

**Mainnet (2026-07-16), against the redeployed contracts above:** Deployed
`SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW.lft` (LFT), bonding mode, 100M
supply (min floor), 500 virtual STX / 2000 STX graduation threshold, `uri`
omitted (using the `Some("")` fix). Both the deploy and `create-pool-bonding`
confirmed successfully on the first attempt — `(ok 'SP1YNEJ....lft)`. This
confirms both the redeployed mainnet contracts and the `uri`-argument fix
are correct.

See `AGENT.md` in this folder for operating rules when using this skill
autonomously, and `launkr.ts` for a reference CLI implementation with all
fixes applied (`uri`-argument workaround, `swap-sell` post-condition,
pool-creation arg cross-check).
