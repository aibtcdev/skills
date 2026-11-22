---
name: cashu
description: "Cashu ecash wallet for agents — get paid over Lightning (mint invoice → claim ecash), pay Lightning invoices from ecash (melt, with a fee cap), send and receive Cashu tokens, check whether a token is still spendable before accepting it, and inspect a mint's supported NUTs. No Lightning node needed. Proofs are bearer money, stored in ~/.aibtc/cashu/wallet.json (mode 600). Testnet uses testnut.cashu.space (fake sats that pay themselves); mainnet requires --mint."
metadata:
  author: "mmajjd926-netizen"
  author-agent: "Clever Piston"
  user-invocable: "false"
  arguments: "mint-info | balance | invoice | claim | send | receive | pay | check-token"
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

The mint is chosen by `--mint <url>`, else the `CASHU_MINT` env var, else (testnet only) `https://testnut.cashu.space`, a test mint whose invoices pay themselves. On `NETWORK=mainnet` a mint must be given.

## Subcommands

### mint-info

Name, version, supported NUTs, whether Lightning in/out is enabled, P2PK/HTLC support, active keysets and their input fee.

```bash
bun run cashu/cashu.ts mint-info --mint https://mint.minibits.cash/Bitcoin
```

### balance

Ecash held per mint and pending (unpaid) invoices.

```bash
bun run cashu/cashu.ts balance
```

Output:
```json
{ "network": "testnet", "mints": [{ "mint": "https://testnut.cashu.space", "sats": 46, "proofs": 5, "pendingInvoices": 0 }], "totalSats": 46 }
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

Mint ecash for paid invoices: one `--quote`, or every pending quote at the mint. Unpaid quotes stay pending.

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

Output: `{ "mint", "amount", "tokenSats", "token": "cashuB…", "balance" }`

### receive

Redeem a token. This swaps it at its mint, so the sender can no longer spend it; only then is the payment final.

```bash
bun run cashu/cashu.ts receive --token cashuB...
```

Output: `{ "mint", "received", "memo", "balance" }`

### pay

Pay a BOLT11 invoice from ecash (NUT-05 melt). The mint asks for a fee reserve; what it does not use comes back as change (NUT-08). `--max-fee` refuses a reserve above your cap.

```bash
bun run cashu/cashu.ts pay --invoice lnbc... --max-fee 10 --mint https://mint.minibits.cash/Bitcoin
```

Output:
```json
{ "mint": "...", "paid": true, "amount": 5, "feePaid": 2, "preimage": null, "balance": 41 }
```

`feePaid` is everything lost beyond the invoice amount (Lightning fee, unreturned reserve, input fees). If the mint refuses before paying, the inputs are checked (NUT-07) and the unspent ones are kept.

### check-token

Read-only: is every proof in a token still unspent? Use it before treating a token as payment, then `receive` it.

```bash
bun run cashu/cashu.ts check-token --token cashuB...
```

Output: `{ "mint", "unit", "sats", "unspentSats", "spendable": true, "states": ["UNSPENT", …], "memo" }`

## Notes

- Tested end to end on testnut (CDK 0.18): invoice → claim → send → check-token → receive → check-token (now spent) → pay → claim.
- The wallet file holds bearer ecash: anyone who reads it can spend it. It is written atomically with mode 600.
- A token is not a payment until it has been received (swapped); a sender can spend it again until then.
