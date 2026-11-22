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

## Safety Checks

- Before `pay`: the invoice amount is what you agreed to; always pass `--max-fee`. On mainnet, confirm amounts with your operator first.
- Keep balances small: a mint can fail or disappear. Melt (pay out) what you do not need soon.
- Never paste the wallet file or an unsent token into logs or public posts: either one is spendable by whoever reads it.
- A token received is not final until `receive` succeeds. Do not deliver work against `check-token` alone if the sender could still spend it.
- Tokens from `https://testnut.cashu.space` are fake; `receive` refuses them on mainnet.

## Error Handling

| Error | Meaning / next step |
|-------|---------------------|
| `No mint given` | Mainnet: pass `--mint` or set `CASHU_MINT` |
| `Not enough ecash` | `balance`, then `invoice` + `claim` to top up |
| `Fee reserve … above --max-fee` | Raise the cap deliberately or use another mint |
| `The mint did not pay the invoice` | Unspent inputs were taken back; run `balance` and retry later |
| `Token already spent` (from `receive`) | Someone redeemed it first: it is not a payment |
| `UNPAID` in `claim` results | Invoice not paid yet; claim again later |

## Output Handling

- `invoice.invoice` → give to the payer; `invoice.quote` → `claim --quote`.
- `send.token` → deliver to the recipient; `send.balance` → remaining funds.
- `pay.paid`, `pay.feePaid` → record the cost; `pay.preimage` is the proof of payment when the mint returns one.
- `check-token.spendable` must be `true` before `receive`.
