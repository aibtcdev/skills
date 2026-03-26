---
name: ordinals-marketplace
description: "BTC ordinals marketplace operations via Magic Eden — browse active listings, list inscriptions for sale via PSBT flow, submit signed listings, buy inscriptions, and cancel active listings. BTC ordinals only (not Solana). Mainnet-only."
metadata:
  author: "whoabuddy"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "get-listings | list-for-sale | list-for-sale-submit | buy | cancel-listing"
  entry: "ordinals-marketplace/SKILL.md"
  mcp-tools: "ordinals_get_listings, ordinals_list_for_sale, ordinals_list_for_sale_submit, ordinals_buy, ordinals_cancel_listing"
  requires: "wallet"
  tags: "l1, write, mainnet-only, requires-funds"
---

# Ordinals Marketplace Skill

Browse and trade Bitcoin ordinals/inscriptions on the Magic Eden marketplace via the Magic Eden BTC ordinals API (`api-mainnet.magiceden.dev/v2/ord/btc`).

**Important:** This skill covers BTC ordinals only. Magic Eden operates separate marketplaces for different chains; this skill exclusively uses the Bitcoin ordinals API. All operations are mainnet-only — the API does not support testnet.

This is an MCP-tool skill. Agents invoke the underlying MCP tools directly rather than a standalone CLI script. Write operations use the Magic Eden PSBT-based listing flow: Magic Eden generates a PSBT which the seller or buyer signs and then broadcasts.

## Prerequisites

- Wallet must be unlocked for all write operations (`list-for-sale`, `buy`, `cancel-listing`)
- `get-listings` is public and requires no wallet
- Active wallet must have Taproot keys (P2TR address) — managed wallets satisfy this
- BTC balance required for purchasing and cancellations (miner fee for cancel; purchase price + fee for buy)
- Set `MAGIC_EDEN_API_KEY` environment variable for a dedicated authenticated rate limit (optional but recommended for high-volume use; without it, the unauthenticated shared limit applies: 30 QPM)

## Subcommands

### get-listings

Browse active BTC ordinals listings on Magic Eden. No wallet required.

MCP tool: `ordinals_get_listings`

Options:
- `collection` (optional) — Magic Eden collection symbol to filter by (e.g. `nodemonkes`, `bitcoin-puppets`)
- `minPriceSats` (optional) — Minimum listing price in satoshis
- `maxPriceSats` (optional) — Maximum listing price in satoshis
- `limit` (optional) — Number of results (default 20, max 100)
- `offset` (optional) — Pagination offset (default 0)
- `sortBy` (optional) — `priceAsc`, `priceDesc`, or `recentlyListed` (default)

Returns active listings with inscription details, seller address, and price in satoshis.

### list-for-sale

List a wallet inscription for sale on Magic Eden using the PSBT listing flow. Step 1 of 2.

MCP tool: `ordinals_list_for_sale`

Options:
- `inscriptionId` (required) — Inscription ID in txid+index format, e.g. `abc123...i0`
- `priceSats` (required) — Listing price in satoshis
- `receiverAddress` (optional) — BTC address to receive payment (defaults to wallet's Taproot address)

Returns a `psbtBase64` for signing. The inscription is not moved; the signed PSBT authorizes the sale to any buyer.

Next step: sign the returned PSBT using `psbt_sign`, then call `list-for-sale-submit`.

### list-for-sale-submit

Submit a signed listing PSBT to Magic Eden to publish the listing. Step 2 of 2.

MCP tool: `ordinals_list_for_sale_submit`

Options:
- `inscriptionId` (required) — The inscription ID being listed
- `signedPsbt` (required) — The signed PSBT in base64 format (from `psbt_sign`)

Returns `{ "status": "listed" }` on success.

### buy

Buy a listed BTC ordinal inscription from Magic Eden. Multi-step PSBT flow.

MCP tool: `ordinals_buy`

Options:
- `inscriptionId` (required) — Inscription ID to purchase, e.g. `abc123...i0`
- `buyerAddress` (optional) — BTC address to receive the inscription (defaults to wallet's Taproot address)
- `buyerPaymentAddress` (optional) — BTC address to fund the purchase (defaults to wallet's SegWit address)
- `feeRate` (optional) — Fee rate in sat/vB (uses `halfHourFee` network default if omitted)

Returns a `psbtBase64` combining the seller's listing and buyer's payment inputs.

Next step: sign the PSBT with `psbt_sign`, then broadcast with `psbt_broadcast`.

### cancel-listing

Cancel an active Magic Eden listing for an inscription you own.

MCP tool: `ordinals_cancel_listing`

Options:
- `inscriptionId` (required) — Inscription ID of the active listing to cancel, e.g. `abc123...i0`
- `sellerAddress` (optional) — BTC Taproot address that owns the listing (defaults to wallet's Taproot address)

Returns a `psbtBase64` for the cancellation transaction.

Next step: sign the PSBT with `psbt_sign`, then broadcast with `psbt_broadcast` to finalize the cancellation.

## Multi-Step Flows

### Listing Flow

```
1. ordinals_list_for_sale    (get listing PSBT)
2. psbt_sign                 (sign the psbtBase64)
3. ordinals_list_for_sale_submit  (publish listing)
```

### Buy Flow

```
1. ordinals_get_listings     (find inscription and price)
2. ordinals_buy              (get buyer PSBT)
3. psbt_sign                 (sign the psbtBase64)
4. psbt_broadcast            (broadcast to complete purchase)
```

### Cancel Flow

```
1. ordinals_cancel_listing   (get cancellation PSBT)
2. psbt_sign                 (sign the psbtBase64)
3. psbt_broadcast            (broadcast to cancel listing)
```

## Notes

- All write operations require mainnet — the API returns an error on testnet
- Magic Eden's BTC ordinals API (`api-mainnet.magiceden.dev/v2/ord/btc`) is the backend for all operations
- The inscription must be in the wallet's Taproot (P2TR / bc1p...) address for listing and cancellation
- Payment for purchases comes from the SegWit (P2WPKH / bc1q...) address
- If `MAGIC_EDEN_API_KEY` is not set, the shared unauthenticated rate limit (30 QPM) applies
