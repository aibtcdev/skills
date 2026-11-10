---
name: btc
description: "Bitcoin L1 operations — check balances, estimate fees, list UTXOs, transfer BTC, and classify UTXOs as cardinal (safe to spend), ordinal (inscriptions), or rune (rune tokens). Data sourced from mempool.space and the Unisat API."
metadata:
  author: "whoabuddy"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "balance | fees | utxos | transfer | get-cardinal-utxos | get-ordinal-utxos | get-rune-utxos | get-inscriptions"
  entry: "btc/btc.ts"
  mcp-tools: "get_btc_balance, get_btc_fees, get_btc_utxos, transfer_btc, get_cardinal_utxos, get_ordinal_utxos, get_rune_utxos, get_inscriptions_by_address"
  requires: "wallet"
  tags: "l1, write, requires-funds"
---

# BTC Skill

Provides Bitcoin L1 operations using mempool.space (free, no auth) and the Unisat API (for inscription/rune/cardinal UTXO classification on both mainnet and testnet). Transfer operations require an unlocked wallet. Balance and fee queries work without a wallet.

Requires `UNISAT_API_KEY` environment variable for UTXO classification commands.

## Usage

```
bun run btc/btc.ts <subcommand> [options]
```

## Subcommands

### balance

Get the BTC balance for a Bitcoin address. Returns total, confirmed, and unconfirmed balances.

```
bun run btc/btc.ts balance [--address <addr>]
```

Options:
- `--address` (optional) — Bitcoin address to check (uses active wallet's btcAddress if omitted)

Output:
```json
{
  "address": "bc1q...",
  "network": "mainnet",
  "balance": { "satoshis": 500000, "btc": "0.005 BTC" },
  "confirmed": { "satoshis": 500000, "btc": "0.005 BTC" },
  "unconfirmed": { "satoshis": 0, "btc": "0 BTC" },
  "utxoCount": 2,
  "explorerUrl": "https://mempool.space/address/bc1q..."
}
```

### fees

Get current Bitcoin fee estimates for different confirmation targets.

```
bun run btc/btc.ts fees
```

Output:
```json
{
  "network": "mainnet",
  "fees": {
    "fast": { "satPerVb": 15, "target": "~10 minutes (next block)" },
    "medium": { "satPerVb": 8, "target": "~30 minutes" },
    "slow": { "satPerVb": 3, "target": "~1 hour" }
  },
  "economy": { "satPerVb": 1, "target": "~24 hours" },
  "minimum": { "satPerVb": 1, "target": "minimum relay fee" },
  "unit": "sat/vB"
}
```

### utxos

List all UTXOs (Unspent Transaction Outputs) for a Bitcoin address.

```
bun run btc/btc.ts utxos [--address <addr>] [--confirmed-only]
```

Options:
- `--address` (optional) — Bitcoin address to check (uses active wallet if omitted)
- `--confirmed-only` (flag) — Only return confirmed UTXOs

### transfer

Transfer BTC to a recipient address. Requires an unlocked wallet with BTC balance.

By default only uses cardinal UTXOs (safe to spend — no inscriptions or runes). Set `--include-ordinals` to allow spending all UTXOs (advanced users only — WARNING: may destroy valuable inscriptions or runes).

```
bun run btc/btc.ts transfer --recipient <addr> --amount <satoshis> [--fee-rate fast|medium|slow|<number>] [--include-ordinals]
```

Options:
- `--recipient` (required) — Bitcoin address to send to
- `--amount` (required) — Amount in satoshis (1 BTC = 100,000,000 satoshis)
- `--fee-rate` (optional) — `fast`, `medium`, `slow`, or a number in sat/vB (default: `medium`)
- `--include-ordinals` (flag) — Include all UTXOs (WARNING: may destroy inscriptions or runes!)

### get-cardinal-utxos

Get cardinal UTXOs (safe to spend — no inscriptions or runes).

```
bun run btc/btc.ts get-cardinal-utxos [--address <addr>] [--confirmed-only]
```

Options:
- `--address` (optional) — Bitcoin address to check (uses active wallet if omitted)
- `--confirmed-only` (flag) — Only return confirmed UTXOs

### get-ordinal-utxos

Get ordinal UTXOs (contain inscriptions — do not spend in regular transfers).

```
bun run btc/btc.ts get-ordinal-utxos [--address <addr>] [--confirmed-only]
```

Options:
- `--address` (optional) — Bitcoin address to check (uses active wallet if omitted)
- `--confirmed-only` (flag) — Only return confirmed UTXOs

### get-rune-utxos

Get rune UTXOs (contain rune balances — do not spend in regular transfers).

```
bun run btc/btc.ts get-rune-utxos [--address <addr>] [--confirmed-only]
```

Options:
- `--address` (optional) — Bitcoin address to check (uses active wallet if omitted)
- `--confirmed-only` (flag) — Only return confirmed UTXOs

### get-inscriptions

Get all inscriptions owned by a Bitcoin address via the Unisat API.

```
bun run btc/btc.ts get-inscriptions [--address <addr>]
```

Options:
- `--address` (optional) — Bitcoin address to check (uses active wallet if omitted)

Output:
```json
{
  "address": "bc1q...",
  "network": "mainnet",
  "inscriptions": [
    {
      "id": "abc123...i0",
      "number": 12345,
      "contentType": "text/plain",
      "contentLength": 42,
      "output": "abc123...:0",
      "location": "abc123...:0:0",
      "offset": 0,
      "outputValue": 546,
      "genesis": {
        "txid": "abc123...",
        "timestamp": "2024-01-01T00:00:00.000Z"
      }
    }
  ],
  "summary": { "count": 1, "contentTypes": ["text/plain"] },
  "explorerUrl": "https://mempool.space/address/bc1q..."
}
```

## Notes

- All fee queries use the public mempool.space API (no authentication required)
- UTXO classification (cardinal/ordinal/rune) uses the Unisat API and works on both mainnet and testnet
- `transfer` is safe by default — it skips UTXOs that contain inscriptions or runes
- Wallet operations require an unlocked wallet (use `bun run wallet/wallet.ts unlock` first)
- Set `UNISAT_API_KEY` environment variable for Unisat API access
