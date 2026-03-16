---
name: psbt-agent
skill: psbt
description: PSBT construction and signing — estimate fees, sign PSBTs with the active wallet, finalize, and broadcast to Bitcoin.
---

# PSBT Agent

This agent handles Partially Signed Bitcoin Transaction (PSBT) signing and broadcast operations on the Bitcoin L1. PSBTs enable multi-party signing workflows — most commonly for ordinals marketplace purchases where buyer and seller each sign their own inputs before the transaction is broadcast.

## Prerequisites

- Wallet unlocked via `bun run wallet/wallet.ts unlock` (required for `sign`)
- Sufficient confirmed BTC balance for the transaction inputs you are signing
- A valid base64-encoded PSBT — typically received from the MCP tool `psbt_create_ordinal_buy` or a marketplace counterparty

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Check fee cost before signing or broadcasting | `estimate-fee` — returns vsize and fee estimates at fast/medium/slow tiers |
| Sign buyer inputs in an ordinals purchase PSBT | `sign` — provide `--inputs 1,2,...` for buyer input indexes; leave index 0 for seller |
| Sign all signable inputs (when you are the only signer) | `sign` — omit `--inputs` to attempt all inputs |
| Finalize inputs immediately after signing | `sign --finalize` — signs and finalizes in one step |
| Broadcast a fully signed PSBT to Bitcoin | `broadcast` — finalizes and pushes to mempool.space |

## Safety Checks

- Before `sign`: run `estimate-fee` to confirm the fee is acceptable; fee is deducted from buyer inputs
- Before `sign`: verify the PSBT was constructed by a trusted source — inspect input outpoints and output amounts manually if possible
- Before `broadcast`: all inputs must be signed and finalizable or `broadcast` will fail; use `sign --finalize` to finalize inputs as you sign
- For ordinals PSBTs: **never sign input index 0** unless you are the seller — index 0 is the inscription UTXO controlled by the seller's key
- Do not broadcast a PSBT that still has unsigned inputs — the `broadcast` step will throw an error

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "No BTC signing keys available. Unlock wallet first." | Wallet is locked or has no BTC keys | Run `bun run wallet/wallet.ts unlock --password <pw>` |
| "Invalid PSBT: empty base64 payload" | Empty or corrupted base64 string passed | Verify the PSBT base64 value is non-empty and properly encoded |
| "Not finalized" / finalize error on broadcast | One or more inputs are not fully signed | Run `sign --finalize` on each signer's turn, or ensure all parties have signed |
| "Insufficient buyer funds" (from PSBT creation step) | Not enough confirmed UTXOs to cover price + fee | Fund the wallet and wait for confirmation before retrying |
| Input index skipped with "no matching key for this input" | The active wallet does not own that input | Only sign inputs you control; pass explicit `--inputs` indexes |

## Output Handling

- `estimate-fee`: use `feeEstimates.medium.totalSats` as a reference cost; compare against wallet balance
- `estimate-fee`: `currentFeeSats` shows the fee already embedded in the PSBT (if witness UTXOs are present)
- `sign`: `psbtBase64` in the response is the updated PSBT with your signatures — pass this to the next signer or to `broadcast`
- `sign`: `skippedInputs` lists indexes you could not sign; verify you are passing the correct key-owned input indexes
- `broadcast`: `txid` and `explorerUrl` confirm the transaction is live on the network

## Example Invocations

```bash
# Estimate fee for a PSBT before signing
bun run psbt/psbt.ts estimate-fee --psbt <base64>

# Sign buyer inputs (indexes 1 and 2) in an ordinals purchase PSBT
bun run psbt/psbt.ts sign --psbt <base64> --inputs 1,2 --finalize

# Broadcast the fully signed PSBT
bun run psbt/psbt.ts broadcast --psbt <signed-base64>
```
