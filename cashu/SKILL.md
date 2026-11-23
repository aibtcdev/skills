---
name: cashu
description: "Cashu ecash wallet for agents — get paid over Lightning (mint invoice → claim ecash), pay Lightning invoices from ecash (melt, with a fee cap), send and receive Cashu tokens, check whether a token is still spendable before accepting it, and inspect a mint's supported NUTs. No Lightning node needed. Proofs are bearer money, stored in ~/.aibtc/cashu/wallet.json (mode 600). Testnet uses testnut.cashu.space (fake sats that pay themselves); mainnet requires --mint."
metadata:
  author: "mmajjd926-netizen"
  author-agent: "Clever Piston"
  user-invocable: "false"
  arguments: "mint-info | balance | invoice | claim | send | receive | pay | check-token | reconcile | reclaim"
  entry: "cashu/cashu.ts"
  requires: ""
  tags: "write, requires-funds, sensitive"
---

# Cashu Skill

[Cashu](https://cashu.space) is Chaumian ecash for Bitcoin: a mint holds the sats and issues blind-signed tokens that move like cash. For an agent this means Lightning payments in and out without running a node or opening channels, and payments to other agents as a plain string (a `cashuB…` token).

Trust model: the mint custodies the sats until they are melted back to Lightning. Hold only small amounts, and prefer mints you know. The wallet never shares which proofs it holds with anyone but the mint they came from.

## Usage

```
bun run cashu/cashu.ts <subcommand> [options]
```

The mint is chosen by `--mint <url>`, else the `CASHU_MINT` env var, else (testnet only) `https://testnut.cashu.space`, a test mint whose invoices pay themselves. On `NETWORK=mainnet` a mint must be given, and testnut (any scheme or subdomain) is refused.

On mainnet, `receive` and `check-token` only accept tokens from mints you trust: list them in `CASHU_TRUSTED_MINTS` (comma-separated) or pass `--trust-mint <url>`. Anyone can run a mint that issues worthless ecash.

Tokens are bearer money, so pass them with `--token-file <path>` or `--token -` (stdin) rather than on the command line, where they show up in `ps` and shell history.

## Subcommands

### mint-info

Name, version, supported NUTs, whether Lightning in/out is enabled, P2PK/HTLC support, active keysets and their input fee.

```bash
bun run cashu/cashu.ts mint-info --mint https://mint.minibits.cash/Bitcoin
```

### balance

Ecash held per mint, unpaid invoices, and money in flight: `pendingMeltSats` (inputs of a payment whose result is not known yet) and `pendingSendSats` (tokens you made that may not be redeemed yet).

```bash
bun run cashu/cashu.ts balance
```

Output:
```json
{ "network": "testnet", "mints": [{ "mint": "https://testnut.cashu.space", "sats": 46, "proofs": 5, "pendingInvoices": 0, "issuedElsewhereInvoices": 0, "pendingMeltSats": 0, "pendingSendSats": 0 }], "totalSats": 46 }
```

### invoice

Get paid: the mint creates a BOLT11 invoice (NUT-04). Share `invoice`; once it is paid, run `claim`.

```bash
bun run cashu/cashu.ts invoice --amount 1000 --mint https://mint.minibits.cash/Bitcoin
```

Output:
```json
{ "mint": "...", "quote": "01a2…", "amount": 1000, "invoice": "lnbc10u1…", "expiry": 1795338288, "state": "UNPAID", "next": "bun run cashu/cashu.ts claim --mint … --quote 01a2…" }
```

### claim

Mint ecash for paid invoices: one `--quote`, or every pending quote at the mint. Unpaid quotes stay pending. A quote the mint reports `ISSUED` whose proofs never reached this wallet is kept and flagged `issuedElsewhere` (see `balance`), not deleted.

```bash
bun run cashu/cashu.ts claim --mint https://mint.minibits.cash/Bitcoin
```

Output:
```json
{ "mint": "...", "results": [{ "quote": "01a2…", "state": "MINTED", "minted": 1000 }], "balance": 1000 }
```

### send

Make a token worth `--amount` sats to give to another agent or person. The token also covers the mint's input fee for redeeming it, so the receiver gets the full amount.

```bash
bun run cashu/cashu.ts send --amount 100 --memo "for the report"
```

Output: `{ "mint", "amount", "tokenSats", "token": "cashuB…", "sendId", "balance" }`

A copy of the token stays in the wallet file until the receiver redeems it, so a lost output doesn't lose the money. `reconcile` forgets redeemed ones; `reclaim --send-id` takes back one that was never redeemed.

### receive

Redeem a token. This swaps it at its mint, so the sender can no longer spend it; only then is the payment final.

```bash
bun run cashu/cashu.ts receive --token-file token.txt
echo "$TOKEN" | bun run cashu/cashu.ts receive --token -
```

Output: `{ "mint", "received", "memo", "balance" }`

### pay

Pay a BOLT11 invoice from ecash (NUT-05 melt). The mint asks for a fee reserve; what it does not use comes back as change (NUT-08). `--max-fee` (whole sats) refuses the payment if the fee reserve plus the mint's input fee is above your cap.

```bash
bun run cashu/cashu.ts pay --invoice lnbc... --max-fee 10 --mint https://mint.minibits.cash/Bitcoin
```

Output:
```json
{ "mint": "...", "paid": true, "amount": 5, "feePaid": 2, "preimage": null, "balance": 41 }
```

`feePaid` is everything lost beyond the invoice amount (Lightning fee, unreturned reserve, input fees).

The inputs are saved as a pending melt **before** the mint is contacted. If the call fails, the mint is asked for their state (NUT-07): `UNSPENT` inputs return to the wallet, `SPENT` ones are dropped, and `PENDING` or unknown ones stay recorded. A melt can stay `PENDING` while Lightning routes; the output then has `"paid": false, "state": "PENDING"` and a `next` command. Run `reconcile` later.

### check-token

Read-only: is every proof in a token still unspent? Use it before treating a token as payment, then `receive` it.

```bash
bun run cashu/cashu.ts check-token --token-file token.txt
```

Output: `{ "mint", "unit", "sats", "unspentSats", "dleqVerified", "proofsWithoutDleq", "proofsWithBadDleq", "spendable": true, "states": ["UNSPENT", …], "memo" }`

NUT-07 only says whether a secret has been seen, so a forged proof (random secret, any signature) also reads `UNSPENT`. `spendable` is therefore `true` only if every proof is unspent **and** carries a valid NUT-12 DLEQ proof that the mint signed it. A token without DLEQ can still be genuine; only `receive` settles it.

### reconcile

Settle what is in flight at a mint: for each pending melt, ask the mint for the quote and input states, return `UNSPENT` inputs, drop `SPENT` ones, keep `PENDING` ones. For each token made by `send`, report whether it has been redeemed and forget the redeemed ones.

```bash
bun run cashu/cashu.ts reconcile --mint https://mint.minibits.cash/Bitcoin
```

Output: `{ "mint", "melts": [{ "quote", "amount", "quoteState", "returned", "spent", "pending" }], "sends": [{ "sendId", "amount", "createdAt", "redeemed" }], "balance" }`

### reclaim

Take back a token made by `send` that was never redeemed: its unspent proofs are swapped back into the wallet, so the old token stops working.

```bash
bun run cashu/cashu.ts reclaim --send-id 9c1f965d53c5
```

Output: `{ "mint", "sendId", "reclaimed", "alreadyRedeemedSats", "balance" }`

## Notes

- Tested end to end on testnut (CDK 0.18): invoice → claim → send → check-token → reconcile → reclaim → receive → pay (with and without `--max-fee`); forged tokens (random secrets, with and without DLEQ) read `spendable: false`.
- The wallet file holds bearer ecash: anyone who reads it can spend it. Each run takes an exclusive lock (`wallet.json.lock`), writes a unique tmp file with mode 600, fsyncs it, keeps the previous file as `wallet.json.bak`, then renames. A file that can't be read or parsed stops the command instead of being treated as empty.
- Known limits: secrets are random (no NUT-13 seed yet), so outputs whose signatures are lost in transit can't be restored, and change from a melt that stays `PENDING` and settles later is not recovered (at most the unused fee reserve).
- A token is not a payment until it has been received (swapped); a sender can spend it again until then.
