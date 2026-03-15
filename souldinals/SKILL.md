---
name: souldinals
description: "Souldinals collection management — inscribe soul.md as a child inscription under a genesis parent, list and load soul inscriptions from the wallet, and display parsed soul traits and metadata."
metadata:
  author: "strange-lux-agent"
  author-agent: "Strange Lux"
  user-invocable: "false"
  arguments: "inscribe-soul | reveal-soul | list-souls | load-soul | display-soul"
  entry: "souldinals/souldinals.ts"
  requires: "wallet, ordinals"
  tags: "l1, write, requires-funds"
---

# Souldinals Skill

Manages Souldinals — soul.md files inscribed as child ordinals under a genesis parent inscription. A soul inscription records an agent's identity, values, and traits as Markdown on Bitcoin L1.

All write operations (`inscribe-soul`, `reveal-soul`) require an unlocked wallet with BTC balance on the SegWit address.

## Usage

```
bun run souldinals/souldinals.ts <subcommand> [options]
```

## Subcommands

### inscribe-soul

Inscribe a soul.md file as a child inscription under a parent inscription — STEP 1: Broadcast commit transaction.

Reads the soul.md file, base64-encodes it, and broadcasts the commit transaction. After the commit confirms, call `reveal-soul` with the saved parameters to finalize the inscription.

```
bun run souldinals/souldinals.ts inscribe-soul \
  --parent-inscription-id <id> \
  [--soul-file ./SOUL.md] \
  [--fee-rate fast|medium|slow|<number>]
```

Options:
- `--parent-inscription-id` (required) — The genesis parent inscription ID (format: `{txid}i{index}`)
- `--soul-file` (optional) — Path to the soul.md file (default: `./SOUL.md`)
- `--fee-rate` (optional) — `fast`, `medium`, `slow`, or number in sat/vB (default: `medium`)

Requires: unlocked wallet with BTC balance.

Output:
```json
{
  "status": "commit_broadcast",
  "message": "Soul commit transaction broadcast. Wait for confirmation, then call reveal-soul.",
  "commitTxid": "abc123...",
  "commitExplorerUrl": "https://mempool.space/tx/abc123...",
  "revealAddress": "bc1p...",
  "revealAmount": 3200,
  "commitFee": 1640,
  "feeRate": 8,
  "parentInscriptionId": "def456...i0",
  "soulFile": "./SOUL.md",
  "contentType": "text/markdown",
  "contentSize": 1024,
  "contentBase64": "...",
  "nextStep": "After commit confirms, call: bun run souldinals/souldinals.ts reveal-soul ..."
}
```

### reveal-soul

Complete a soul inscription — STEP 2: Broadcast reveal transaction.

Call this AFTER the commit transaction from `inscribe-soul` has confirmed.

```
bun run souldinals/souldinals.ts reveal-soul \
  --commit-txid <txid> \
  --reveal-amount <satoshis> \
  --content-base64 <base64> \
  [--fee-rate fast|medium|slow|<number>]
```

Options:
- `--commit-txid` (required) — Transaction ID of the confirmed commit (64 hex chars)
- `--reveal-amount` (required) — Amount in the commit output in satoshis (from `inscribe-soul` response)
- `--content-base64` (required) — Base64-encoded soul.md content (from `inscribe-soul` response)
- `--fee-rate` (optional) — Fee rate for reveal tx (default: `medium`)

Requires: unlocked wallet.

Output:
```json
{
  "status": "success",
  "message": "Soul inscription created successfully!",
  "inscriptionId": "def456...i0",
  "contentType": "text/markdown",
  "contentSize": 1024,
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
  "note": "Soul inscription will appear at the recipient address once the reveal transaction confirms."
}
```

### list-souls

List all soul inscriptions (text/markdown) owned by the wallet's Taproot address.

Queries the Unisat Ordinals API and filters for `text/markdown` content type.

```
bun run souldinals/souldinals.ts list-souls
```

Requires: unlocked wallet (for Taproot address).

Output:
```json
{
  "address": "bc1p...",
  "count": 2,
  "souls": [
    {
      "id": "abc123...i0",
      "number": 78345,
      "contentType": "text/markdown",
      "contentLength": 1024,
      "timestamp": "2024-01-15T12:00:00.000Z",
      "genesisBlockHeight": 835000
    }
  ]
}
```

### load-soul

Load and display the full content of the oldest soul inscription from the wallet.

Finds the oldest text/markdown inscription and fetches its content via the Unisat Ordinals API.

```
bun run souldinals/souldinals.ts load-soul
```

Requires: unlocked wallet (for Taproot address).

Output:
```json
{
  "inscriptionId": "abc123...i0",
  "contentType": "text/markdown",
  "contentSize": 1024,
  "timestamp": "2024-01-15T12:00:00.000Z",
  "content": "# My Soul\n\n..."
}
```

### display-soul

Parse and display soul traits from a specific inscription by ID.

Fetches inscription content and parses Markdown sections to extract identity traits: name, description, values, focus areas, and custom sections.

```
bun run souldinals/souldinals.ts display-soul --inscription-id <id>
```

Options:
- `--inscription-id` (required) — Inscription ID (format: `{txid}i{index}`)

Output:
```json
{
  "inscriptionId": "abc123...i0",
  "contentType": "text/markdown",
  "traits": {
    "name": "...",
    "description": "...",
    "values": ["..."],
    "focusAreas": ["..."],
    "sections": {
      "Identity": "...",
      "Values": "..."
    }
  },
  "rawContent": "# Soul\n\n..."
}
```

## Two-Step Soul Inscription Workflow

```bash
# Step 1: Broadcast commit (soul.md defaults to ./SOUL.md)
bun run souldinals/souldinals.ts inscribe-soul \
  --parent-inscription-id <genesisInscriptionId>
# Save: commitTxid, revealAmount, contentBase64

# Wait for commit to confirm (check mempool.space)

# Step 2: Reveal (finalizes inscription)
bun run souldinals/souldinals.ts reveal-soul \
  --commit-txid <commitTxid> \
  --reveal-amount <revealAmount> \
  --content-base64 <contentBase64>
```

## Notes

- `inscribe-soul` and `reveal-soul` require a wallet unlocked via `bun run wallet/wallet.ts unlock`
- The wallet must have BTC balance on the SegWit (bc1q/tb1q) address for funding
- Soul inscriptions are received at the Taproot (bc1p/tb1p) address
- The `--parent-inscription-id` binds the soul as a child in the Souldinals collection
- `list-souls`, `load-soul`, and `display-soul` use the Unisat Ordinals API (set `UNISAT_API_KEY` env var for higher rate limits; free tier: 5 req/s)
