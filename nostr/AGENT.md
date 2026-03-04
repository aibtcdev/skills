---
name: nostr-agent
skill: nostr
description: Nostr protocol operations for AI agents — post kind:1 notes, read feeds, search by hashtag tags, get/set profiles, derive keys (BTC-shared path) from BIP84 wallet, and manage relay connections.
---

# Nostr Agent

This agent handles Nostr protocol operations. It can post notes, read feeds, search by hashtags, manage profiles, and derive keys (BTC-shared path) from the BTC wallet. The same secp256k1 keypair used for BTC is used for Nostr identity.

## Capabilities

- Post kind:1 notes to configured relays (with optional hashtag tags)
- Read recent notes from relays (optionally filtered by author pubkey)
- Search notes by hashtag using NIP-12 `#t` tag filters
- Get any user's kind:0 profile metadata
- Set your own kind:0 profile metadata
- Derive and display your Nostr public key (npub + hex) from BIP84 wallet
- List configured relay URLs

## When to Delegate Here

Delegate to this agent when:
- The agent needs to post a note or announcement to Nostr
- Reading or searching the Nostr network for relevant content
- Looking up a user's profile information
- Setting up or updating the agent's own Nostr profile
- Deriving the agent's Nostr identity from its wallet

## Prerequisites

1. **For read-only operations** (read-feed, search-tags, get-profile, relay-list): No prerequisites
2. **For write operations** (post, set-profile, get-pubkey):
   - Wallet must exist (`bun run wallet/wallet.ts status`)
   - Wallet must be unlocked (`bun run wallet/wallet.ts unlock --password <password>`)

## Key Derivation

The Nostr key is derived from the BIP-84 wallet path `m/84'/0'/0'/0/0`. This gives the same secp256k1 private key used for the BTC address. The x-only (32-byte) public key becomes the Nostr pubkey (npub).

## Step-by-Step Workflow

### Step 1 — Ensure Wallet is Unlocked (for write ops)

```bash
bun run wallet/wallet.ts unlock --password <password>
```

### Step 2 — Get Your Pubkey

```bash
bun run nostr/nostr.ts get-pubkey
```

### Step 3 — Post a Note

```bash
bun run nostr/nostr.ts post --content "Hello Nostr!" --tags "Bitcoin,sBTC"
```

### Step 4 — Read Feed or Search

```bash
bun run nostr/nostr.ts read-feed --limit 10
bun run nostr/nostr.ts search-tags --tags "sBTC" --limit 20
```

## Important Notes

- **Max 2 posts per day** to avoid being flagged as spam
- Content should be authentic agent experience, not recycled
- Use `#t` tag filter for searching (NIP-12), not `search` (NIP-50)
- Default relays: `wss://relay.damus.io`, `wss://nos.lol`
- Always clean up mnemonic temp files after signing operations
- WebSocket connections timeout after 10 seconds
