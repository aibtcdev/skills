---
name: ordinals-marketplace-agent
skill: ordinals-marketplace
description: Agent instructions for BTC ordinals marketplace operations via Magic Eden — browse listings, list inscriptions for sale, buy, and cancel listings using the PSBT-based flow.
---

# Ordinals Marketplace Agent

This agent handles BTC ordinals buying and selling on the Magic Eden marketplace (`api-mainnet.magiceden.dev/v2/ord/btc`). Operations use a PSBT-based flow: Magic Eden generates a transaction that the agent signs and then broadcasts. All operations are Bitcoin mainnet-only.

**BTC ordinals only.** This skill does not cover Solana or other chains.

## Prerequisites

- Wallet must be unlocked for all write operations — use `wallet_unlock` first
- Active wallet must have Taproot (P2TR) addresses for listing and cancellation; SegWit (P2WPKH) address for funding purchases
- BTC balance required: purchase price + miner fee for buys; miner fee only for cancellations
- `ordinals_get_listings` requires no wallet — it is a public read operation
- Operations will fail on testnet; only invoke on mainnet

## Decision Logic

| Goal | Tool |
|------|------|
| Browse active ordinals listings on Magic Eden | `ordinals_get_listings` — filter by collection, price range, or sort order |
| List an inscription for sale (step 1 of 2) | `ordinals_list_for_sale` — returns PSBT to sign |
| Finalize a listing after signing the PSBT (step 2 of 2) | `ordinals_list_for_sale_submit` — pass signed PSBT |
| Buy a listed inscription (get buyer PSBT) | `ordinals_buy` — returns PSBT to sign then broadcast |
| Cancel an active listing | `ordinals_cancel_listing` — returns cancellation PSBT to sign then broadcast |

## Safety Checks

- Verify inscription ownership before listing: use `get_ordinal_utxos` or `get_inscriptions_by_address` to confirm the inscription is in the wallet's Taproot address
- Check BTC balance before buying: use `get_btc_balance` and compare against listing price plus estimated fee
- Do not use ordinal UTXOs as fee inputs in unrelated transactions while a listing is active — the listing PSBT references that specific UTXO
- Confirm the listing is still active before buying: `ordinals_get_listings` with the collection or check `ordinals_buy` response for `status: "not_listed"`
- For the cancel flow, the signed PSBT must be broadcast promptly — stale PSBTs may be rejected

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Magic Eden ordinals marketplace is only available on mainnet." | Running on testnet | Switch to mainnet network config |
| "Wallet is not unlocked. Use wallet_unlock first." | Write operation without active session | Run `wallet_unlock` with password |
| "Taproot address not available. Unlock your wallet first." | Wallet session missing P2TR keys | Unlock a managed wallet (not env-var-based mnemonic) |
| "Bitcoin SegWit address not available. Unlock your wallet first." | SegWit keys missing | Same as above — unlock a managed wallet |
| "Magic Eden API 429: ..." | Rate limit exceeded | Wait and retry; set `MAGIC_EDEN_API_KEY` env var for higher limits |
| "Magic Eden API 400: ..." | Invalid inscription ID or missing listing | Verify inscription ID format (`txid...iN`) and that it is currently listed |
| "Inscription ... does not appear to be listed for sale" | Inscription not listed or delisted | Confirm listing via `ordinals_get_listings` with collection filter |
| "Magic Eden API 500: ..." | Magic Eden server error | Retry after a short wait |

## Output Handling

- `ordinals_get_listings`: `listings` array contains inscription details and `listedPrice` in satoshis; use `inscriptionId` for subsequent buy/cancel operations
- `ordinals_list_for_sale`: extract `psbtBase64` and pass to `psbt_sign`; also save `inscriptionId` for the submit step
- `ordinals_list_for_sale_submit`: `status: "listed"` confirms the listing is live on Magic Eden
- `ordinals_buy`: extract `psbtBase64` and pass to `psbt_sign`, then pass signed result to `psbt_broadcast`; `priceSats` confirms the final purchase price
- `ordinals_cancel_listing`: extract `psbtBase64`, sign with `psbt_sign`, broadcast with `psbt_broadcast`; after confirmation the inscription is delisted

## Example Invocations

```
# Browse recent listings for a collection
ordinals_get_listings({ collection: "nodemonkes", sortBy: "recentlyListed", limit: 20 })

# List an inscription for 500,000 sats (step 1)
ordinals_list_for_sale({ inscriptionId: "abc123...i0", priceSats: 500000 })
# → sign psbtBase64 with psbt_sign
# → submit signed PSBT (step 2)
ordinals_list_for_sale_submit({ inscriptionId: "abc123...i0", signedPsbt: "<signed-psbt-base64>" })

# Buy a listed inscription
ordinals_buy({ inscriptionId: "abc123...i0" })
# → sign psbtBase64 with psbt_sign
# → broadcast with psbt_broadcast

# Cancel an active listing
ordinals_cancel_listing({ inscriptionId: "abc123...i0" })
# → sign psbtBase64 with psbt_sign
# → broadcast with psbt_broadcast
```
