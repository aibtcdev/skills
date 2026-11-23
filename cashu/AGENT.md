---
name: cashu-agent
skill: cashu
description: Hold small amounts of ecash to get paid and pay over Lightning without a node, and to pass payments to other agents as tokens.
---

# Cashu Agent

Ecash wallet for small, fast payments. The mint custodies the sats; tokens are bearer money.

## Prerequisites

- A mint: `--mint <url>` or `CASHU_MINT`. On testnet the default is testnut (fake sats). On mainnet always pass a mint.
- No Stacks/BTC wallet unlock needed. The ecash lives in `~/.aibtc/cashu/wallet.json` (mode 600).
- Run `mint-info` once per new mint: check `canReceiveLightning` / `canPayLightning` and `inputFeePpk`.

## Decision Logic

| Goal | Subcommand |
|------|------------|
| Get paid over Lightning | `invoice`, share the invoice, then `claim` |
| Pay a Lightning invoice | `pay --max-fee <cap>` |
| Pay another agent directly | `send`, deliver the token (inbox, DM, file) |
| Accept a token as payment | `check-token` (spendable?), then `receive` |
| See funds | `balance` |
| A payment came back `PENDING`, or `balance` shows `pendingMeltSats` | `reconcile` (again later if still pending) |
| A token you sent was never redeemed | `reclaim --send-id <id>` |

## Safety Checks

- Before `pay`: the invoice amount is what you agreed to; always pass `--max-fee`. On mainnet, confirm amounts with your operator first.
- Keep balances small: a mint can fail or disappear. Melt (pay out) what you do not need soon.
- Never paste the wallet file or an unsent token into logs or public posts: either one is spendable by whoever reads it.
- A token received is not final until `receive` succeeds. Do not deliver work against `check-token` alone if the sender could still spend it.
- Tokens from testnut are fake; mainnet refuses them. On mainnet, accept tokens only from mints in `CASHU_TRUSTED_MINTS` (or a deliberate `--trust-mint`).
- Pass tokens with `--token-file` or `--token -` (stdin), never as a plain argument.
- `check-token.spendable` requires valid DLEQ proofs; a token with `proofsWithoutDleq > 0` might be genuine, but only `receive` proves it.

## Error Handling

| Error | Meaning / next step |
|-------|---------------------|
| `No mint given` | Mainnet: pass `--mint` or set `CASHU_MINT` |
| `Not enough ecash` | `balance`, then `invoice` + `claim` to top up |
| `Fee reserve … above --max-fee` | Raise the cap deliberately or use another mint |
| `The mint did not pay the invoice` | Unspent inputs were taken back; run `balance` and retry later |
| `pay` output `"state": "PENDING"` | Lightning is still routing. Don't pay again; run `reconcile` later |
| `… is not valid JSON. Nothing was changed` | The wallet file is damaged; restore `wallet.json.bak` |
| `Wallet is locked by another run` | Another cashu command is running; retry, or delete the lock if none is |
| `Mint … is not trusted` | Mainnet: only accept the token if you trust that mint |
| `Token already spent` (from `receive`) | Someone redeemed it first: it is not a payment |
| `UNPAID` in `claim` results | Invoice not paid yet; claim again later |

## Output Handling

- `invoice.invoice` → give to the payer; `invoice.quote` → `claim --quote`.
- `send.token` → deliver to the recipient; `send.balance` → remaining funds.
- `pay.paid`, `pay.feePaid` → record the cost; `pay.preimage` is the proof of payment when the mint returns one.
- `check-token.spendable` should be `true` before `receive`.
- `send.sendId` → keep it to `reclaim` the token if it is never redeemed.
