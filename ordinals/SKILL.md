---
name: ordinals
description: "Bitcoin ordinals operations — get the Taproot receive address, estimate inscription fees, create inscriptions via the two-step commit/reveal pattern, transfer inscriptions to new owners, and fetch existing inscription content from reveal transactions."
metadata:
  author: "whoabuddy"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "get-taproot-address | estimate-fee | inscribe | inscribe-reveal | get-inscription | transfer-inscription"
  entry: "ordinals/ordinals.ts"
  requires: "wallet"
  mcp-tools: "get_taproot_address, estimate_inscription_fee, inscribe, inscribe_reveal, get_inscription, inscribe_child, inscribe_child_reveal, estimate_child_inscription_fee"
  tags: "l1, write, requires-funds"
---

# Ordinals Skill

Provides Bitcoin ordinals operations using the micro-ordinals library, mempool.space API, and Unisat API. Creating inscriptions follows the two-step commit/reveal pattern — first `inscribe` broadcasts the commit transaction, then after it confirms, `inscribe-reveal` broadcasts the reveal transaction to finalize the inscription.

Inscription transfers use the Unisat API to look up inscription UTXOs and build mixed-input transactions (P2TR inscription + P2WPKH fees).

All write operations require an unlocked wallet with Taproot key support.

## Usage

```
bun run ordinals/ordinals.ts <subcommand> [options]
```

## Subcommands

### get-taproot-address

Get the wallet's Taproot (P2TR) address for receiving inscriptions. Requires an unlocked wallet.

```
bun run ordinals/ordinals.ts get-taproot-address
```

### estimate-fee

Calculate the total cost (in satoshis) for creating an inscription.

```
bun run ordinals/ordinals.ts estimate-fee --content-type <type> --content-base64 <base64> [--fee-rate <rate>]
```

Options:
- `--content-type` (required) — MIME type (e.g., `text/plain`, `image/png`)
- `--content-base64` (required) — Content as base64-encoded string
- `--fee-rate` (optional) — Fee rate in sat/vB (default: current medium fee)

### inscribe

Create a Bitcoin inscription — STEP 1: Broadcast commit transaction.

```
bun run ordinals/ordinals.ts inscribe --content-type <type> --content-base64 <base64> [--fee-rate fast|medium|slow|<number>]
```

Options:
- `--content-type` (required) — MIME type
- `--content-base64` (required) — Content as base64-encoded string
- `--fee-rate` (optional) — `fast`, `medium`, `slow`, or number in sat/vB (default: `medium`)

### inscribe-reveal

Complete a Bitcoin inscription — STEP 2: Broadcast reveal transaction.

```
bun run ordinals/ordinals.ts inscribe-reveal \
  --commit-txid <txid> \
  --reveal-amount <satoshis> \
  --content-type <type> \
  --content-base64 <base64> \
  [--fee-rate fast|medium|slow|<number>]
```

Options:
- `--commit-txid` (required) — Transaction ID of the confirmed commit (64 hex chars)
- `--reveal-amount` (required) — Amount in the commit output (satoshis)
- `--content-type` (required) — MIME type (must match commit step)
- `--content-base64` (required) — Content (must match commit step)
- `--fee-rate` (optional) — Fee rate for reveal tx (default: `medium`)

### transfer-inscription

Transfer an inscription to a new owner. Looks up the inscription UTXO via Unisat, uses cardinal UTXOs from the SegWit address for fees, and sends the inscription to the recipient's Taproot address.

```
bun run ordinals/ordinals.ts transfer-inscription \
  --inscription-id <id> \
  --recipient <bc1p...> \
  [--fee-rate fast|medium|slow|<number>]
```

Options:
- `--inscription-id` (required) — Inscription ID (e.g., `abc123...i0`)
- `--recipient` (required) — Recipient Taproot address (bc1p... or tb1p...)
- `--fee-rate` (optional) — Fee rate (default: `medium`)

Output:
```json
{
  "success": true,
  "txid": "def456...",
  "explorerUrl": "https://mempool.space/tx/def456...",
  "inscription": {
    "id": "abc123...i0",
    "contentType": "text/plain",
    "output": "abc123...:0"
  },
  "recipient": "bc1p...",
  "fee": { "satoshis": 1200, "rateUsed": "8 sat/vB" },
  "change": { "satoshis": 5000 },
  "network": "mainnet"
}
```

### get-inscription

Fetch and parse inscription content from a Bitcoin reveal transaction.

```
bun run ordinals/ordinals.ts get-inscription --txid <txid>
```

Options:
- `--txid` (required) — Transaction ID of the reveal transaction (64 hex chars)

## Two-Step Inscription Workflow

```
# Step 1: Inscribe (broadcasts commit tx)
CONTENT_B64=$(echo -n "Hello, Bitcoin!" | base64)
bun run ordinals/ordinals.ts inscribe --content-type text/plain --content-base64 "$CONTENT_B64"

# Wait for commit to confirm

# Step 2: Reveal (broadcasts reveal tx, creates inscription)
bun run ordinals/ordinals.ts inscribe-reveal \
  --commit-txid <commitTxid> \
  --reveal-amount <revealAmount> \
  --content-type text/plain \
  --content-base64 "$CONTENT_B64"
```

## Notes

- `inscribe` and `inscribe-reveal` require a wallet unlocked via `bun run wallet/wallet.ts unlock`
- The wallet must have BTC balance on the SegWit (bc1q/tb1q) address for funding
- Inscriptions are received at the Taproot (bc1p/tb1p) address
- `transfer-inscription` requires `UNISAT_API_KEY` for inscription UTXO lookup
- Works on both mainnet and testnet (Unisat supports both)
