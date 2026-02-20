---
name: ordinals
description: Bitcoin ordinals operations — get the Taproot receive address, estimate inscription fees, create inscriptions via the two-step commit/reveal pattern, and fetch existing inscription content from reveal transactions.
user-invocable: false
arguments: get-taproot-address | estimate-fee | inscribe | inscribe-reveal | get-inscription
category: bitcoin-l1
requires: [wallet]
tags: [requires-wallet, has-read-ops, has-write-ops, requires-funds]
entry-point: ordinals.ts
---

# Ordinals Skill

Provides Bitcoin ordinals operations using the micro-ordinals library and mempool.space API. Creating inscriptions follows the two-step commit/reveal pattern — first `inscribe` broadcasts the commit transaction, then after it confirms, `inscribe-reveal` broadcasts the reveal transaction to finalize the inscription.

All write operations require an unlocked wallet with Taproot key support.

## Usage

```
bun run ordinals/ordinals.ts <subcommand> [options]
```

## Subcommands

### get-taproot-address

Get the wallet's Taproot (P2TR) address for receiving inscriptions. Requires an unlocked wallet.

Uses BIP86 derivation path: `m/86'/0'/0'/0/0` (mainnet) or `m/86'/1'/0'/0/0` (testnet).

```
bun run ordinals/ordinals.ts get-taproot-address
```

Output:
```json
{
  "address": "bc1p...",
  "network": "mainnet",
  "purpose": "receive_inscriptions",
  "derivationPath": "m/86'/0'/0'/0/0",
  "note": "Use this address to receive inscriptions created by the inscribe subcommand"
}
```

### estimate-fee

Calculate the total cost (in satoshis) for creating an inscription. Content must be provided as a base64-encoded string. Fee rate defaults to the current medium rate from mempool.space if not specified.

```
bun run ordinals/ordinals.ts estimate-fee --content-type <type> --content-base64 <base64> [--fee-rate <rate>]
```

Options:
- `--content-type` (required) — MIME type (e.g., `text/plain`, `image/png`)
- `--content-base64` (required) — Content as base64-encoded string
- `--fee-rate` (optional) — Fee rate in sat/vB (default: current medium fee from mempool.space)

Output:
```json
{
  "contentType": "text/plain",
  "contentSize": 42,
  "feeRate": 8,
  "fees": {
    "commitFee": 1640,
    "revealFee": 960,
    "revealAmount": 2506,
    "totalCost": 4146
  },
  "breakdown": "Commit tx: 1640 sats | Reveal amount: 2506 sats (includes 960 reveal fee) | Total: 4146 sats",
  "note": "This is an estimate. Actual fees may vary based on UTXO selection."
}
```

### inscribe

Create a Bitcoin inscription — STEP 1: Broadcast commit transaction.

Broadcasts the commit transaction and returns immediately without waiting for confirmation. After the commit transaction confirms (typically 10-60 minutes), use `inscribe-reveal` to finalize the inscription.

Save the `commitTxid`, `revealAmount`, and `feeRate` from the response — they are needed for the reveal step.

```
bun run ordinals/ordinals.ts inscribe --content-type <type> --content-base64 <base64> [--fee-rate fast|medium|slow|<number>]
```

Options:
- `--content-type` (required) — MIME type (e.g., `text/plain`, `image/png`, `text/html`)
- `--content-base64` (required) — Content as base64-encoded string
- `--fee-rate` (optional) — `fast`, `medium`, `slow`, or number in sat/vB (default: `medium`)

Requires: unlocked wallet with BTC balance.

Output:
```json
{
  "status": "commit_broadcast",
  "message": "Commit transaction broadcast successfully. Wait for confirmation...",
  "commitTxid": "abc123...",
  "commitExplorerUrl": "https://mempool.space/tx/abc123...",
  "revealAddress": "bc1p...",
  "revealAmount": 2506,
  "commitFee": 1640,
  "feeRate": 8,
  "contentType": "text/plain",
  "contentSize": 42,
  "nextStep": "After commit confirms, call: bun run ordinals/ordinals.ts inscribe-reveal ..."
}
```

### inscribe-reveal

Complete a Bitcoin inscription — STEP 2: Broadcast reveal transaction.

Call this AFTER the commit transaction from `inscribe` has confirmed (visible as confirmed on mempool.space). You must provide the same `contentType` and `contentBase64` used in the commit step, along with the `commitTxid` and `revealAmount` from the `inscribe` response.

The inscription ID is `{revealTxid}i0` (reveal transaction ID + `i0` suffix).

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
- `--reveal-amount` (required) — Amount in the commit output (satoshis, from inscribe response)
- `--content-type` (required) — MIME type (must match the commit step exactly)
- `--content-base64` (required) — Content (must match the commit step exactly)
- `--fee-rate` (optional) — Fee rate for reveal tx (default: `medium`)

Requires: unlocked wallet.

Output:
```json
{
  "status": "success",
  "message": "Inscription created successfully!",
  "inscriptionId": "def456...i0",
  "contentType": "text/plain",
  "contentSize": 42,
  "commit": {
    "txid": "abc123...",
    "explorerUrl": "https://mempool.space/tx/abc123..."
  },
  "reveal": {
    "txid": "def456...",
    "fee": 960,
    "explorerUrl": "https://mempool.space/tx/def456..."
  },
  "recipientAddress": "bc1p...",
  "note": "Inscription will appear at the recipient address once the reveal transaction confirms."
}
```

### get-inscription

Fetch and parse inscription content from a Bitcoin reveal transaction. Retrieves the transaction from mempool.space and parses inscription data from the witness data.

```
bun run ordinals/ordinals.ts get-inscription --txid <txid>
```

Options:
- `--txid` (required) — Transaction ID of the reveal transaction (64 hex chars)

Output (found):
```json
{
  "txid": "def456...",
  "network": "mainnet",
  "explorerUrl": "https://mempool.space/tx/def456...",
  "found": true,
  "count": 1,
  "inscriptions": [
    {
      "index": 0,
      "contentType": "text/plain",
      "size": 42,
      "bodyBase64": "SGVsbG8sIHdvcmxkIQ==",
      "bodyText": "Hello, world!",
      "cursed": false,
      "metadata": {
        "pointer": null,
        "metaprotocol": null,
        "contentEncoding": null,
        "rune": null,
        "note": null,
        "hasMetadata": false
      }
    }
  ]
}
```

Output (not found):
```json
{
  "txid": "abc123...",
  "network": "mainnet",
  "explorerUrl": "https://mempool.space/tx/abc123...",
  "found": false,
  "message": "No inscriptions found in this transaction"
}
```

## Two-Step Inscription Workflow

```
# Step 1: Encode content and inscribe (broadcasts commit tx)
CONTENT_B64=$(echo -n "Hello, Bitcoin!" | base64)
bun run ordinals/ordinals.ts inscribe --content-type text/plain --content-base64 "$CONTENT_B64"
# Save: commitTxid, revealAmount

# Wait for commit to confirm (check mempool.space explorer)

# Step 2: Reveal (broadcasts reveal tx, creates inscription)
bun run ordinals/ordinals.ts inscribe-reveal \
  --commit-txid <commitTxid> \
  --reveal-amount <revealAmount> \
  --content-type text/plain \
  --content-base64 "$CONTENT_B64"
```

## Notes

- `inscribe` and `inscribe-reveal` require a wallet unlocked via `bun run wallet/wallet.ts unlock`
- The wallet must have BTC balance on the SegWit (bc1q/tb1q) address for funding the commit transaction
- Inscriptions are received at the Taproot (bc1p/tb1p) address
- The content type, content, and fee rate must match exactly between commit and reveal steps to reconstruct the correct reveal script
