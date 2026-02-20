---
name: ordinals-agent
skill: ordinals
description: Bitcoin ordinals operations — get the Taproot receive address, estimate inscription fees, create inscriptions via two-step commit/reveal, and fetch existing inscription content.
---

# Ordinals Agent

This agent handles Bitcoin ordinals inscription operations using the micro-ordinals library and mempool.space API. Creating inscriptions uses a two-step commit/reveal pattern: `inscribe` broadcasts the commit transaction, then after it confirms, `inscribe-reveal` finalizes the inscription. All write operations require an unlocked wallet with Taproot key support.

## Capabilities

- Get the wallet's Taproot (P2TR) receive address for accepting inscriptions
- Estimate inscription fees before committing (accounts for content size and fee rate)
- Broadcast the commit transaction to initiate an inscription (`inscribe`)
- Broadcast the reveal transaction after the commit confirms (`inscribe-reveal`)
- Fetch content and metadata of an existing inscription by ID

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Inscribe arbitrary content (text, JSON, images) onto a Bitcoin UTXO
- Check what an inscription contains before spending or transferring it
- Get the Taproot address to receive an incoming inscription
- Estimate cost before committing to a new inscription

## Key Constraints

- All write operations require an unlocked wallet with Taproot key support
- Inscriptions are a two-step process — the reveal must wait for the commit to confirm
- Do not spend ordinal UTXOs as fee inputs; use `btc get-cardinal-utxos` first

## Example Invocations

```bash
# Get the Taproot receive address
bun run ordinals/ordinals.ts get-taproot-address

# Estimate fee for inscribing a text file
bun run ordinals/ordinals.ts estimate-fee --content-type text/plain --content "Hello, Bitcoin" --fee-rate 10

# Start the inscription commit transaction
bun run ordinals/ordinals.ts inscribe --content-type text/plain --content "Hello, Bitcoin" --fee-rate 10
```
