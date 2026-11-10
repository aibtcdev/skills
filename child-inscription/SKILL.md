---
name: child-inscription
description: "Parent-child Ordinals inscriptions — estimate fees, broadcast commit tx, and reveal child inscription establishing on-chain provenance per the Ordinals provenance spec."
metadata:
  author: "tfibtcagent"
  author-agent: "Secret Dome"
  user-invocable: "false"
  arguments: "estimate | inscribe | reveal"
  entry: "child-inscription/child-inscription.ts"
  mcp-tools: "estimate_child_inscription_fee, inscribe_child, inscribe_child_reveal"
  requires: "wallet"
  tags: "l1, write, requires-funds"
---

# Child Inscription Skill

Creates parent-child Ordinals inscriptions per the [Ordinals provenance spec](https://docs.ordinals.com/inscriptions/provenance.html). The inscription owner spends the parent UTXO in the reveal transaction, embedding a pointer that establishes on-chain provenance for the child.

- **estimate** — Read-only fee calculation, no wallet required.
- **inscribe** — Step 1 commit transaction, requires an unlocked wallet with BTC.
- **reveal** — Step 2 reveal transaction, requires the commit tx to be confirmed.

## Usage

```
bun run child-inscription/child-inscription.ts <subcommand> [options]
```

## Subcommands

### estimate

Calculate the total cost (commit fee + reveal amount) for a child inscription without broadcasting anything.

```
bun run child-inscription/child-inscription.ts estimate \
  --parent-id <inscription-id> \
  --content-type <mime> \
  --content <string>
```

Options:
- `--parent-id` (required) — Parent inscription ID, e.g. `abc123...i0`
- `--content-type` (required) — MIME type, e.g. `text/plain` or `image/png`
- `--content` (required) — Content as a UTF-8 string (base64-encoded internally)
- `--fee-rate` (optional) — Fee rate in sat/vB; defaults to current mempool medium fee

Output:
```json
{
  "parentId": "abc123...i0",
  "contentType": "text/plain",
  "contentSize": 42,
  "feeRate": 12,
  "fees": {
    "commitFee": 1440,
    "revealFee": 2100,
    "revealAmount": 3394,
    "totalCost": 4834
  },
  "breakdown": "Commit tx: 1440 sats | Reveal amount: 3394 sats (includes 2100 reveal fee) | Total: 4834 sats"
}
```

### inscribe

Broadcast the commit transaction (Step 1). The commit locks funds into a pay-to-taproot address encoding the inscription script. After this confirms, run `reveal`.

```
bun run child-inscription/child-inscription.ts inscribe \
  --parent-id <inscription-id> \
  --content-type <mime> \
  --content <string> \
  [--fee-rate <sats-per-vbyte>]
```

Options:
- `--parent-id` (required) — Parent inscription ID. Your wallet must own this inscription (verified on-chain).
- `--content-type` (required) — MIME type of the child content.
- `--content` (required) — Child content as a UTF-8 string.
- `--fee-rate` (optional) — Fee rate: `fast`, `medium`, `slow`, or an integer in sat/vB (default: `medium`).

Output:
```json
{
  "status": "commit_broadcast",
  "commitTxid": "deadbeef...",
  "commitExplorerUrl": "https://mempool.space/tx/deadbeef...",
  "revealAddress": "bc1p...",
  "revealAmount": 3394,
  "commitFee": 1440,
  "feeRate": 12,
  "parentInscriptionId": "abc123...i0",
  "contentType": "text/plain",
  "contentSize": 42,
  "nextStep": "After commit confirms, call reveal with commitTxid and revealAmount from this response."
}
```

### reveal

Broadcast the reveal transaction (Step 2). This spends the commit output and the parent UTXO simultaneously, creating the child inscription and returning the parent to your address.

**Wait for the commit tx to confirm before calling this.**

```
bun run child-inscription/child-inscription.ts reveal \
  --commit-txid <txid> \
  --vout <num>
```

Options:
- `--commit-txid` (required) — Txid of the confirmed commit transaction (from the `inscribe` step).
- `--vout` (required) — Output index of the commit transaction (almost always `0`).

Note: Content, content-type, parent-id, and reveal-amount are read from the `.child-inscription-state.json` file written by the `inscribe` subcommand.

Output:
```json
{
  "status": "success",
  "inscriptionId": "revealthash...i0",
  "parentInscriptionId": "abc123...i0",
  "contentType": "text/plain",
  "contentSize": 42,
  "commit": {
    "txid": "deadbeef...",
    "explorerUrl": "https://mempool.space/tx/deadbeef..."
  },
  "reveal": {
    "txid": "revealthash...",
    "fee": 2100,
    "explorerUrl": "https://mempool.space/tx/revealthash..."
  },
  "recipientAddress": "bc1p..."
}
```

## Notes

- Always run `estimate` first to understand total cost before committing funds.
- The `inscribe` subcommand writes a `.child-inscription-state.json` file in the current working directory. Do not delete it before running `reveal`.
- The parent inscription must remain at your Taproot address between the `inscribe` and `reveal` steps. Do not transfer the parent during this window.
- Content is encoded as UTF-8 and base64-encoded before being passed to the MCP tool. Binary content (images etc.) should be supplied pre-encoded.
- Wallet operations require an unlocked wallet (`bun run wallet/wallet.ts unlock` first).
- All operations target Bitcoin mainnet by default (controlled by the `NETWORK` environment variable).
