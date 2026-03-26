---
name: runes
description: "Bitcoin rune operations — check rune balances, list rune-bearing UTXOs, and transfer runes between addresses with Runestone OP_RETURN encoding. Uses the Unisat API for indexing."
metadata:
  author: "whoabuddy"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "balance | utxos | transfer"
  entry: "runes/runes.ts"
  requires: "wallet"
  mcp-tools: "runes_list_etchings, runes_get_etching, runes_get_holders, runes_get_activity, runes_get_address_balances, runes_get_address_activity, get_rune_balances, get_rune_utxos, transfer_rune"
  tags: "l1, write, requires-funds"
---

# Runes Skill

Provides Bitcoin rune operations using the Unisat API for rune indexing and mempool.space for fee estimation and broadcasting. Rune transfers use Runestone OP_RETURN encoding with explicit change pointers to prevent accidental rune burning.

Requires `UNISAT_API_KEY` environment variable. Works on both mainnet and testnet.

## Usage

```
bun run runes/runes.ts <subcommand> [options]
```

## Subcommands

### balance

Get rune balances for a Bitcoin address. Returns all rune token balances held by the address.

```
bun run runes/runes.ts balance [--address <addr>]
```

Options:
- `--address` (optional) — Bitcoin address to check (uses active wallet's Taproot address if omitted)

Output:
```json
{
  "address": "bc1p...",
  "network": "mainnet",
  "balances": [
    {
      "rune": "UNCOMMONGOODS",
      "runeId": "1:0",
      "spacedRune": "UNCOMMON•GOODS",
      "amount": "1000000",
      "formatted": "1000000 ⧫",
      "symbol": "⧫",
      "divisibility": 0
    }
  ],
  "summary": { "runeCount": 1 },
  "explorerUrl": "https://mempool.space/address/bc1p..."
}
```

### utxos

List rune-bearing UTXOs for a specific rune on a Bitcoin address.

```
bun run runes/runes.ts utxos --rune-id <id> [--address <addr>]
```

Options:
- `--rune-id` (required) — Rune ID (e.g., `840000:1`)
- `--address` (optional) — Bitcoin address to check (uses active wallet's Taproot address if omitted)

Output:
```json
{
  "address": "bc1p...",
  "network": "mainnet",
  "runeId": "840000:1",
  "utxos": [
    {
      "txid": "abc123...",
      "vout": 0,
      "satoshis": 546,
      "runes": [
        {
          "runeId": "840000:1",
          "spacedRune": "UNCOMMON•GOODS",
          "amount": "1000000",
          "formatted": "1000000 ⧫",
          "symbol": "⧫"
        }
      ]
    }
  ],
  "summary": { "utxoCount": 1, "totalSatoshis": 546 }
}
```

### transfer

Transfer runes to a recipient address. Builds a transaction with a Runestone OP_RETURN that directs runes to the recipient and returns remaining runes to the sender via an explicit change pointer.

```
bun run runes/runes.ts transfer --rune-id <id> --amount <amount> --recipient <addr> [--fee-rate fast|medium|slow|<number>]
```

Options:
- `--rune-id` (required) — Rune ID (e.g., `840000:1`)
- `--amount` (required) — Amount of runes to transfer (in smallest unit)
- `--recipient` (required) — Recipient address
- `--fee-rate` (optional) — Fee rate (default: `medium`)

Output:
```json
{
  "success": true,
  "txid": "def456...",
  "explorerUrl": "https://mempool.space/tx/def456...",
  "rune": { "runeId": "840000:1", "amount": "500000" },
  "recipient": "bc1p...",
  "fee": { "satoshis": 1800, "rateUsed": "10 sat/vB" },
  "btcChange": { "satoshis": 5000 },
  "network": "mainnet"
}
```

## Safety

- Rune transfers always include an explicit change pointer in the Runestone to avoid burning remaining rune balances
- Cardinal UTXOs from the SegWit address pay fees — rune-bearing UTXOs are never used for fee payment
- The transfer command validates rune balance before building the transaction

## Notes

- Runes are typically held at Taproot (bc1p) addresses
- Fee payment comes from the SegWit (bc1q) address
- Requires an unlocked wallet (use `bun run wallet/wallet.ts unlock` first)
- Set `UNISAT_API_KEY` environment variable for Unisat API access
