---
name: psbt
description: "PSBT (Partially Signed Bitcoin Transaction) construction and signing — build PSBTs for ordinals purchases, estimate fees, sign with the active wallet, and broadcast finalized PSBTs."
metadata:
  author: "tfibtcagent"
  author-agent: "Secret Dome"
  user-invocable: "false"
  arguments: "estimate-fee | sign | broadcast"
  entry: "psbt/psbt.ts"
  mcp-tools: "psbt_create_ordinal_buy, psbt_sign, psbt_broadcast, psbt_decode"
  requires: "wallet"
  tags: "l1, write, requires-funds"
---

# PSBT Skill

Provides PSBT (Partially Signed Bitcoin Transaction) construction and signing operations on the Bitcoin L1. PSBTs enable multi-party signing workflows such as ordinals marketplace purchases where both buyer and seller must sign before broadcast.

- **estimate-fee** — Read-only fee estimation for a PSBT given its structure.
- **sign** — Sign one or more PSBT inputs with the active unlocked wallet (P2WPKH or Taproot keys).
- **broadcast** — Finalize a fully signed PSBT and broadcast it to the Bitcoin network via mempool.space.

## Usage

```
bun run psbt/psbt.ts <subcommand> [options]
```

## Subcommands

### estimate-fee

Estimate the network fee in satoshis for a given PSBT. Parses the transaction structure and computes vsize-based fee estimate for fast, medium, and slow fee tiers.

```
bun run psbt/psbt.ts estimate-fee --psbt <base64>
```

Options:
- `--psbt <base64>` (required) — PSBT in base64 format

Output:
```json
{
  "network": "mainnet",
  "vsize": 253,
  "inputsLength": 2,
  "outputsLength": 3,
  "feeEstimates": {
    "fast": { "satPerVb": 12, "totalSats": 3036 },
    "medium": { "satPerVb": 6, "totalSats": 1518 },
    "slow": { "satPerVb": 2, "totalSats": 506 }
  },
  "currentFeeSats": "1200"
}
```

### sign

Sign PSBT inputs with the active wallet's BTC private keys (P2WPKH and/or Taproot). The wallet must be unlocked before calling this subcommand.

```
bun run psbt/psbt.ts sign --psbt <base64>
```

Options:
- `--psbt <base64>` (required) — PSBT in base64 format to sign
- `--inputs <indexes>` (optional) — Comma-separated input indexes to sign (signs all signable inputs if omitted)
- `--finalize` (optional) — Finalize signed inputs immediately (default: false)

Output:
```json
{
  "success": true,
  "network": "mainnet",
  "signedInputs": [1, 2],
  "finalizedInputs": [],
  "skippedInputs": [{ "index": 0, "reason": "no matching key for this input" }],
  "psbtBase64": "<updated-base64>"
}
```

### broadcast

Finalize a fully signed PSBT and broadcast it to the Bitcoin network via mempool.space.

```
bun run psbt/psbt.ts broadcast --psbt <base64>
```

Options:
- `--psbt <base64>` (required) — Fully signed PSBT in base64 format

Output:
```json
{
  "success": true,
  "network": "mainnet",
  "txid": "abc123...",
  "explorerUrl": "https://mempool.space/tx/abc123...",
  "txHex": "0200..."
}
```

## Notes

- Wallet must be unlocked with `bun run wallet/wallet.ts unlock` before calling `sign`.
- For ordinals purchase PSBTs (built by the MCP tool `psbt_create_ordinal_buy`): input index 0 is the seller's inscription UTXO; buyer inputs start at index 1. Sign only buyer inputs (index 1+) unless you are the seller.
- `broadcast` calls `tx.finalize()` — all inputs must be fully signed or it will throw.
- Fee estimates in `estimate-fee` are based on the PSBT's current vsize; they reflect the signed transaction size, not the unsigned size.
